import fs from 'node:fs';
const url=process.env.PACKAGE_SOURCE_URL,key=process.env.PACKAGE_SOURCE_PUBLISH_KEY;
if(!url||!key){console.log('Package source publishing is not configured');process.exit(0);}
const endpoint=new URL('/_publish',url);if(endpoint.protocol!=='https:')throw Error('Package source must use HTTPS');
const body=fs.readFileSync(process.argv[2],'utf8');
const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'content-type':'application/json'},body,signal:AbortSignal.timeout(20000)});
if(!response.ok)throw Error('Package source update failed: HTTP '+response.status);
const result=await response.json();console.log(JSON.stringify({sourceUpdated:result.ok,packages:result.packages}));
