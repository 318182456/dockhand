import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {gunzipSync,brotliDecompressSync} from 'node:zlib';
import {patchStackPage,patchStackPrimaryGroups} from './stack-primary-groups.mjs';

test('same primary category forms one group without removing functional tags',()=>{
 const source='const select=s=>D$1(tags(s),order());globalThis.result=stacks.map(select);';
 const patched=patchStackPage(source,'D$1');
 const tagsByName={cinefold:[{id:5,name:'Video'},{id:4,name:'AI'},{id:3,name:'DL'}],moviepilot:[{id:5,name:'Video'},{id:4,name:'AI'},{id:11,name:'PT'}],denova:[{id:4,name:'AI'},{id:14,name:'MCP'}],empty:[]};
 const before=JSON.stringify(tagsByName);
 const context={stacks:Object.keys(tagsByName),tags:s=>tagsByName[s],order:()=>[],D$1:tags=>tags.length?{key:tags.map(t=>t.id).join('+'),label:tags.map(t=>t.name).join('+')}:null};
 vm.runInNewContext(patched,context);
 assert.deepEqual(JSON.parse(JSON.stringify(context.result)),[{key:'5',label:'Video'},{key:'5',label:'Video'},{key:'4',label:'AI'},null]);
 assert.equal(JSON.stringify(tagsByName),before);
 assert.equal(Object.values(tagsByName).filter(ts=>ts.some(t=>t.name==='AI')).length,3);
 assert.equal(patchStackPage(patched,'D$1'),patched);
});
test('rejects a changed or duplicated upstream grouping call',()=>{
 assert.throws(()=>patchStackPage('const group=s=>D(tags[s],order());','D'),/expected one/);
 assert.throws(()=>patchStackPage('D(tags(s),order());D(tags(t),order());','D'),/found 2/);
 assert.throws(()=>patchStackPage('/* __zhStackPrimaryGroup */ D(tags(s),order());','D'),/incomplete/);
});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dockhand-primary-test-'));
 const put=(rel,text)=>{const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);return f};
 const core='const LABEL="dockhand.tags";function G(tags,order=[]){if(!tags.length)return null;return {key:tags.map(t=>t.id).join("+"),label:tags.map(t=>t.name).join("+"),icons:tags.map(t=>t.icon)}}';
 put('server/chunks/core.js',core+'export {G as D};');
 put('client/_app/immutable/chunks/core.js',core+'export {G as t};');
 put('server/chunks/page.js','import {D as D$1} from "./core.js";const key="dockhand-stacks-group-by-tag";const route="/api/stack-tags";const group=s=>D$1(tags(s),order());');
 put('client/_app/immutable/nodes/18.abc.js','import {t as Q} from "../chunks/core.js";const key="dockhand-stacks-group-by-tag";const route="/api/stack-tags";const group=s=>Q(tags(s),order());');
 put('client/_app/immutable/nodes/8.def.js','import {t as Q} from "../chunks/core.js";const key="dockhand-containers-group-by-tag";const route="/api/stack-tags";const group=s=>Q(tags(s),order());');
 put('client/_app/immutable/entry/app.hash.js','export const nodes=[()=>import("../nodes/18.abc.js"),()=>import("../nodes/8.def.js")];');
 put('server/manifest.js','export const app="_app/immutable/entry/app.hash.js";export const own="./nodes/18.abc.js";');
 return {root,put};
}
test('patches only stacks and versions reverse import graph plus compressed assets',()=>{
 const {root}=fixture();try{
  const before=fs.readFileSync(path.join(root,'client/_app/immutable/nodes/8.def.js'),'utf8');
  const result=patchStackPrimaryGroups(root);
  assert.equal(result.supported,true);assert.equal(result.changed.length,2);
  assert.equal(fs.readFileSync(path.join(root,'client/_app/immutable/nodes/8.def.js'),'utf8'),before);
  const node=result.versioned.find(p=>/18\.abc\.pg[a-f0-9]+\.js$/.test(p));
  const app=result.versioned.find(p=>/app\.hash\.pg[a-f0-9]+\.js$/.test(p));
  assert.ok(node);assert.ok(app);
  assert.match(fs.readFileSync(node,'utf8'),/tags\(s\)\.slice\(0,1\)/);
  assert.ok(fs.readFileSync(app,'utf8').includes(path.basename(node)));
  const manifest=fs.readFileSync(path.join(root,'server/manifest.js'),'utf8');
  assert.ok(manifest.includes(path.basename(app)));assert.ok(manifest.includes('./nodes/18.abc.js'));
  assert.equal(gunzipSync(fs.readFileSync(node+'.gz')).toString(),fs.readFileSync(node,'utf8'));
  assert.equal(brotliDecompressSync(fs.readFileSync(node+'.br')).toString(),fs.readFileSync(node,'utf8'));
  assert.equal(patchStackPrimaryGroups(root).changed.length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('preflights browser and server before writing either',()=>{
 const {root,put}=fixture();try{
  const server=path.join(root,'server/chunks/page.js'),before=fs.readFileSync(server,'utf8');
  const client=path.join(root,'client/_app/immutable/nodes/18.abc.js');put('client/_app/immutable/nodes/18.abc.js',fs.readFileSync(client,'utf8').replace('Q(tags(s),','Q(tags[s],'));
  assert.throws(()=>patchStackPrimaryGroups(root),/expected one stack grouping call/);
  assert.equal(fs.readFileSync(server,'utf8'),before);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('older releases without stack tag grouping stay unchanged',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dockhand-primary-old-'));
 try{assert.deepEqual(patchStackPrimaryGroups(root),{supported:false,changed:[],versioned:[]})}finally{fs.rmSync(root,{recursive:true,force:true})}
});
