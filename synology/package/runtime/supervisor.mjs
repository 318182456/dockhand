import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import {createGateway} from './settings.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),configPath=process.env.DOCKHAND_NATIVE_CONFIG||'/volume1/docker/dockhand/native/runtime-env.json';
let settings={DATA_DIR:'/volume1/docker/dockhand/data',HOME:'/volume1/docker/dockhand/native/home',HOST:'0.0.0.0',PORT:'0',TZ:'Asia/Shanghai'};
try{settings={...settings,...JSON.parse(fs.readFileSync(configPath,'utf8'))};}catch{}
const require=createRequire(path.join(root,'app','package.json')),backendPort=Number(settings.NATIVE_BACKEND_PORT||13009);
let child,stopping=false,failures=[],missed=0,started=0,killTimer,restartTimer,requestedRestart=false,state='stopped';
function launch(){
 if(stopping||(child&&child.exitCode===null))return;
 if(!fs.existsSync(configPath)||!settings.DATABASE_URL){state='paused';return;}
 started=Date.now();missed=0;state='starting';
 fs.mkdirSync(settings.HOME,{recursive:true,mode:0o700});
 const plugins=path.join(settings.HOME,'.docker','cli-plugins');fs.mkdirSync(plugins,{recursive:true,mode:0o700});
 const link=path.join(plugins,'docker-compose');if(!fs.existsSync(link))fs.symlinkSync(path.join(root,'runtime','bin','docker-compose'),link);
 const env={...process.env,...settings,NODE_ENV:'production',DOCKHAND_RUNTIME:'native',HOST:'127.0.0.1',PORT:String(backendPort)};
 env.PATH=path.join(root,'runtime','bin')+':/var/packages/ContainerManager/target/usr/bin:/usr/local/bin:/usr/bin:/bin';
 child=spawn(path.join(root,'runtime','node'),[path.join(root,'app','server.js')],{cwd:path.join(root,'app'),env,stdio:'inherit'});
 child.on('error',()=>{state='paused';console.error('Native Dockhand could not start');});
 child.on('exit',()=>{
  clearTimeout(killTimer);if(stopping){process.exit(0);return;}
  if(requestedRestart){requestedRestart=false;launch();return;}
  const now=Date.now();failures=failures.filter(t=>now-t<3600000);failures.push(now);
  if(failures.length>6){state='paused';console.error('Application restart limit reached; native settings remain available');return;}
  state='starting';restartTimer=setTimeout(launch,Math.min(30000,failures.length*3000));
 });
}
function stopChild(){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');clearTimeout(killTimer);killTimer=setTimeout(()=>child?.kill('SIGKILL'),10000);
}
function restartChild(){clearTimeout(restartTimer);failures=[];missed=0;if(child&&child.exitCode===null){requestedRestart=true;stopChild();}else launch();}
function health(){
 if(stopping||!child||child.exitCode!==null)return;
 const req=http.get({host:'127.0.0.1',port:backendPort,path:'/login?local=1',timeout:10000},res=>{
  res.resume();if(res.statusCode>=200&&res.statusCode<400){missed=0;state='running';}else if(Date.now()-started>60000&&++missed>=3)stopChild();
 });
 req.on('timeout',()=>req.destroy(Error('timeout')));
 req.on('error',()=>{if(Date.now()-started>60000&&++missed>=3)stopChild()});
}
async function testConnection(next){
 if(Number(next.PORT)===backendPort)throw Error('访问端口不能与内部服务端口相同');
 const directory=path.resolve(next.DATA_DIR);
 if(!/^\/volume[0-9]+\//.test(directory))throw Error('请选择数据卷中的目录');
 fs.accessSync(directory,fs.constants.R_OK|fs.constants.W_OK);
 if(!next.DATABASE_URL)throw Error('请配置 PostgreSQL 数据库');
 const {default:postgres}=await import(pathToFileURL(require.resolve('postgres')));
 const sql=postgres(next.DATABASE_URL,{max:1,connect_timeout:8,idle_timeout:1});
 try{await sql.unsafe('select 1 as ok');}finally{await sql.end({timeout:2});}
}
let gateway,compatGateway;
function accessUrl(next){
 if(!next.DOCKHAND_NATIVE_PUBLIC_URL||next.DOCKHAND_NATIVE_URL_TRACK_PORT){
  const interfaces=Object.entries(os.networkInterfaces()).filter(([name])=>!/^(docker|veth|br-|virbr|lo|tun)/.test(name));
  const ip=interfaces.flatMap(([,items])=>items||[]).find(x=>!x.internal&&x.family==='IPv4')?.address||'127.0.0.1';
  const host=next.HOST&&next.HOST!=='0.0.0.0'?next.HOST:ip;
  next.DOCKHAND_NATIVE_PUBLIC_URL='http://'+host+':'+next.PORT+'/';next.DOCKHAND_NATIVE_URL_TRACK_PORT=true;
 }
 return next;
}
function endpointReady(){
 settings.PORT=String(gateway.address().port);
 saveSettings(accessUrl({...settings}),false);
 console.log('Dockhand native gateway ready');
}
function saveSettings(next,backup=true){
 accessUrl(next);
 const parent=path.dirname(configPath);fs.mkdirSync(parent,{recursive:true,mode:0o700});
 if(backup&&fs.existsSync(configPath))fs.copyFileSync(configPath,configPath+'.previous');
 fs.writeFileSync(configPath+'.new',JSON.stringify(next,null,2)+'\n',{mode:0o600});
 fs.renameSync(configPath+'.new',configPath);
 try{require(path.join(root,'runtime','update-links.cjs')).syncDesktopLinks(next);}catch{console.error('Native desktop links need synchronization');}if(fs.existsSync(configPath+'.previous'))fs.chmodSync(configPath+'.previous',0o600);
 const oldPort=settings.PORT,oldHost=settings.HOST;settings=next;
 if(oldPort!==next.PORT||oldHost!==next.HOST)setTimeout(()=>{gateway.closeAllConnections();gateway.close(()=>gateway.listen(Number(settings.PORT),settings.HOST||'0.0.0.0',endpointReady));},500);
}
const gatewayOptions={getSettings:()=>settings,saveSettings,restartChild,backendPort,getState:()=>state,testConnection};
gateway=createGateway(gatewayOptions);
if(settings.DOCKHAND_NATIVE_COMPAT_PORT){compatGateway=createGateway(gatewayOptions);compatGateway.listen(Number(settings.DOCKHAND_NATIVE_COMPAT_PORT),"127.0.0.1");}
gateway.listen(Number(settings.PORT),settings.HOST||'0.0.0.0',endpointReady);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;clearTimeout(restartTimer);gateway.close();compatGateway?.close();stopChild();setTimeout(()=>process.exit(0),12000)});
setInterval(health,15000).unref();setTimeout(health,2000).unref();
launch();
