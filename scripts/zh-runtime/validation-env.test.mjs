import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {injectValidationEnv} from './validation-env.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dockhand-path-validation-'));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
const template=new URL('./validation-env.template.js',import.meta.url);
const yamlUrl=pathToFileURL(createRequire(import.meta.url).resolve('js-yaml')).href;
const runtime=path.join(temporary,'runtime.mjs');
fs.writeFileSync(runtime,fs.readFileSync(template,'utf8').replace("await import('js-yaml')",'await import('+JSON.stringify(yamlUrl)+')')+'\nexport {__zhValidationEnv};');
const {__zhValidationEnv:apply}=await import(pathToFileURL(runtime));
const directory=path.join(temporary,'apps','demo');fs.mkdirSync(directory,{recursive:true});
const compose='services:\n  app:\n    image: example/app:1\n    extends:\n      file: ../all/compose-presets.yml\n      service: web\n';
const source=async()=>({composePath:path.join(directory,'compose.yaml')}),getDirectory=async()=>directory;
test('existing relative extends uses the stack directory without supplying globals',async()=>{
 const env={APP:'own'};const r=await apply('demo',compose,{existing:true},env,source,getDirectory);
 assert.equal(r.env,env);assert.ok(r.compose.includes(path.resolve(directory,'../all/compose-presets.yml')));assert.equal(fs.readdirSync(directory).length,0);
});
test('new stacks use the native target directory and keep missing variables missing',async()=>{
 const r=await apply('new',compose,{existing:false}, {},()=>{throw Error('not existing')},getDirectory);
 assert.deepEqual(r.env,{});assert.ok(r.compose.includes('compose-presets.yml'));
});
test('invalid YAML is left to native diagnostics',async()=>{
 const r=await apply('demo','services: [',{existing:true},{},source,getDirectory);assert.equal(r.compose,'services: [');
});
test('injector threads request context into the isolated runner and is idempotent',()=>{const build=path.join(temporary,'fixture'),chunks=path.join(build,'server','chunks');fs.mkdirSync(chunks,{recursive:true});fs.writeFileSync(path.join(chunks,'db.js'),'const ns={getConfigSets:g,getStackSource:s};export { g as sets, s as source };');fs.writeFileSync(path.join(chunks,'directory.js'),'import { dir as gd } from "./core.js"; async function a(){let x;if(z)x=z;else x=await gd(a,r);return json({stackDir:x,source:"default"})}');const file=path.join(chunks,'validate.js');fs.writeFileSync(file,'const error="COMPOSE_SCHEMA_ERROR";async function run(e,n,t,o){let z;try{z=await mkdtemp(join(tmpdir(),"dockhand-validate-"));return {findings:[]}}catch{return {findings:[]}}}async function lint(e,n,t={},o,s={},r){const i=base(n,t,s),c=await run(e,n,o,r);if(c.findings.length)return c;return i}const endpoint=async({cookies:e,url:n,params:t,request:o})=>{const a={},d="demo",l="",y={},k=null,h={};const G=await lint(d,l,y,k,a.config??{},h);return G};export {endpoint as POST};');assert.equal(injectValidationEnv(build,template).patched,true);const patched=fs.readFileSync(file,'utf8');assert.ok(patched.includes('existing:!!a.existing,environmentId:Number(n.searchParams.get("env"))||null'));assert.ok(patched.includes('async function run(e,n,t,o,__zhContext)'));new vm.Script(patched.replace(/export\s*\{[^}]*\};?/g,''));assert.equal(injectValidationEnv(build,template).patched,false);assert.equal(fs.readFileSync(file,'utf8'),patched);});
