import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {catalogFrom,compare,versionOf,sourceUrl,proxyEnv,execute,stateRoot,configFile} from './update-core.mjs';
const service='dockhand-native-upgrade.service';
function trusted(file){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error('更新服务配置权限不正确');return JSON.parse(fs.readFileSync(file,'utf8'));}
const config=process.getuid?.()===0?trusted(configFile):null;
if(!config)throw Error('更新服务需要管理员权限');sourceUrl(config.source);
const settings=()=>JSON.parse(fs.readFileSync(config.runtimeConfig,'utf8'));
function save(job){const dir=stateRoot+'/jobs/'+job.id;fs.mkdirSync(dir,{recursive:true,mode:0o750});fs.chownSync(dir,0,config.gid);const dest=dir+'/status.json',temp=dest+'.tmp';fs.writeFileSync(temp,JSON.stringify(job),{mode:0o640});fs.chownSync(temp,0,config.gid);fs.renameSync(temp,dest);}
async function request(){
 const lock=stateRoot+'/request.lock';fs.mkdirSync(lock,{mode:0o700});try{
  const active=await execute('/bin/systemctl',['is-active',service]).then(r=>r.stdout.trim(),e=>String(e.stdout||'').trim());
  if(['active','activating'].includes(active)){process.stdout.write(fs.readFileSync(stateRoot+'/current','utf8').trim());return;}
  const job={id:'native-'+randomUUID(),status:'running',logs:'原生更新任务已登记\n',createdAt:new Date().toISOString()};save(job);fs.writeFileSync(stateRoot+'/current',job.id,{mode:0o600});
  await execute('/bin/systemctl',['reset-failed',service]).catch(()=>{});try{await execute('/bin/systemctl',['start','--no-block',service]);}catch{job.status='exited';job.exitCode=1;job.logs+='独立更新服务无法启动\n';save(job);throw Error('独立更新服务无法启动');}process.stdout.write(job.id);
 }finally{fs.rmdirSync(lock);}
}
async function pgBackup(env,destination){
 const db=new URL(env.DATABASE_URL);if(!['postgres:','postgresql:'].includes(db.protocol))throw Error('只支持现有 PostgreSQL 数据库备份');
 const fd=fs.openSync(destination,'wx',0o600),cmd=['exec','-e','PGPASSWORD',config.postgresContainer,'pg_dump','--format=custom','--host=127.0.0.1','--port='+config.postgresPort,'--username='+decodeURIComponent(db.username),'--dbname='+decodeURIComponent(db.pathname.slice(1))];
 let child;try{child=spawn('/usr/local/bin/docker',cmd,{env:{...process.env,PGPASSWORD:decodeURIComponent(db.password)},stdio:['ignore',fd,'ignore']});const timer=setTimeout(()=>child.kill('SIGTERM'),120000);try{const [code]=await once(child,'exit');if(code!==0)throw Error('PostgreSQL 备份失败');}finally{clearTimeout(timer);}}finally{fs.closeSync(fd);}
 const fdRead=fs.openSync(destination,'r');try{const verify=spawn('/usr/local/bin/docker',['exec','-i',config.postgresContainer,'pg_restore','--list'],{stdio:[fdRead,'ignore','ignore']});const [code]=await once(verify,'exit');if(code!==0)throw Error('PostgreSQL 备份校验失败');}finally{fs.closeSync(fdRead);}
}
async function run(){const id=fs.readFileSync(stateRoot+'/current','utf8').trim();if(!/^native-[0-9a-f-]{36}$/.test(id))throw Error('无效更新任务');const dir=stateRoot+'/jobs/'+id,job=JSON.parse(fs.readFileSync(dir+'/status.json','utf8'));const log=text=>{job.logs=(job.logs+text+'\n').slice(-50000);save(job);};let installStarted=false;
 try{
  const env=settings(),before=versionOf(fs.readFileSync('/var/packages/DockhandNative/INFO','utf8')),pkg=await catalogFrom(config.source,env);job.version=pkg.version;save(job);if(compare(pkg.version,before)<=0)throw Error('套件源没有更新版本');
  log('Stopping container — 下载并校验原生套件 '+pkg.version);const stage=dir+'/package.spk';await execute('/bin/curl',['--silent','--show-error','--location','--fail','--proto','=https','--proto-redir','=https','--connect-timeout','15','--max-time','600','--retry','2','--retry-delay','3','--output',stage,pkg.url],{env:proxyEnv(env),timeout:650000,maxBuffer:4096});
  if(fs.statSync(stage).size!==pkg.size)throw Error('套件大小校验失败');const hash=createHash('sha256');for await(const chunk of fs.createReadStream(stage))hash.update(chunk);if(hash.digest('hex')!==pkg.sha256)throw Error('套件 SHA256 校验失败');
  const info=(await execute('/bin/tar',['-xOf',stage,'INFO'],{timeout:10000,maxBuffer:65536})).stdout;if(!/^package="DockhandNative"\s*$/m.test(info)||versionOf(info)!==pkg.version)throw Error('安装包名称或版本不匹配');log('Container stopped — 套件校验完成');
  log('Removing old container — 备份 PostgreSQL、运行配置和密钥');const backup=stateRoot+'/backups/'+id;fs.mkdirSync(backup,{recursive:true,mode:0o700});await pgBackup(env,backup+'/postgres.dump');
  for(const [from,name] of [[config.runtimeConfig,'runtime-env.json'],[config.dataDir+'/.encryption_key','encryption-key'],['/var/packages/DockhandNative/INFO','INFO']]){if(fs.lstatSync(from).isSymbolicLink()||!fs.statSync(from).isFile())throw Error('备份目标必须为普通文件');fs.copyFileSync(from,backup+'/'+name);fs.chmodSync(backup+'/'+name,0o600);}log('Old container removed — 备份及校验完成');
  log('Renaming container — 安装 DockhandNative '+pkg.version);installStarted=true;await execute('/usr/syno/bin/synopkg',['install',stage],{timeout:360000,maxBuffer:200000});if(versionOf(fs.readFileSync('/var/packages/DockhandNative/INFO','utf8'))!==pkg.version)throw Error('安装后套件版本未更新');log('Container renamed — 套件安装完成');
  log('Connecting to network — 恢复原生 Dockhand 服务');await execute('/usr/syno/bin/synopkg',['start','DockhandNative'],{timeout:60000,maxBuffer:20000});log('Networks connected — 原生服务已恢复');
  log('Starting container — 检查新版本和数据库连接');const port=Number(settings().PORT);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('无效访问端口');let healthy=false;
  for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(2000)});if(r.ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,2000));}
  if(!healthy)throw Error('新版本健康检查未通过');log('Container is running — 新版本 '+pkg.version+' 验证通过');job.status='exited';job.exitCode=0;save(job);fs.unlinkSync(stage);
 }catch(e){if(installStarted)await execute('/usr/syno/bin/synopkg',['start','DockhandNative'],{timeout:60000,maxBuffer:20000}).catch(()=>{});job.status='exited';job.exitCode=1;log('原生更新失败：'+(e.message?.startsWith('Command failed:')?'套件下载或安装命令执行失败，请检查套件中心状态':String(e.message).slice(0,160)));save(job);process.exitCode=1;}
}
if(process.argv[2]==='request')request().catch(()=>{console.error('更新服务正忙或尚未正确初始化');process.exitCode=1;});else if(process.argv[2]==='run')run().catch(()=>{console.error('无法载入原生更新任务');process.exitCode=1;});else throw Error('Unsupported updater operation');