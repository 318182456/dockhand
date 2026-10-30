// One-time root installation of the bounded DockhandNative update operation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {sourceUrl} from './update-core.mjs';
if(process.getuid?.()!==0)throw Error('Run as administrator/root');
const args=process.argv.slice(2),account=args[0],source=sourceUrl(args[1]);if(!/^[a-zA-Z0-9_.-]+$/.test(account||''))throw Error('Use the NAS maintenance account');
const gid=Number(execFileSync('/bin/id',['-g',account],{encoding:'utf8'}).trim());if(!Number.isSafeInteger(gid))throw Error('Cannot resolve account');
const control='/usr/local/libexec/dockhand-native-control',existing=fs.readFileSync(control,'utf8');if(!existing.includes('Managed by DockhandNative'))throw Error('Unexpected root controller');
const root='/usr/local/libexec/dockhand-native-updater',state='/var/lib/dockhand-native-updater';
for(const dir of [root,state,state+'/jobs',state+'/backups']){if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('Unexpected integration symlink');fs.mkdirSync(dir,{recursive:true,mode:0o750});fs.chownSync(dir,0,dir.endsWith('/backups')?0:gid);fs.chmodSync(dir,dir.endsWith('/backups')?0o700:0o750);}
const here=path.dirname(fileURLToPath(import.meta.url));for(const [src,dst] of [['update-core.mjs','update-core.mjs'],['upgrade-worker.mjs','upgrade-worker.mjs']]){fs.copyFileSync(path.join(here,src),root+'/'+dst);fs.chownSync(root+'/'+dst,0,0);fs.chmodSync(root+'/'+dst,0o644);}
function write(file,text,mode){if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('Unexpected integration symlink');fs.writeFileSync(file,text,{mode});fs.chownSync(file,0,0);fs.chmodSync(file,mode);}
write('/etc/dockhand-native-updater.json',JSON.stringify({source,gid,runtimeConfig:'/volume1/docker/dockhand/native/runtime-env.json',dataDir:'/volume1/docker/dockhand/data',postgresContainer:'postgresql',postgresPort:5432})+'\n',0o644);
write('/etc/systemd/system/dockhand-native-upgrade.service','# Managed by DockhandNative updater\n[Unit]\nDescription=Upgrade only DockhandNative from its trusted package source\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/node '+root+'/upgrade-worker.mjs run\nUser=0\nGroup=0\nUMask=0077\nTimeoutStartSec=20min\nKillMode=control-group\n',0o644);
let next=existing;if(!next.includes(' update)')){if(!/^ stop\)/m.test(next))throw Error('Controller marker not found');next=next.replace(/^ stop\)/m,' update) exec /usr/local/bin/node /usr/local/libexec/dockhand-native-updater/upgrade-worker.mjs request ;;\n stop)');}write(control,next,0o755);
const rule='# Managed by DockhandNative updater\n'+account+' ALL=(root) NOPASSWD: /usr/local/libexec/dockhand-native-control update\n',sudoers='/etc/sudoers.d/dockhand-native-update';write(sudoers,rule,0o440);try{const permissions=execFileSync('/bin/sudo',['-n','-l','-U',account],{encoding:'utf8',stdio:['ignore','pipe','pipe']});if(!permissions.includes('/usr/local/libexec/dockhand-native-control update'))throw Error('Missing bounded permission');}catch{fs.unlinkSync(sudoers);throw Error('Sudoers validation failed');}
execFileSync('/bin/systemctl',['daemon-reload']);console.log('Bounded native update operation installed. No boot updater enabled.');