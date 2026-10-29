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
after(() => {
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
