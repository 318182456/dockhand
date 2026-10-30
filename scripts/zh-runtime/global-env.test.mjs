import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { injectGlobalEnv } from './global-env.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dockhand-global-env-tests-'));
const templatePath = new URL('./global-env.template.js', import.meta.url);
const runtimePath = path.join(temporary, 'runtime.mjs');
fs.writeFileSync(runtimePath, fs.readFileSync(templatePath, 'utf8') + '\nexport { __zhGlobalEnv };');
const { __zhGlobalEnv: apply } = await import(pathToFileURL(runtimePath));
const oldSelection = process.env.ZH_GLOBAL_ENV_CONFIG_SET;
const oldFile = process.env.ZH_GLOBAL_ENV_FILE;
delete process.env.ZH_GLOBAL_ENV_FILE;
after(() => {
  if(oldFile===undefined)delete process.env.ZH_GLOBAL_ENV_FILE;else process.env.ZH_GLOBAL_ENV_FILE=oldFile;
  if (oldSelection === undefined) delete process.env.ZH_GLOBAL_ENV_CONFIG_SET;
  else process.env.ZH_GLOBAL_ENV_CONFIG_SET = oldSelection;
  fs.rmSync(temporary, { recursive: true, force: true });
});
const options = { workingDir: temporary };
const entries = values => Object.entries(values).map(([key, value]) => ({ key, value }));
const provider = values => async () => [{ name: '全局变量', envVars: entries(values), labels: [{ key: 'ignored', value: 'yes' }] }];

test('disabled overlay preserves arguments and never reads the DB', async () => {
  delete process.env.ZH_GLOBAL_ENV_CONFIG_SET;
  const secret = { APP_PASSWORD: 'existing' };
  assert.equal(await apply({}, {}, secret, () => { throw Error('must not read DB'); }), secret);
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = 'off';
  assert.equal(await apply({}, {}, secret, () => { throw Error('must not read DB'); }), secret);
});

test('global defaults preserve literal domain, empty, dollar and multiline values', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
  const values = { TRAEFIK_DOMAIN: 'example.org', TRAEFIK_HTTPS_PORT: '9443', APP_LITERAL: '$value\nsecond line', APP_EMPTY: '' };
  assert.deepEqual(await apply(options, {}, undefined, provider(values)), values);
});

test('app .env, custom env, DB vars and native secrets all override globals without mutation', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
  const dir = fs.mkdtempSync(path.join(temporary, 'app-'));
  fs.writeFileSync(path.join(dir, '.env'), 'TRAEFIK_DOMAIN=local.test\nexport APP_EMPTY=\nAPP_BARE\n');
  const custom = path.join(dir, 'custom.env');
  fs.writeFileSync(custom, 'TRAEFIK_DOMAIN_ALT=local-alt.test\n');
  const env = { APP_DB: 'db' }, secret = { APP_SECRET: 'native-secret' };
  const values = { TRAEFIK_DOMAIN: 'global.test', TRAEFIK_DOMAIN_ALT: 'alt.test', APP_EMPTY: 'fallback', APP_BARE: 'fallback', APP_DB: 'fallback', APP_SECRET: 'fallback', TRAEFIK_HTTPS_PORT: '9443' };
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.deepEqual(await apply({ composePath: path.join(dir, 'compose.yaml'), envPath: custom }, env, secret, provider(values)), { TRAEFIK_HTTPS_PORT: '9443', APP_SECRET: 'native-secret' });
  assert.deepEqual(env, { APP_DB: 'db' });
  assert.deepEqual(secret, { APP_SECRET: 'native-secret' });
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
});

test('Hawser staged env files override defaults', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
  const result = await apply({ ...options, stackFiles: { '.env': 'TRAEFIK_DOMAIN=remote.test\n' } }, {}, {}, provider({ TRAEFIK_DOMAIN: 'fallback.test', TRAEFIK_HTTPS_PORT: '9443' }));
  assert.deepEqual(result, { TRAEFIK_HTTPS_PORT: '9443' });
});

test('read on each deployment so edits apply without caching or restart', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
  let port = '9443';
  const read = () => provider({ TRAEFIK_HTTPS_PORT: port })();
  assert.equal((await apply(options, {}, {}, read)).TRAEFIK_HTTPS_PORT, '9443');
  port = '8443';
  assert.equal((await apply(options, {}, {}, read)).TRAEFIK_HTTPS_PORT, '8443');
});

test('reject bad configuration and control variables without leaking values', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'COMPOSE_FILE', 'NODE_OPTIONS', 'LD_PRELOAD', 'A-B', '__proto__']) {
    await assert.rejects(apply(options, {}, {}, provider({ [key]: 'must-not-appear-in-errors' })), error => !error.message.includes('must-not-appear-in-errors'));
  }
  await assert.rejects(apply(options, {}, {}, async () => []), /not found/);
  await assert.rejects(apply({}, {}, {}, provider({ APP_X: 'x' })), /directory/);
  await assert.rejects(apply(options, {}, {}, provider({ APP_X: 'x\0y' })), /Invalid variable value/);
  await assert.rejects(apply(options, {}, {}, async () => [{ name: '全局变量', envVars: [{ key: 'APP_X', value: '1' }, { key: 'APP_X', value: '2' }] }]), /Duplicate/);
});

test('inject exactly once and pass native dispatcher arguments through', async () => {
  const build = path.join(temporary, 'fixture');
  fs.mkdirSync(path.join(build, 'server'), { recursive: true });
  const dispatcher = 'async function native(op,options,compose,envVars,secretVars,onLine){console.log(`Read ${1} vars from .env file for Hawser injection`);switch(options.connectionType){case"hawser-standard":case"hawser-edge":return {op,options,compose,envVars,secretVars,onLine};default:return {op,options,compose,envVars,secretVars,onLine}}}';
  fs.writeFileSync(path.join(build, 'server', 'stacks.js'), dispatcher);
  fs.writeFileSync(path.join(build, 'server', 'db.js'), 'const ns={getConfigSets:get};export{get as A};function get(){}');
  assert.equal(injectGlobalEnv(build, templatePath).patched, true);
  const source = fs.readFileSync(path.join(build, 'server', 'stacks.js'), 'utf8');
  assert.equal(injectGlobalEnv(build, templatePath).patched, false);
  assert.equal(fs.readFileSync(path.join(build, 'server', 'stacks.js'), 'utf8'), source);
  delete process.env.ZH_GLOBAL_ENV_CONFIG_SET;
  const native = vm.runInNewContext(source + ';native', { process, console: { log() {} } });
  const env = { APP_X: 'one' }, secret = { APP_Y: 'two' }, callback = () => {};
  const result = await native('up', options, 'original compose', env, secret, callback);
  assert.equal(result.envVars, env);
  assert.equal(result.secretVars, secret);
  assert.equal(result.onLine, callback);
  assert.equal(result.compose, 'original compose');
});

test('fail builds on missing/ambiguous dispatcher and changed signatures', () => {
  for (const [name, body] of [
    ['missing', 'export{};'],
    ['signature', 'async function changed(a,b){console.log(`Read ${1} vars from .env file for Hawser injection`);switch(b.connectionType){case"hawser-standard":case"hawser-edge":return null}}']
  ]) {
    const build = path.join(temporary, name);
    fs.mkdirSync(path.join(build, 'server'), { recursive: true });
    fs.writeFileSync(path.join(build, 'server', 'stacks.js'), body);
    assert.throws(() => injectGlobalEnv(build, templatePath));
  }
});

test('resolve official Rollup exports with spaces, newlines and shorthand, then call the real binding', async () => {
  const cases = [
    ['rollup', 'const ns={getConfigSets:get};export { other as a, get as bM, last as c };'],
    ['multiline', 'const ns={ getConfigSets : get };export {\n other as a,\n get\n as\n bM,\n last as c\n};'],
    ['shorthand', 'const ns={getConfigSets:get};export {other,get,last};'],
    ['dollar', 'const ns={getConfigSets:$get};export {other as a, $get as $bM, last as c};']
  ];
  for (const [name, bindings] of cases) {
    const build = path.join(temporary, name);
    const server = path.join(build, 'server');
    fs.mkdirSync(server, { recursive: true });
    fs.writeFileSync(path.join(build, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(server, 'stacks.js'), 'async function native(op,options,compose,envVars,secretVars,onLine){console.log(`Read ${1} vars from .env file for Hawser injection`);switch(options.connectionType){case"hawser-standard":case"hawser-edge":return secretVars;default:return secretVars}}export {native};');
    fs.writeFileSync(path.join(server, 'db.js'), 'const other=1,last=2;async function get(){return [{name:"全局变量",envVars:[{key:"TRAEFIK_DOMAIN",value:"official.test"}]}]};const $get=get;' + bindings);
    assert.equal(injectGlobalEnv(build, templatePath).patched, true);
    const { native } = await import(pathToFileURL(path.join(server, 'stacks.js')));
    process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
    const result = await native('up', { workingDir: build }, '', {}, {});
    assert.deepEqual(result, { TRAEFIK_DOMAIN: 'official.test' }, name);
    assert.equal(injectGlobalEnv(build, templatePath).patched, false);
  }
});

test('derive an escaped root-domain pattern for any number of explicit routers', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET = '全局变量';
  const values={TRAEFIK_DOMAINS:' EXAMPLE.com,example.net,third.example.org,example.com ',TRAEFIK_DOMAIN_REGEX:'stale-value'};
  const result=await apply(options,{},undefined,provider(values));
  assert.equal(result.TRAEFIK_DOMAIN_REGEX,'example[.]com|example[.]net|third[.]example[.]org');
  const web=new RegExp('^app[.]('+result.TRAEFIK_DOMAIN_REGEX+')$');
  const api=new RegExp('^app-api[.]('+result.TRAEFIK_DOMAIN_REGEX+')$');
  for(const domain of ['example.com','example.net','third.example.org']){
    assert.ok(web.test('app.'+domain));
    assert.ok(api.test('app-api.'+domain));
  }
  for(const host of ['app.exampleXcom','app.example.com.evil.test','app-api.example.com'])assert.equal(web.test(host),false);
  assert.equal(result.TRAEFIK_DOMAINS,values.TRAEFIK_DOMAINS);
});

test('reject malformed domain lists instead of accepting route expressions', async () => {
  process.env.ZH_GLOBAL_ENV_CONFIG_SET='全局变量';
  for(const value of ['',', ,','example.com|evil.test','-bad.example','bad..example','example.com,bad@evil']){
    await assert.rejects(apply(options,{},undefined,provider({TRAEFIK_DOMAINS:value})),/Invalid TRAEFIK_DOMAINS/);
  }
});

test('shared env file is read directly, refreshed, and never copied to project env', async () => {
  const file=path.join(temporary,'shared.env'),dir=fs.mkdtempSync(path.join(temporary,'file-app-'));
  process.env.ZH_GLOBAL_ENV_FILE=file;
  const own=path.join(dir,'.env');fs.writeFileSync(own,'APP_PORT=8080\n');
  try {
    fs.writeFileSync(file,"TRAEFIK_DOMAINS='example.test,example.net'\nTZ='Asia/Shanghai'\nPUID='1026'\nUMASK='000'\nLITERAL='$value'\n");
    const first=await apply({workingDir:dir},{},{},()=>{throw Error('must not read legacy DB')});
    assert.equal(first.PUID,'1026');assert.equal(first.UMASK,'000');assert.equal(first.LITERAL,'$value');
    assert.equal(first.TRAEFIK_DOMAIN_REGEX,'example[.]test|example[.]net');
    assert.equal(fs.readFileSync(own,'utf8'),'APP_PORT=8080\n');
    fs.writeFileSync(file,"TZ='UTC'\n");assert.equal((await apply({workingDir:dir},{},{},()=>[])).TZ,'UTC');
    fs.writeFileSync(file,'DOCKER_HOST=forbidden\n');await assert.rejects(apply({workingDir:dir},{},{},()=>[]),/reserved/);
    fs.unlinkSync(file);await assert.rejects(apply({workingDir:dir},{},{},()=>[]),/cannot be read/);
  } finally {delete process.env.ZH_GLOBAL_ENV_FILE;}
});
