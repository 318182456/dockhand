const fs=require('node:fs');
function syncDesktopLinks(env,globals=null){
 if(!env.DOCKHAND_NATIVE_PUBLIC_URL)return;
 const pkg='/var/packages/DockhandNative',url=new URL(env.DOCKHAND_NATIVE_PUBLIC_URL);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid application URL');
 const target=fs.realpathSync(pkg+'/target'),ui=fs.realpathSync(target+'/ui');
 if(!ui.startsWith(target+'/'))throw Error('Unexpected UI directory');
 const destination=ui+'/config';
 if(fs.lstatSync(destination).isSymbolicLink())throw Error('Unexpected launcher symlink');
 const config=JSON.parse(fs.readFileSync(destination,'utf8'));
 config.launchTarget={url:url.href};
 fs.writeFileSync(destination,JSON.stringify(config)+'\n');
 publishTraefik(env,globals);
}
module.exports={syncDesktopLinks};
function publishTraefik(env,globals){
 const file=env.DOCKHAND_NATIVE_TRAEFIK_FILE;
 if(!env.DOCKHAND_NATIVE_TRAEFIK_ENABLED||!file||!env.DOCKHAND_NATIVE_PUBLIC_URL)return;
 const path=require('node:path'),yaml=require('/var/packages/DockhandNative/target/app/node_modules/js-yaml');
 const hostname=new URL(env.DOCKHAND_NATIVE_PUBLIC_URL).hostname,hosts=new Set([hostname]);
 if(globals===null)return; // Keep the existing routes if PostgreSQL globals cannot be read.
 const domains=String(globals.TRAEFIK_DOMAINS||globals.TRAEFIK_DOMAIN||'').split(/[,;\s]+/).filter(d=>/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(d));
 const root=domains.find(d=>hostname.endsWith('.'+d));
 if(root){const prefix=hostname.slice(0,-root.length-1);for(const domain of domains)hosts.add(new URL('https://'+prefix+'.'+domain).hostname);}
 const router={rule:[...hosts].map(h=>'Host('+String.fromCharCode(96)+h+String.fromCharCode(96)+')').join(' || '),entryPoints:['websecure'],service:'dockhand-native',middlewares:['basic-headers@file'],tls:{},priority:100};
 const document={http:{routers:{'dockhand-native':router},services:{'dockhand-native':{loadBalancer:{servers:[{url:'http://'+(String(env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST||'127.0.0.1').includes(':')?'['+env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST+']':env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST||'127.0.0.1')+':'+env.PORT}]}}}}};
 const text=yaml.dump(document,{noRefs:true,lineWidth:-1});
 if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')===text)return;
 const temp=path.join(path.dirname(file),'.dockhand-native-'+require('node:crypto').randomBytes(6).toString('hex'));
 fs.writeFileSync(temp,text,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);
}
