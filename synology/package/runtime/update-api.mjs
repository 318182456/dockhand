import fs from 'node:fs';
import {catalogFrom,compare,versionOf,readJob,configFile,execute} from './update-core.mjs';
export function createUpdater({getSettings,configPath=configFile,infoPath='/var/packages/DockhandNative/INFO',catalog=catalogFrom,launch,read=readJob}={}){
 async function check(){const config=JSON.parse(fs.readFileSync(configPath,'utf8')),currentVersion=versionOf(fs.readFileSync(infoPath,'utf8')),p=await catalog(config.source,getSettings());return {runtime:'native',updateAvailable:compare(p.version,currentVersion)>0,currentVersion,latestVersion:p.version,currentImage:'Dockhand '+currentVersion,newImage:'Dockhand '+p.version,containerName:'Dockhand 套件',isComposeManaged:false,versionOnly:false};}
 async function start(input,emit){const c=await check();if(!c.updateAvailable)throw Error('当前已经是最新原生套件');if(input.newImage!==c.newImage)throw Error('可用版本已变化，请重新检查更新');
  for(const step of ['pulling_image','building_config','pulling_updater','creating_container']){emit('step',{step,status:'active'});emit('log',{message:'原生套件更新准备：'+step});emit('step',{step,status:'completed'});}
  emit('step',{step:'launching_updater',status:'active'});
  const id=launch?await launch():String((await execute('/bin/sudo',['-n','/usr/local/libexec/dockhand-native-control','update'],{timeout:12000,maxBuffer:4096})).stdout).trim();if(!/^native-[0-9a-f-]{36}$/.test(id))throw Error('无法启动独立更新任务');emit('step',{step:'launching_updater',status:'completed'});emit('launched',{updaterId:id});
 }
 return {check,start,progress:id=>read(id)};
}