import { patchGlobalEnvPanel } from './global-env-panel.mjs';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { injectValidationEnv, injectEnvMarkers } from './validation-env.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dockhand-validation-env-'));
const globalTemplate=new URL('./global-env.template.js',import.meta.url),template=new URL('./validation-env.template.js',import.meta.url),selection=process.env.ZH_GLOBAL_ENV_CONFIG_SET;
after(()=>{if(selection===undefined)delete process.env.ZH_GLOBAL_ENV_CONFIG_SET;else process.env.ZH_GLOBAL_ENV_CONFIG_SET=selection;fs.rmSync(temporary,{recursive:true,force:true});});
const yamlUrl=pathToFileURL(createRequire(import.meta.url).resolve('js-yaml')).href;
const runtime=path.join(temporary,'runtime.mjs');
fs.writeFileSync(runtime,fs.readFileSync(globalTemplate,'utf8')+'\n'+fs.readFileSync(template,'utf8').replace("await import('js-yaml')",'await import('+JSON.stringify(yamlUrl)+')')+'\nexport { __zhValidationEnv, __zhGlobalEnvMarkers };');
const {__zhValidationEnv:apply,__zhGlobalEnvMarkers:markers}=await import(pathToFileURL(runtime));
const directory=path.join(temporary,'apps','demo');fs.mkdirSync(directory,{recursive:true});
const globals={TRAEFIK_PRESET_FILE:'../traefik/compose-presets.yml',TRAEFIK_DOMAINS:'example.com,example.net',HTTP_PROXY:'http://proxy.invalid:7890'};
const readSets=async()=>[{name:'全局变量',envVars:Object.entries(globals).map(([key,value])=>({key,value}))}];
const compose='services:\n  app:\n    image: example/app:1\n    extends:\n      file: "'+'$'+'{TRAEFIK_PRESET_FILE}"\n      service: web-sso\n';
const source=async()=>({composePath:path.join(directory,'compose.yaml')}),getDirectory=async()=>directory;
test('off mode leaves native validation untouched',async()=>{delete process.env.ZH_GLOBAL_ENV_CONFIG_SET;const env={APP:'value'},fail=()=>{throw Error('unexpected read');};const r=await apply('demo',compose,{},env,fail,fail,fail);assert.equal(r.compose,compose);assert.equal(r.env,env);});
test('existing stack resolves extends at its real directory and preserves explicit values',async()=>{process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';const r=await apply('demo',compose,{existing:true,environmentId:2},{HTTP_PROXY:'local'},readSets,source,getDirectory);const yaml=(await import('js-yaml')).default;assert.equal(yaml.load(r.compose).services.app.extends.file,path.resolve(directory,globals.TRAEFIK_PRESET_FILE));assert.equal(r.env.HTTP_PROXY,'local');assert.equal(r.env.TRAEFIK_DOMAIN_REGEX,'example[.]com|example[.]net');assert.equal(fs.readdirSync(directory).length,0);});
test('new stack uses native directory without reading an existing source',async()=>{process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';let seen;const r=await apply('new',compose,{existing:false,environmentId:2},{},readSets,()=>{throw Error('not existing');},async(name,id)=>{seen=[name,id];return directory;});assert.deepEqual(seen,['new',2]);assert.ok(r.compose.includes('compose-presets.yml'));});
test('invalid YAML remains available to native diagnostics',async()=>{process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';const r=await apply('demo','services: [',{existing:true},{},readSets,source,getDirectory);assert.equal(r.compose,'services: [');});
test('env-file exclusions retain deployment precedence without file writes',async()=>{process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';const file=path.join(directory,'.env'),before='HTTP_PROXY=custom\n';fs.writeFileSync(file,before);try{const r=await apply('demo',compose,{existing:true},{HTTP_PROXY:'custom'},readSets,source,getDirectory);assert.equal(r.env.HTTP_PROXY,'custom');assert.equal(fs.readFileSync(file,'utf8'),before);}finally{fs.unlinkSync(file);}});
test('injector threads request context into the isolated runner and is idempotent',()=>{const build=path.join(temporary,'fixture'),chunks=path.join(build,'server','chunks');fs.mkdirSync(chunks,{recursive:true});fs.writeFileSync(path.join(chunks,'db.js'),'const ns={getConfigSets:g,getStackSource:s};export { g as sets, s as source };');fs.writeFileSync(path.join(chunks,'directory.js'),'import { dir as gd } from "./core.js"; async function a(){let x;if(z)x=z;else x=await gd(a,r);return json({stackDir:x,source:"default"})}');const file=path.join(chunks,'validate.js');fs.writeFileSync(file,'const error="COMPOSE_SCHEMA_ERROR";async function run(e,n,t,o){let z;try{z=await mkdtemp(join(tmpdir(),"dockhand-validate-"));return {findings:[]}}catch{return {findings:[]}}}async function lint(e,n,t={},o,s={},r){const i=base(n,t,s),c=await run(e,n,o,r);if(c.findings.length)return c;return i}const endpoint=async({cookies:e,url:n,params:t,request:o})=>{const a={},d="demo",l="",y={},k=null,h={};const G=await lint(d,l,y,k,a.config??{},h);return G};export {endpoint as POST};');assert.equal(injectValidationEnv(build,template,globalTemplate).patched,true);const patched=fs.readFileSync(file,'utf8');assert.ok(patched.includes('existing:!!a.existing,environmentId:Number(n.searchParams.get("env"))||null'));assert.ok(patched.includes('async function run(e,n,t,o,__zhContext)'));new vm.Script(patched.replace(/export\s*\{[^}]*\};?/g,''));assert.equal(injectValidationEnv(build,template,globalTemplate).patched,false);assert.equal(fs.readFileSync(file,'utf8'),patched);});


test('editor markers recognize referenced globals and derived defaults without exposing values',async()=>{
  process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';
  const input={valid:false,required:['TRAEFIK_PRESET_FILE','APP_REQUIRED','TRAEFIK_DOMAIN_REGEX'],optional:['HTTP_PROXY'],defined:['LOCAL'],missing:['TRAEFIK_PRESET_FILE','APP_REQUIRED','TRAEFIK_DOMAIN_REGEX'],unused:['LOCAL']};
  const result=await markers(input,readSets);
  assert.deepEqual(result.missing,['APP_REQUIRED']);
  assert.equal(result.valid,false);
  assert.deepEqual(result.defined,['HTTP_PROXY','LOCAL','TRAEFIK_DOMAIN_REGEX','TRAEFIK_PRESET_FILE']);
  assert.deepEqual(result.unused,['LOCAL']);
  assert.ok(!JSON.stringify(result).includes(globals.HTTP_PROXY));
  assert.ok(!result.defined.includes('TRAEFIK_DOMAINS'));
  assert.deepEqual(input.missing,['TRAEFIK_PRESET_FILE','APP_REQUIRED','TRAEFIK_DOMAIN_REGEX']);
});
test('editor missing badge clears for global-only references and refreshes on each read',async()=>{
  process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';
  const input={valid:false,required:['TRAEFIK_PRESET_FILE'],optional:[],defined:[],missing:['TRAEFIK_PRESET_FILE'],unused:[]};
  assert.equal((await markers(input,readSets)).valid,true);
  const noGlobals=async()=>[{name:'全局变量',envVars:[]}];
  assert.equal((await markers(input,noGlobals)).valid,false);
  process.env.ZH_GLOBAL_ENV_CONFIG_SET='off';
  assert.equal(await markers(input,()=>{throw Error('should not read')}),input);
});
test('marker injection preserves authorization and only transforms the name-only result',()=>{
  const build=path.join(temporary,'marker-fixture'),chunks=path.join(build,'server','chunks');
  fs.mkdirSync(chunks,{recursive:true});
  fs.writeFileSync(path.join(chunks,'db.js'),'const ns={getConfigSets:g};export { g as sets };');
  const file=path.join(chunks,'markers.js');
  fs.writeFileSync(file,'const handler=async()=>{if(!allowed)return json({error:"Permission denied"},{status:403});try{const m=[],c=[],d=[],E=[],f=[],P={valid:m.length===0,required:c,optional:d,defined:E,missing:m,unused:f};return json(P)}catch(e){console.error("Error validating stack env vars:",e)}};export {handler as POST};');
  assert.equal(injectEnvMarkers(build,template,globalTemplate).patched,true);
  const patched=fs.readFileSync(file,'utf8');
  assert.ok(patched.includes('if(!allowed)return json({error:"Permission denied"},{status:403})'));
  assert.ok(patched.includes('return json(await __zhGlobalEnvMarkers(P,'));
  new vm.Script(patched.replace(/export\s*\{[^}]*\};?/g,''));
  assert.equal(injectEnvMarkers(build,template,globalTemplate).patched,false);
});


test('global panel bootstrap is harmless during SSR and injection is complete/idempotent',()=>{
  const template=new URL('./global-env-panel.template.js',import.meta.url);
  new vm.Script(fs.readFileSync(template,'utf8')).runInNewContext({});
  const build=path.join(temporary,'panel-fixture'),client=path.join(build,'client');
  fs.mkdirSync(client,{recursive:true});
  const file=path.join(client,'stack.js'),original='const settings={defaultComposeTemplate:""};const url="/env/validate";';
  fs.writeFileSync(file,original);
  assert.equal(patchGlobalEnvPanel(build,template).patched,true);
  const patched=fs.readFileSync(file,'utf8');
  assert.ok(patched.startsWith(original));
  new vm.Script(patched);
  assert.equal(patchGlobalEnvPanel(build,template).patched,false);
  fs.writeFileSync(path.join(client,'duplicate.js'),original);
  assert.throws(()=>patchGlobalEnvPanel(build,template),/expected one stack modal client/);
});


test('file-backed validation and markers work without a Config Set and expose the configured source',async()=>{
  const file=path.join(temporary,'shared.env');process.env.ZH_GLOBAL_ENV_FILE=file;
  try{
    fs.writeFileSync(file,"TZ='Asia/Shanghai'\nPUID='1026'\nTRAEFIK_DOMAINS='example.test'\n");
    const r=await apply('demo','services:\n  app:\n    image: app:1\n', {existing:true}, {},()=>{throw Error('must not read Config Sets')},source,getDirectory);
    assert.equal(r.env.PUID,'1026');
    const m=await markers({required:['PUID'],missing:['PUID'],defined:[]},()=>{throw Error('must not read Config Sets')});
    assert.equal(m.globalEnv.sourceType,'file');assert.equal(m.globalEnv.source,file);assert.equal(m.globalEnv.values.PUID,'1026');assert.deepEqual(m.missing,[]);
  }finally{delete process.env.ZH_GLOBAL_ENV_FILE;}
});
