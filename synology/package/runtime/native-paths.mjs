import fs from 'node:fs';
export const packageVar='/var/packages/DockhandNative/var';
export const defaultDataDir=packageVar+'/data';
export const defaultHome=packageVar+'/home';
export function runtimeConfigPath(env=process.env,exists=fs.existsSync){
 if(env.DOCKHAND_NATIVE_CONFIG)return env.DOCKHAND_NATIVE_CONFIG;
 const current=packageVar+'/config/runtime-env.json';
 if(exists(current))return current;
 const legacy='/volume1/docker/dockhand/native/runtime-env.json';
 return exists(legacy)?legacy:current;
}
