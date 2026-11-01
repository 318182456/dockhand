import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('./package/runtime/update-links.cjs',import.meta.url),'utf8');
function generate(installed){
 const files=new Map(),route='/gateway/dynamic/dockhand-native.yml',config='/var/packages/DockhandNative/target/ui/config';
 files.set(config,'{}');if(installed)files.set('/gateway/dynamic/migration-policy.yml',JSON.stringify({http:{middlewares:{'oidc-login':{plugin:{ssobridge:{mode:'oidc'}}}}}}));
 const fake={realpathSync:p=>p,lstatSync:()=>({isSymbolicLink:()=>false}),existsSync:p=>files.has(p),readFileSync:p=>{if(!files.has(p))throw Error('missing');return files.get(p)},writeFileSync:(p,v)=>files.set(p,v),renameSync:(a,b)=>{files.set(b,files.get(a));files.delete(a)}};
 const env={module:{exports:{}},URL,require:name=>name==='node:fs'?fake:name==='node:path'?path.posix:name==='node:crypto'?crypto:{load:JSON.parse,dump:JSON.stringify}};
 vm.runInNewContext(source,env);
 env.module.exports.syncDesktopLinks({DOCKHAND_NATIVE_PUBLIC_URL:'https://docker.example.test:8443',DOCKHAND_NATIVE_TRAEFIK_FILE:route,DOCKHAND_NATIVE_TRAEFIK_ENABLED:true,PORT:'3009'},{TRAEFIK_DOMAINS:'example.test,example.net'});
 return JSON.parse(files.get(route));
}
test('native Dockhand keeps Gateway session support when its own routes regenerate',()=>{
 const doc=generate(true),router=doc.http.routers['dockhand-native'];
 assert.deepEqual(router.middlewares,['oidc-login@file','basic-headers@file']);assert.match(router.rule,/docker.example.net/);
 assert.equal(doc.http.services['dockhand-native'].loadBalancer.servers[0].url,'http://127.0.0.1:3009');
});
test('standalone native Dockhand does not depend on an absent Gateway middleware',()=>{
 assert.deepEqual(generate(false).http.routers['dockhand-native'].middlewares,['basic-headers@file']);
});