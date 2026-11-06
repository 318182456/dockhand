import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const MARK='/* __zhStackPrimaryGroup */';
const id='[\\w$]+';
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function* walk(root){
 if(!fs.existsSync(root))return;
 for(const e of fs.readdirSync(root,{withFileTypes:true})){
  const p=path.join(root,e.name);
  if(e.isDirectory())yield* walk(p);else if(e.isFile())yield p;
 }
}
function importedGroup(source,file,root){
 const candidates=[];
 for(const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)){
  if(!m[2].startsWith('.'))continue;
  const target=path.resolve(path.dirname(file),m[2]);
  if(!target.startsWith(root+path.sep)||!fs.existsSync(target))continue;
  const core=fs.readFileSync(target,'utf8');
  if(!core.includes('dockhand.tags'))continue;
  const heads=[...core.matchAll(new RegExp('function ('+id+')\\(('+id+'),('+id+')=\\[\\]\\)\\{if\\(!\\2\\.length\\)return null;','g'))];
  for(const h of heads){
   const body=core.slice(h.index,h.index+650);
   if(!body.includes('key:')||!body.includes('icons:'))continue;
   const exports=[...core.matchAll(/export\s*\{([^}]+)\}/g)].flatMap(x=>x[1].split(','));
   const match=exports.map(x=>new RegExp('^\\s*'+escape(h[1])+'(?:\\s+as\\s+('+id+'))?\\s*$').exec(x)).filter(Boolean);
   if(match.length!==1)throw Error('StackPrimary: ambiguous group export');
   const exported=match[0][1]||h[1];
   for(const binding of m[1].split(',')){
    const b=new RegExp('^\\s*'+escape(exported)+'(?:\\s+as\\s+('+id+'))?\\s*$').exec(binding);
    if(b)candidates.push(b[1]||exported);
   }
  }
 }
 if(candidates.length!==1)throw Error('StackPrimary: expected one imported tag group function in '+path.basename(file));
 return candidates[0];
}

export function patchStackPage(source,alias){
 const prefix=escape(alias)+'\\(\\s*('+id+'\\(\\s*'+id+'\\s*\\))';
 if(source.includes(MARK)){
  if(!new RegExp(prefix+'\\.slice\\(0,1\\)').test(source))throw Error('StackPrimary: incomplete existing patch');
  return source;
 }
 const calls=[...source.matchAll(new RegExp(prefix+'\\s*,','g'))];
 if(calls.length!==1)throw Error('StackPrimary: expected one stack grouping call, found '+calls.length);
 const hit=calls[0],offset=hit.index+hit[0].lastIndexOf(',');
 // ASVS 1.2.3: insert only fixed code beside a validated identifier/call fingerprint.
 // Read-only slice keeps all feature tags available to filtering and badge rendering.
 return source.slice(0,offset)+'.slice(0,1)'+source.slice(offset)+'\n'+MARK+'\n';
}

export function versionClientAssets(buildDir,changedFiles){
 const client=path.join(buildDir,'client');
 const all=[...walk(client)].filter(p=>p.endsWith('.js')&&p.includes(path.sep+'immutable'+path.sep)).map(file=>({file,source:fs.readFileSync(file,'utf8')}));
 const selected=new Set(changedFiles.filter(p=>p.startsWith(client+path.sep)));
 if(!selected.size)return [];
 let grew=true;
 while(grew){
  grew=false;const names=[...selected].map(p=>path.basename(p));
  for(const item of all)if(!selected.has(item.file)&&names.some(n=>item.source.includes(n))){selected.add(item.file);grew=true;}
 }
 const digest=createHash('sha256').update([...selected].sort().map(p=>path.relative(buildDir,p)+'\n'+fs.readFileSync(p,'utf8')).join('\n')).digest('hex').slice(0,12);
 const names=new Map([...selected].map(p=>[path.basename(p),path.basename(p).slice(0,-3)+'.pg'+digest+'.js']));
 const relative=new Map([...selected].map(p=>{const old=path.relative(client,p).split(path.sep).join('/');return [old,old.slice(0,-path.basename(p).length)+names.get(path.basename(p))]}));
 const re=new RegExp([...names.keys()].map(escape).join('|'),'g');
 const serverRE=new RegExp([...relative.keys()].map(escape).join('|'),'g');
 const updates=[];
 for(const file of walk(buildDir)){
  if(!/\.(js|json|html|css)$/.test(file))continue;
  const old=fs.readFileSync(file,'utf8'),isClient=file.startsWith(client+path.sep);
  const text=isClient?old.replace(re,n=>names.get(n)):old.replace(serverRE,n=>relative.get(n));
  const renamed=selected.has(file)?path.join(path.dirname(file),names.get(path.basename(file))):file;
  if(text!==old||renamed!==file)updates.push({file:renamed,text,client:isClient});
 }
 for(const u of updates){
  fs.writeFileSync(u.file,u.text);
  if(u.client){fs.writeFileSync(u.file+'.gz',gzipSync(u.text));fs.writeFileSync(u.file+'.br',brotliCompressSync(u.text));}
 }
 // Keep old asset names for already-open browser sessions. Fresh HTML imports the new graph.
 return updates.map(x=>x.file);
}

export function patchStackPrimaryGroups(buildDir,{versionAssets=true}={}){
 buildDir=path.resolve(buildDir);
 const candidates=[...walk(buildDir)].filter(p=>p.endsWith('.js')&&(/[/\\]server[/\\]/.test(p)||/[/\\]client[/\\].*[/\\]nodes[/\\]/.test(p))).map(file=>({file,source:fs.readFileSync(file,'utf8')})).filter(x=>x.source.includes('dockhand-stacks-group-by-tag')&&x.source.includes('/api/stack-tags'));
 if(!candidates.length)return {supported:false,changed:[],versioned:[]};
 if(!candidates.some(x=>x.file.includes(path.sep+'server'+path.sep))||!candidates.some(x=>x.file.includes(path.sep+'client'+path.sep)))throw Error('StackPrimary: missing server or browser stack page');
 // Prepare every replacement before touching files; a changed upstream signature fails closed.
 const prepared=candidates.map(x=>{try{return {...x,next:patchStackPage(x.source,importedGroup(x.source,x.file,buildDir))}}catch(e){throw Error(path.relative(buildDir,x.file)+': '+e.message)}});
 const changed=[];
 for(const p of prepared)if(p.next!==p.source){fs.writeFileSync(p.file,p.next);if(p.file.includes(path.sep+'client'+path.sep)){fs.writeFileSync(p.file+'.gz',gzipSync(p.next));fs.writeFileSync(p.file+'.br',brotliCompressSync(p.next));}changed.push(p.file);}
 const versioned=versionAssets&&changed.length?versionClientAssets(buildDir,changed):[];
 return {supported:true,changed,versioned};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv[2];if(!root)throw Error('Usage: node stack-primary-groups.mjs <buildDir>');
 console.log(JSON.stringify(patchStackPrimaryGroups(root)));
}
