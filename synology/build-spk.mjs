import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url)),args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2)options[args[i].replace(/^--/,'')]=args[i+1];
for(const key of ['app','node','compose','out','build'])if(!options[key])throw Error('Missing --'+key);
if(!/^[0-9]+$/.test(options.build))throw Error('Build must be numeric');
const version=JSON.parse(fs.readFileSync(path.join(options.app,'package.json'),'utf8')).version+'-'+options.build;
const lock=JSON.parse(fs.readFileSync(path.join(here,'compose-version.json'),'utf8'));
function hash(file,algorithm){return createHash(algorithm).update(fs.readFileSync(file)).digest('hex');}
if(hash(options.compose,'sha256')!==lock.sha256)throw Error('Compose binary checksum mismatch');
const staging=fs.mkdtempSync(path.join(os.tmpdir(),'dockhand-spk-')),payload=path.join(staging,'payload'),outer=path.join(staging,'outer');
fs.mkdirSync(payload);fs.mkdirSync(outer);
try{
 const app=path.join(payload,'app');fs.mkdirSync(app);
 for(const name of ['node_modules','build','bin','drizzle','drizzle-pg','server.js','package.json','LICENSE.txt','PRIVACY.txt','scripts']){
  const source=path.join(options.app,name);if(fs.existsSync(source))fs.cpSync(source,path.join(app,name),{recursive:true,verbatimSymlinks:true});
 }
 fs.cpSync(path.join(here,'package','runtime'),path.join(payload,'runtime'),{recursive:true,verbatimSymlinks:true});
 fs.mkdirSync(path.join(payload,'runtime','bin'),{recursive:true});
 fs.copyFileSync(options.node,path.join(payload,'runtime','node'));
 fs.copyFileSync(options.compose,path.join(payload,'runtime','bin','docker-compose'));
 for(const name of ['node','bin/docker-compose','bootstrap.sh'])fs.chmodSync(path.join(payload,'runtime',name),0o755);
 const icon=path.join(app,'build','client','android-chrome-512x512.png');
 fs.copyFileSync(icon,path.join(outer,'PACKAGE_ICON.PNG'));fs.copyFileSync(icon,path.join(outer,'PACKAGE_ICON_256.PNG'));
 const ui=path.join(payload,'ui');fs.cpSync(path.join(here,'package','ui'),ui,{recursive:true});fs.mkdirSync(path.join(ui,'images'),{recursive:true});
 for(const size of [16,24,32,48,64,72,128,256])fs.copyFileSync(icon,path.join(ui,'images','dockhand-v2_'+size+'.png'));
 const entry=(title,url)=>({type:'url',allUsers:false,title,desc:title,icon:'images/dockhand-v2_{0}.png',url});
 fs.writeFileSync(path.join(ui,'config'),JSON.stringify({'.url':{'SYNO.SDS.DockhandNative.Application':entry('Dockhand','3rdparty/DockhandNative/open.html'),'SYNO.SDS.DockhandNative.Settings':entry('Dockhand 原生设置','3rdparty/DockhandNative/open.html?settings=1')}},null,2));
 fs.cpSync(path.join(here,'package','conf'),path.join(outer,'conf'),{recursive:true});
 fs.cpSync(path.join(here,'package','scripts'),path.join(outer,'scripts'),{recursive:true});
 for(const file of fs.readdirSync(path.join(outer,'scripts')))fs.chmodSync(path.join(outer,'scripts',file),0o755);
 function normalize(directory){
  fs.chmodSync(directory,0o755);
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
   const p=path.join(directory,entry.name);
   if(entry.isDirectory())normalize(p);
   else if(entry.isFile())fs.chmodSync(p,(fs.statSync(p).mode&0o111)?0o755:0o644);
  }
 }
 normalize(payload);
 function tar(args){const r=spawnSync('tar',args,{stdio:'inherit'});if(r.status!==0)throw Error('tar failed');}
 tar(['-czf',path.join(outer,'package.tgz'),'-C',payload,'.']);
 const info={package:'DockhandNative',version,displayname:'Dockhand Native',description:'Native Dockhand for Synology with registry mirrors, progress and database settings.',arch:'x86_64 broadwellnkv2',os_min_ver:'7.4-0',maintainer:'318182456',maintainer_url:'https://github.com/318182456/dockhand',distributor:'318182456',distributor_url:'https://github.com/318182456/dockhand',install_dep_packages:'ContainerManager',startable:'yes',thirdparty:'yes',dsmuidir:'ui',dsmappname:'SYNO.SDS.DockhandNative.Application',checksum:hash(path.join(outer,'package.tgz'),'md5')};
 fs.writeFileSync(path.join(outer,'INFO'),Object.entries(info).map(([k,v])=>k+'="'+v+'"').join('\n')+'\n');
 fs.mkdirSync(options.out,{recursive:true});
 const filename='DockhandNative-x86_64-'+version+'.spk',output=path.join(options.out,filename);
 tar(['-cf',output,'-C',outer,...fs.readdirSync(outer)]);
 const manifest={packages:[{package:'DockhandNative',version,tag:'synology-v'+version,filename,arch:['x86_64','broadwellnkv2'],os_min_ver:'7.4-0',dname:'Dockhand Native',description:'Dockhand 原生套件，包含镜像代理、拉取进度和独立设置页。',size:fs.statSync(output).size,md5:hash(output,'md5'),sha256:hash(output,'sha256'),beta:false}]};
 fs.writeFileSync(path.join(options.out,'synology-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({file:output,version,size:manifest.packages[0].size,sha256:manifest.packages[0].sha256}));
}finally{fs.rmSync(staging,{recursive:true,force:true});}
