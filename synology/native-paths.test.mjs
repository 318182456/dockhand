import test from 'node:test';import assert from 'node:assert/strict';import {runtimeConfigPath,defaultDataDir,defaultHome,packageVar} from './package/runtime/native-paths.mjs';
test('package paths are preferred and existing legacy installs retain a bounded fallback',()=>{
 assert.equal(runtimeConfigPath({},()=>true),packageVar+'/config/runtime-env.json');
 assert.equal(runtimeConfigPath({},p=>p.startsWith('/volume1/docker/dockhand/')),'/volume1/docker/dockhand/native/runtime-env.json');
 assert.equal(runtimeConfigPath({},()=>false),packageVar+'/config/runtime-env.json');
 assert.equal(runtimeConfigPath({DOCKHAND_NATIVE_CONFIG:'/private/fixture'},()=>true),'/private/fixture');
 assert.equal(defaultDataDir,packageVar+'/data');assert.equal(defaultHome,packageVar+'/home');
});
