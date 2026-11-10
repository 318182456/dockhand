import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createGateway} from './package/runtime/settings.mjs';

async function fixture(){
 let live=0,closed=0,startedResolve;const started=new Promise(resolve=>startedResolve=resolve);
 const backend=http.createServer((req,res)=>{
  if(req.url==='/api/auth/session'){res.setHeader('content-type','application/json');res.end('{"authEnabled":true}');return;}
  if(req.url==='/html'){res.setHeader('content-type','text/html');res.end('<html><head></head><body>fixture</body></html>');return;}
  if(req.url==='/json'){res.setHeader('content-type','application/json');res.end('{"ok":true}');return;}
  live++;let timer;res.on('close',()=>{live--;closed++;clearInterval(timer)});startedResolve();
  if(req.url==='/slow')return;
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: connected\ndata: {}\n\n');
  timer=setInterval(()=>res.write('event: heartbeat\ndata: {}\n\n'),10);
 });
 backend.listen(0,'127.0.0.1');await once(backend,'listening');
 const gateway=createGateway({getSettings:()=>({}),saveSettings:()=>{},restartChild:()=>{},backendPort:backend.address().port,getState:()=> 'running',updater:{}});
 gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 return {base:'http://127.0.0.1:'+gateway.address().port,started,get live(){return live},get closed(){return closed},close(){gateway.closeAllConnections();gateway.close();backend.closeAllConnections();backend.close()}};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await delay(10)}assert.ok(check(),'disconnected downstream retained the backend response')}
async function stream(base,path){return await new Promise((resolve,reject)=>{const req=http.get(base+path,res=>{res.once('data',()=>resolve({req,res}));res.on('error',()=>{})});req.on('error',reject)})}
test('closing repeated SSE clients releases every backend stream',async()=>{
 const f=await fixture();try{
  for(let i=0;i<5;i++){const s=await stream(f.base,'/events');assert.equal(f.live,1);s.res.destroy();s.req.destroy();await until(()=>f.live===0)}
  assert.equal(f.closed,5);
 }finally{f.close()}
});
test('closing a completed GET before backend headers arrives cancels its backend response',async()=>{
 const f=await fixture();let req;try{
  req=http.get(f.base+'/slow');req.on('error',()=>{});await f.started;req.destroy();await until(()=>f.live===0);assert.equal(f.closed,1);
 }finally{req?.destroy();f.close()}
});
test('ordinary HTML injection and JSON responses still finish normally',async()=>{
 const f=await fixture();try{
  const html=await fetch(f.base+'/html');assert.equal(html.status,200);assert.match(await html.text(),/<script src="\/_native\/update-client.js"><\/script><\/head>/);
  const json=await fetch(f.base+'/json');assert.deepEqual(await json.json(),{ok:true});assert.equal(f.live,0);
 }finally{f.close()}
});
