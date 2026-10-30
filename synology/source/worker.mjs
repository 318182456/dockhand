const upstreamDefault = "https://github.com/318182456/dockhand/releases/latest/download/synology-manifest.json";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=60","X-Content-Type-Options":"nosniff"}});
export function compatible(pkg,params){
 const major=Number(params.get("major")||params.get("majorversion")||0),minor=Number(params.get("minor")||params.get("minorversion")||0);
 if(major && (major<7 || (major===7 && minor<4)))return false;
 const arch=params.get("arch")||"";
 return !arch || (pkg.arch||[]).includes(arch) || (arch==="x64"&&(pkg.arch||[]).includes("x86_64"));
}
function validateManifest(value){
 if(!value || !Array.isArray(value.packages))throw Error("Invalid manifest");
 return value.packages.filter(p=>p.package==="DockhandNative"&&/^[0-9]+(?:[._-][0-9]+)+$/.test(p.version)&&/^[A-Za-z0-9._-]+\.spk$/.test(p.filename)&&/^synology-v[0-9._-]+$/.test(p.tag)&&Array.isArray(p.arch));
}
async function manifest(env,fetcher){
 if(env.PACKAGE_CATALOG)return validateManifest((await env.PACKAGE_CATALOG.get("catalog","json"))||{packages:[]});
 const url=env.MANIFEST_URL||upstreamDefault;
 if(!url.startsWith("https://github.com/318182456/dockhand/releases/"))throw Error("Untrusted manifest origin");
 const r=await fetcher(url,{headers:{"User-Agent":"Dockhand-Synology-Repository"},cf:{cacheTtl:60,cacheEverything:true}});
 if(r.status===404)return [];
 if(!r.ok)throw Error("Manifest unavailable");
 return validateManifest(await r.json());
}
export async function handle(request,env={},fetcher=fetch){
 const u=new URL(request.url);
 if(!["GET","HEAD","POST"].includes(request.method))return new Response("Method not allowed",{status:405,headers:{Allow:"GET, HEAD, POST"}});
 try{
  if(u.pathname==="/health")return json({ok:true,revision:2});
  if(u.pathname==="/_publish"){
   if(request.method!=="POST"||!env.PUBLISH_KEY||env.PUBLISH_KEY.length<32||request.headers.get("Authorization")!=="Bearer "+env.PUBLISH_KEY)return json({error:"Unauthorized"},401);
   if(!env.PACKAGE_CATALOG)return json({error:"Storage unavailable"},503);
   if(Number(request.headers.get("Content-Length")||0)>65536)return json({error:"Manifest too large"},413);
   const raw=await request.text();if(raw.length>65536)return json({error:"Manifest too large"},413);
   const input=JSON.parse(raw),entries=validateManifest(input);
   if(entries.length!==input.packages.length||entries.length>4)return json({error:"Invalid manifest"},400);
   for(const entry of entries)await env.PACKAGE_CATALOG.put("release:"+entry.tag,JSON.stringify({packages:[entry]}));
   await env.PACKAGE_CATALOG.put("catalog",JSON.stringify({packages:entries}));
   return json({ok:true,packages:entries.length});
  }
  const packages=await manifest(env,fetcher);
  if(u.pathname==="/health")return json({ok:true,packages:packages.length});
  if(u.pathname.startsWith("/packages/")){
   if(request.method==="POST")return new Response("Method not allowed",{status:405});
   let entry=packages.find(p=>u.pathname==="/packages/"+p.tag+"/"+p.filename);
   const parts=u.pathname.split("/");
   if(!entry&&env.PACKAGE_CATALOG&&parts.length===4&&/^synology-v[0-9._-]+$/.test(parts[2])){
    const old=await env.PACKAGE_CATALOG.get("release:"+parts[2],"json");
    if(old)entry=validateManifest(old).find(p=>p.filename===parts[3]);
   }
   if(!entry)return new Response("Not found",{status:404});
   const headers=new Headers({"User-Agent":"Dockhand-Synology-Repository"});
   for(const key of ["Range","If-None-Match","If-Modified-Since"])if(request.headers.has(key))headers.set(key,request.headers.get(key));
   const origin="https://github.com/318182456/dockhand/releases/download/"+entry.tag+"/"+entry.filename;
   const r=await fetcher(origin,{method:request.method,headers,redirect:"follow"});
   const out=new Headers();
   for(const key of ["Content-Length","Content-Type","Content-Range","Accept-Ranges","ETag","Last-Modified"])if(r.headers.has(key))out.set(key,r.headers.get(key));
   out.set("Content-Type","application/octet-stream");out.set("Content-Disposition",'attachment; filename="'+entry.filename+'"');out.set("X-Content-Type-Options","nosniff");
   out.set("Cache-Control",r.ok?"public, max-age=86400, immutable":"no-store");
   return new Response(request.method==="HEAD"?null:r.body,{status:r.status,headers:out});
  }
  if(!["/","/nas","/api/package","/catalog.json"].includes(u.pathname))return new Response("Not found",{status:404});
  if(request.method==="POST"){
   const body=await request.text();if(body.length>16384)return new Response("Request too large",{status:413});
   for(const[k,v]of new URLSearchParams(body))if(!u.searchParams.has(k))u.searchParams.set(k,v);
  }
  const selected=packages.filter(p=>compatible(p,u.searchParams)).map(p=>({
   package:p.package,version:p.version,dname:p.dname||"Dockhand Native",desc:p.description||"Native Docker management for Synology DSM",
   arch:p.arch,os_min_ver:p.os_min_ver||"7.4-0",maintainer:"318182456",maintainer_url:"https://github.com/318182456/dockhand",
   link:u.origin+"/packages/"+p.tag+"/"+p.filename,size:p.size,md5:p.md5,sha256:p.sha256,
   thumbnail:p.thumbnail||[],changelog:p.changelog||"",beta:!!p.beta,distributor:"318182456"
  }));
  return json({packages:selected});
 }catch{return json({error:"Package catalog temporarily unavailable"},503)}
}
export default {async fetch(request,env){try{return await handle(request,env);}catch(e){console.error(e.name+": "+e.message);return json({error:"Worker entry failed"},503);}}};
