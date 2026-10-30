import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway,mergeSettings,visibleSettings} from './package/runtime/settings.mjs';
const previous={DATABASE_URL:'postgresql://app:fixture%40password@127.0.0.1:15432/dockhand',DATA_DIR:'/volume1/docker/dockhand/data',PORT:'3009',HOST:'127.0.0.1',HOME:'/volume1/private'};
const input={database:{type:'postgres',host:'127.0.0.1',port:15432,database:'dockhand',username:'app',password:'',sslmode:'disable'},dataDir:previous.DATA_DIR,port:3009,tz:'Asia/Shanghai'};
test('blank password preserves the saved secret, while config responses omit it',()=>{
 const next=mergeSettings(previous,input);assert.equal(new URL(next.DATABASE_URL).password,'fixture%40password');
 const visible=visibleSettings(next);assert.equal(visible.database.hasPassword,true);assert.equal('password' in visible.database,false);assert.equal(JSON.stringify(visible).includes('fixture'),false);
 assert.equal(next.HOME,previous.HOME);
});
test('invalid database types and ports are rejected',()=>{
 assert.throws(()=>mergeSettings(previous,{...input,port:1}));
 assert.throws(()=>mergeSettings(previous,{...input,database:{...input.database,type:'other'}}));
});
test('native settings require admin authentication and reject cross-origin writes',async()=>{
 const backend=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({authenticated:false,authEnabled:false}));});
 backend.listen(0,'127.0.0.1');await once(backend,'listening');
 let saved=null,current={...previous};
 const server=createGateway({getSettings:()=>current,saveSettings:next=>{saved=next;current=next;},restartChild:()=>{},backendPort:backend.address().port,getState:()=> 'running',testConnection:async()=>{},checkDsmLogin:async(u,p)=>u==='fixture-admin'&&p==='fixture-login'});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/_native/api/config')).status,401);
  const blocked=await fetch(base+'/_native/api/login',{method:'POST',headers:{'x-dockhand-native':'1',origin:'https://unrelated.example'},body:JSON.stringify({username:'fixture-admin',password:'fixture-login'})});assert.equal(blocked.status,403);
  const login=await fetch(base+'/_native/api/login',{method:'POST',headers:{'x-dockhand-native':'1'},body:JSON.stringify({username:'fixture-admin',password:'fixture-login'})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const cfg=await fetch(base+'/_native/api/config',{headers:{cookie}});assert.equal(cfg.status,200);assert.equal((await cfg.json()).settings.database.hasPassword,true);
  const result=await fetch(base+'/_native/api/config',{method:'POST',headers:{cookie,'x-dockhand-native':'1'},body:JSON.stringify(input)});assert.equal(result.status,200);assert.ok(saved);assert.equal(new URL(saved.DATABASE_URL).password,'fixture%40password');
  assert.equal((await fetch(base+'/api/self-update',{method:'POST'})).status,409);
  const anonymous=await fetch(base+'/');assert.equal(anonymous.status,503);assert.match(await anonymous.text(),/_native\/settings/);
 }finally{server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();}
});
