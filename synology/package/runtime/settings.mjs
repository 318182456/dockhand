import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createUpdater} from './update-api.mjs';
const sessions=new Map(),attempts=new Map(),adminCache=new Map();
const defaults={DATA_DIR:'/volume1/docker/dockhand/data',PORT:'0',HOST:'0.0.0.0',TZ:'Asia/Shanghai'};
export function visibleSettings(env){
 let database={type:'postgres',host:'127.0.0.1',port:5432,database:'dockhand',username:'',hasPassword:false,sslmode:'disable'};
 if(env.DATABASE_URL){const u=new URL(env.DATABASE_URL);database={type:'postgres',host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port||5432),database:decodeURIComponent(u.pathname.slice(1)),username:decodeURIComponent(u.username),hasPassword:!!u.password,sslmode:u.searchParams.get('sslmode')||'disable'};}
 return {traefik:{enabled:!!env.DOCKHAND_NATIVE_TRAEFIK_ENABLED,file:env.DOCKHAND_NATIVE_TRAEFIK_FILE||"",host:env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST||"127.0.0.1",globalEnvFile:env.DOCKHAND_NATIVE_GLOBAL_ENV_FILE||""},publicUrl:env.DOCKHAND_NATIVE_PUBLIC_URL||"",database,dataDir:env.DATA_DIR||defaults.DATA_DIR,port:Number(env.PORT||0),tz:env.TZ||defaults.TZ,httpProxy:env.HTTP_PROXY||'',httpsProxy:env.HTTPS_PROXY||'',allProxy:env.ALL_PROXY||'',noProxy:env.NO_PROXY||''};
}
export function mergeSettings(previous,input){
 const env={...previous},db=input.database;
 if(input.traefik){
  const t=input.traefik;env.DOCKHAND_NATIVE_TRAEFIK_ENABLED=!!t.enabled;
  if(t.enabled&&(!/^\/volume[0-9]+\//.test(String(t.file))||!/[.]ya?ml$/.test(String(t.file))))throw Error('请填写数据卷中动态配置文件的完整路径');
  env.DOCKHAND_NATIVE_TRAEFIK_FILE=String(t.file||'');
  const host=String(t.host||'127.0.0.1'),u=new URL('http://'+(host.includes(':')&&!host.startsWith('[')?'['+host+']':host));
  if(u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)throw Error('后端主机只填写 IP 或主机名');
  env.DOCKHAND_NATIVE_TRAEFIK_BACKEND_HOST=u.hostname.replace(/^\[|\]$/g,'');
  env.DOCKHAND_NATIVE_GLOBAL_ENV_FILE=String(t.globalEnvFile||'');
 }
 if(input.publicUrl!==undefined){
  if(input.publicUrl!==previous.DOCKHAND_NATIVE_PUBLIC_URL)env.DOCKHAND_NATIVE_URL_TRACK_PORT=!input.publicUrl;
  if(input.publicUrl){const u=new URL(String(input.publicUrl));if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('访问 URL 必须是 HTTP 或 HTTPS 地址，且不能包含账号密码');env.DOCKHAND_NATIVE_PUBLIC_URL=u.href;}
  else env.DOCKHAND_NATIVE_PUBLIC_URL='';
 }
 if(!db||db.type!=='postgres')throw Error('请选择数据库类型');
 if(!Number.isInteger(Number(input.port))||(Number(input.port)!==0&&Number(input.port)<1024)||Number(input.port)>65535)throw Error('端口填写 0 可自动分配，或填写 1024–65535');
 if(typeof input.dataDir!=='string'||!input.dataDir.startsWith('/volume')||input.dataDir.includes('\0'))throw Error('数据目录应是数据卷中的绝对路径');
 env.DATA_DIR=input.dataDir;env.PORT=String(input.port);env.TZ=String(input.tz||defaults.TZ);
 {
  if(!db.host||!db.database||!db.username||!/^\d+$/.test(String(db.port))||Number(db.port)<1||Number(db.port)>65535)throw Error('请填写完整的 PostgreSQL 连接信息');
  const old=previous.DATABASE_URL?new URL(previous.DATABASE_URL):null,u=new URL('postgresql://localhost');
  u.hostname=String(db.host).includes(':')?'['+String(db.host).replace(/^\[|\]$/g,'')+']':String(db.host);
  u.port=String(db.port);u.pathname='/'+db.database;u.username=db.username;
  u.password=db.password?String(db.password):(old?.password?decodeURIComponent(old.password):'');
  if(['require','verify-full','prefer'].includes(db.sslmode))u.searchParams.set('sslmode',db.sslmode);
  env.DATABASE_URL=u.toString();
 }
 for(const[k,v]of Object.entries({HTTP_PROXY:input.httpProxy,HTTPS_PROXY:input.httpsProxy,ALL_PROXY:input.allProxy,NO_PROXY:input.noProxy})){
  if(v!==undefined){if(v&&k!=='NO_PROXY'){const u=new URL(String(v));if(!['http:','https:','socks5:','socks5h:'].includes(u.protocol))throw Error('不支持的代理协议');}env[k]=String(v);}
 }
 return env;
}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>65536)throw Error('请求内容过大');}return JSON.parse(text||'{}');}
function nativeSession(req){const cookie=req.headers.cookie||'',m=/(?:^|;\s*)dh_native_admin=([^;]+)/.exec(cookie);if(!m)return false;const key=createHash('sha256').update(m[1]).digest('hex'),expiry=sessions.get(key);if(!expiry||expiry<Date.now()){sessions.delete(key);return false;}return true;}
async function dsmLogin(username,password){
 if(typeof username!=='string'||!username||typeof password!=='string'||!password)return false;
 const r=await fetch('http://127.0.0.1:5000/webapi/auth.cgi',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({api:'SYNO.API.Auth',version:'6',method:'login',account:username,passwd:password,session:'DockhandNativeSettings',format:'sid'}),signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(!j.success)return false;
 try{const groups=spawnSync('/bin/id',['-Gn',username],{encoding:'utf8'});return groups.status===0&&groups.stdout.trim().split(/\s+/).includes('administrators');}
 finally{if(j.data?.sid)await fetch('http://127.0.0.1:5000/webapi/auth.cgi',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({api:'SYNO.API.Auth',version:'6',method:'logout',session:'DockhandNativeSettings',_sid:j.data.sid}),signal:AbortSignal.timeout(5000)}).catch(()=>{});}
}
export function createGateway(options){
 const {getSettings,saveSettings,restartChild,backendPort,getState}=options;
 const updater=options.updater||createUpdater({getSettings});
 const requestBackend=(url,init={})=>fetch('http://127.0.0.1:'+backendPort+url,{...init,signal:AbortSignal.timeout(5000),redirect:'manual'});
 async function appAdmin(req){
  if(!req.headers.cookie)return false;
  const key=createHash('sha256').update(req.headers.cookie).digest('hex'),cached=adminCache.get(key);
  if(cached&&cached.expiry>Date.now())return cached.allowed;
  let allowed=false;
  try{const s=await requestBackend('/api/auth/session',{headers:{cookie:req.headers.cookie}}),j=await s.json();if(j.authenticated){const r=await requestBackend('/api/users',{headers:{cookie:req.headers.cookie}});allowed=r.ok;}}catch{}
  if(adminCache.size>1000)adminCache.clear();adminCache.set(key,{allowed,expiry:Date.now()+15000});return allowed;
 }
 let authCheck={expires:0,enabled:false};
 async function proxyAllowed(req){
  try{if(authCheck.expires<Date.now()){const r=await requestBackend('/api/auth/session');const j=await r.json();authCheck={expires:Date.now()+3000,enabled:j.authEnabled===true};}return authCheck.enabled||nativeSession(req);}
  catch{return false;}
 }
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try{
   if(url.pathname==='/_native/health'){json(res,200,{runtime:'native',state:getState()});return;}
   if(url.pathname==='/_native/settings'&&req.method==='GET'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'"});
    res.end(fs.readFileSync(new URL('./settings.html',import.meta.url)));return;
   }
   if(url.pathname.startsWith('/_native/api/')){
    if(!['GET','POST'].includes(req.method)){json(res,405,{error:'不支持的请求方式'});return;}
    if(req.method==='POST'){
     const origin=req.headers.origin;if(req.headers['x-dockhand-native']!=='1'||(origin&&new URL(origin).host!==req.headers.host)){json(res,403,{error:'请求来源校验失败'});return;}
    }
    if(url.pathname==='/_native/api/login'&&req.method==='POST'){
     const ip=req.socket.remoteAddress||'unknown',now=Date.now(),recent=(attempts.get(ip)||[]).filter(t=>now-t<300000);
     if(recent.length>=5){json(res,429,{error:'请稍后再试'});return;}
     recent.push(now);if(attempts.size>1000)attempts.clear();attempts.set(ip,recent);
     const input=await body(req),ok=await(options.checkDsmLogin||dsmLogin)(input.username,input.password);
     if(!ok){json(res,401,{error:'请使用群晖管理员账号验证'});return;}
     const token=randomBytes(32).toString('base64url'),key=createHash('sha256').update(token).digest('hex');sessions.set(key,now+1800000);attempts.delete(ip);
     const remote=req.socket.remoteAddress||'',trusted=remote==='127.0.0.1'||remote==='::1'||remote==='::ffff:127.0.0.1',secure=trusted&&req.headers['x-forwarded-proto']==='https';
     res.setHeader('Set-Cookie','dh_native_admin='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800'+(secure?'; Secure':''));
     json(res,200,{ok:true});return;
    }
    if(!nativeSession(req)&&!await appAdmin(req)){json(res,401,{error:'需要管理员验证'});return;}
    if(url.pathname==='/_native/api/config'&&req.method==='GET'){json(res,200,{settings:visibleSettings(getSettings()),state:getState()});return;}
    if(url.pathname==='/_native/api/test-db'&&req.method==='POST'){
     const next=mergeSettings(getSettings(),await body(req));
     try{await options.testConnection(next);json(res,200,{ok:true});}catch(e){json(res,400,{ok:false,error:'连接失败，请检查地址、端口和凭据',code:String(e.code||'CONNECTION_FAILED')});}return;
    }
    if(url.pathname==='/_native/api/config'&&req.method==='POST'){
     const next=mergeSettings(getSettings(),await body(req));await options.testConnection(next);saveSettings(next);adminCache.clear();authCheck.expires=0;
     json(res,200,{ok:true,message:'配置已保存，正在重新连接',port:Number(next.PORT)});setTimeout(restartChild,300);return;
    }
    json(res,404,{error:'接口不存在'});return;
   }
   if(url.pathname==='/_native/update-client.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(fs.readFileSync(new URL('./update-client.js',import.meta.url)));return;}
   if(url.pathname==='/api/self-update'||url.pathname.startsWith('/api/self-update/')){
    if(!nativeSession(req)&&!await appAdmin(req)){json(res,401,{error:'需要管理员验证'});return;}
    if(req.method==='GET'&&url.pathname==='/api/self-update/check'){try{json(res,200,await updater.check());}catch{json(res,200,{updateAvailable:false,error:'无法读取原生更新源或更新服务尚未初始化，请稍后重试'});}return;}
    if(req.method==='GET'&&url.pathname==='/api/self-update/progress'){try{json(res,200,await updater.progress(url.searchParams.get('id')));}catch{json(res,404,{error:'更新任务不存在'});}return;}
    if(req.method==='POST'&&url.pathname==='/api/self-update'){
     const origin=req.headers.origin,site=req.headers['sec-fetch-site'];if(!origin||new URL(origin).host!==req.headers.host||!['same-origin','none',undefined].includes(site)||!String(req.headers['content-type']||'').startsWith('application/json')){json(res,403,{error:'请求来源校验失败'});return;}
     const input=await body(req);res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no'});res.flushHeaders();
     const emit=(event,data)=>res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');try{await updater.start(input,emit);}catch{emit('error',{message:'原生更新启动失败，请重新检查版本或确认更新服务已安装'});}res.end();return;
    }
    json(res,405,{error:'不支持的原生更新请求'});return;
   }
   if(!await proxyAllowed(req)){res.writeHead(503,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end('<!doctype html><meta charset="utf-8"><p>Dockhand 正在启动或需要配置。</p><a href="/_native/settings">打开原生设置</a>');return;}
   const upstream=http.request({host:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:{...req.headers,...(String(req.headers.accept||'').includes('text/html')?{'accept-encoding':'identity'}:{})}},response=>{
    if(String(response.headers['content-type']||'').includes('text/html')&&!response.headers['content-encoding']){
     const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>4000000){response.destroy();res.destroy();return;}chunks.push(chunk);});response.on('end',()=>{const html=Buffer.concat(chunks).toString('utf8').replace('</head>','<script src="/_native/update-client.js"></script></head>'),headers={...response.headers};delete headers['content-length'];delete headers.etag;headers['cache-control']='no-store';res.writeHead(response.statusCode,headers);res.end(html);});
    }else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
   });
   upstream.on('error',()=>{if(!res.headersSent)json(res,503,{error:'应用正在重新连接'});else res.destroy();});
   req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  }catch(e){if(!res.headersSent)json(res,400,{error:String(e.message||'请求失败').slice(0,180)});else res.destroy();}
 });
 server.on('upgrade',async(req,socket,head)=>{
  if(!await proxyAllowed(req)){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  const peer=net.connect(backendPort,'127.0.0.1',()=>{
   let text=req.method+' '+req.url+' HTTP/1.1\r\n';for(const[k,v]of Object.entries(req.headers))text+=k+': '+v+'\r\n';peer.write(text+'\r\n');if(head.length)peer.write(head);socket.pipe(peer);peer.pipe(socket);
  });peer.on('error',()=>socket.destroy());socket.on('error',()=>peer.destroy());socket.on('close',()=>peer.destroy());
 });
 return server;
}
