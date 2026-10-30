const fs=require('node:fs');
function syncDesktopLinks(env){
 if(!env.DOCKHAND_NATIVE_PUBLIC_URL)return;
 const pkg='/var/packages/DockhandNative',url=new URL(env.DOCKHAND_NATIVE_PUBLIC_URL);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid application URL');
 const target=fs.realpathSync(pkg+'/target'),ui=fs.realpathSync(target+'/ui');
 if(!ui.startsWith(target+'/'))throw Error('Unexpected UI directory');
 const configPath=ui+'/config';
 if(fs.lstatSync(configPath).isSymbolicLink()||fs.lstatSync(pkg+'/INFO').isSymbolicLink())throw Error('Unexpected metadata symlink');
 const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 for(const[id,endpoint]of [['SYNO.SDS.DockhandNative.Application',url.href],['SYNO.SDS.DockhandNative.Settings',new URL('/_native/settings',url).href]]){
  const entry=config['.url']?.[id];if(!entry)throw Error('Missing native desktop entry');
  entry.type='url';entry.url=endpoint;entry.icon='images/dockhand-v2_{0}.png';delete entry.port;delete entry.protocol;
 }
 fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
 const infoPath=pkg+'/INFO';let info=fs.readFileSync(infoPath,'utf8'),line='adminurl='+JSON.stringify(url.href);
 info=info.replace(/^adminport=.*\n?/gm,'').replace(/^adminprotocol=.*\n?/gm,'').replace(/^adminurl=.*\n?/gm,'');

 fs.writeFileSync(infoPath,info);publishTraefik(env);
}
module.exports={syncDesktopLinks};

function publishTraefik(env){
 const file=env.DOCKHAND_NATIVE_TRAEFIK_FILE;
 if(!env.DOCKHAND_NATIVE_TRAEFIK_ENABLED||!file||!env.DOCKHAND_NATIVE_PUBLIC_URL)return;
 const path=require('node:path'),yaml=require('/var/packages/DockhandNative/target/app/node_modules/js-yaml');
 const hostname=new URL(env.DOCKHAND_NATIVE_PUBLIC_URL).hostname,hosts=new Set([hostname]);
 if(env.DOCKHAND_NATIVE_GLOBAL_ENV_FILE){
  try{
   const shared=require('node:util').parseEnv(fs.readFileSync(env.DOCKHAND_NATIVE_GLOBAL_ENV_FILE,'utf8'));
   const domains=(shared.TRAEFIK_DOMAINS||shared.TRAEFIK_DOMAIN||'').split(/[,;\s]+/).filter(Boolean);
   const root=domains.find(d=>hostname.endsWith('.'+d));
   if(root){const prefix=hostname.slice(0,-root.length-1);for(const domain of domains)hosts.add(new URL('https://'+prefix+'.'+domain).hostname);}
  }catch{}
 }
 const router={rule:[...hosts].map(h=>'Host('+String.fromCharCode(96)+h+String.fromCharCode(96)+')').join(' || '),entryPoints:['websecure'],service:'dockhand-native',middlewares:['basic-headers@file'],tls:{},priority:100};
 const document={http:{routers:{'dockhand-native':router},services:{'dockhand-native':{loadBalancer:{servers:[{url:'http://'+(String(env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST||'127.0.0.1').includes(':')?'['+env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST+']':env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST||'127.0.0.1')+':'+env.PORT}]}}}}};
 const text=yaml.dump(document,{noRefs:true,lineWidth:-1});
 if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===text)return;
 const temp=path.join(path.dirname(file),'.dockhand-native-'+require('node:crypto').randomBytes(6).toString('hex'));
 fs.writeFileSync(temp,text,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);
}
