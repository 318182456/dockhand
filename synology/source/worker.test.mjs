import test from "node:test";import assert from "node:assert/strict";import {handle,compatible} from "./worker.mjs";
const pkg={package:"DockhandNative",version:"1.0.55-1",tag:"synology-v1.0.55-1",filename:"DockhandNative-x86_64-1.0.55-1.spk",arch:["x86_64","broadwellnkv2"],size:100};
const catalog=async()=>Response.json({packages:[pkg]});
test("DSM catalog keeps downloads on the source and filters unsupported systems",async()=>{
 const r=await handle(new Request("https://source.example/api/package?arch=broadwellnkv2&major=7&minor=4"),{},catalog);
 const j=await r.json();assert.equal(j.packages.length,1);assert.match(j.packages[0].link,/^https:\/\/source[.]example\/packages\//);
 assert.equal(compatible(pkg,new URLSearchParams("arch=armv8&major=7&minor=4")),false);
 assert.equal(compatible(pkg,new URLSearchParams("arch=x64&major=7&minor=2")),false);
});
test("DSM POST device parameters are accepted",async()=>{
 const r=await handle(new Request("https://source.example/",{method:"POST",body:"arch=broadwellnkv2&major=7&minor=4"}),{},catalog);
 assert.equal((await r.json()).packages.length,1);
});
test("package streaming preserves Range, HEAD and upstream failures",async()=>{
 let headers,method;
 const mocked=async(url,options)=>{if(url.endsWith("synology-manifest.json"))return catalog();headers=options.headers;method=options.method;return new Response(null,{status:206,headers:{"Content-Range":"bytes 0-9/100","Content-Length":"10"}})};
 const r=await handle(new Request("https://source.example/packages/"+pkg.tag+"/"+pkg.filename,{method:"HEAD",headers:{Range:"bytes=0-9"}}),{},mocked);
 assert.equal(r.status,206);assert.equal(method,"HEAD");assert.equal(headers.get("Range"),"bytes=0-9");assert.equal(r.headers.get("Content-Range"),"bytes 0-9/100");
});
test("unknown download paths never fetch arbitrary upstream URLs",async()=>{
 let calls=0;const mocked=async()=>{calls++;return catalog()};
 const r=await handle(new Request("https://source.example/packages/private/key.spk"),{},mocked);
 assert.equal(r.status,404);assert.equal(calls,1);
});
test("unpublished source is empty, upstream outages are reported",async()=>{
 const empty=await handle(new Request("https://source.example/"),{},async()=>new Response(null,{status:404}));
 assert.deepEqual(await empty.json(),{packages:[]});
 const outage=await handle(new Request("https://source.example/"),{},async()=>new Response(null,{status:500}));
 assert.equal(outage.status,503);
});

test("SA6400 epyc7002 receives the generic x86_64 package",async()=>{
 const r=await handle(new Request("https://source.example/?arch=epyc7002&major=7&minor=4&build=90080"),{},catalog);
 const j=await r.json();assert.equal(j.packages.length,1);assert.equal(j.packages[0].package,"DockhandNative");
 assert.equal(compatible(pkg,new URLSearchParams("arch=armv8&major=7&minor=4")),false);
});