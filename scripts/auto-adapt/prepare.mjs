import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {editable,checkDiff,safeFile} from './agent.mjs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'});
export function inspectPatch(patch,root=process.cwd()){
 if(typeof patch!=='string'||Buffer.byteLength(patch)>160000)throw Error('Patch exceeds size limit');
 if(!patch.trim())return [];
 const result=execFileSync('git',['apply','--numstat','-z','-'],{cwd:root,input:patch,encoding:'utf8'}).split('\0').filter(Boolean);
 if(result.length>8)throw Error('Patch changes too many files');
 for(const row of result){const [added,removed,p,...rest]=row.split('\t');if(rest.length||!/^\d+$/.test(added)||!/^\d+$/.test(removed)||!editable(p))throw Error('Patch scope rejected');safeFile(root,p,true);}
 const summary=execFileSync('git',['apply','--summary','-'],{cwd:root,input:patch,encoding:'utf8'});if(summary.trim())throw Error('File creation, deletion, rename and mode changes are forbidden');
 execFileSync('git',['apply','--check','-'],{cwd:root,input:patch,encoding:'utf8'});return result;
}
export function applyPatch(patch,root=process.cwd()){
 inspectPatch(patch,root);if(!patch.trim())return false;
 execFileSync('git',['apply','-'],{cwd:root,input:patch,encoding:'utf8'});checkDiff(root);return true;
}
async function main(){
 if(process.argv[2]==='apply'){applyPatch(fs.readFileSync(process.env.ADAPT_PATCH,'utf8'));return;}
 const env=process.env,repo=env.GITHUB_REPOSITORY;if(!repo||!/^318182456\/dockhand$/.test(repo))throw Error('Unexpected repository');
 const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8',maxBuffer:12000000});const api=p=>JSON.parse(gh('api','repos/'+repo+'/'+p));
 const mode=env.GITHUB_EVENT_NAME==='workflow_run'?'repair':env.REQUEST_MODE||'smoke';if(!['repair','smoke'].includes(mode))throw Error('Invalid mode');
 let version=fs.readFileSync('VERSION','utf8').trim(),run='',log='';
 if(mode==='repair'){
  run=env.EVENT_RUN||env.REQUEST_RUN;if(!/^\d+$/.test(run||''))throw Error('A failed run ID is required');
  const r=api('actions/runs/'+run);
  if(r.name!=='Sync and Publish Docker'||r.head_branch!=='main'||r.head_repository?.full_name!==repo||r.conclusion!=='failure')throw Error('Only a failed trusted main-branch publish run may be repaired');
  log=gh('run','view',run,'--repo',repo,'--log-failed').replace(/\x1b\[[0-9;]*m/g,'');
  const versions=[...new Set([...log.matchAll(/fnsys\/dockhand:(v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*)/g)].map(m=>m[1]))];
  if(versions.length!==1)throw Error('Could not identify exactly one upstream version in failed build');version=versions[0];
 }
 if(!/^v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/.test(version))throw Error('Invalid upstream version');
 const base=git('rev-parse','HEAD').trim(),branch='auto-adapt/'+version;
 const pulls=mode==='repair'?api('pulls?state=all&head='+encodeURIComponent(repo.split('/')[0]+':'+branch)+'&per_page=100'):[];
 const active=!pulls.length;
 fs.writeFileSync(path.join(env.RUNNER_TEMP,'adapt-context.json'),JSON.stringify({version,run,base,log:log.slice(-50000)}));
 fs.appendFileSync(env.GITHUB_OUTPUT,Object.entries({mode,version,base,branch,run,active:String(active)}).map(([k,v])=>k+'='+v).join('\n')+'\n');
 console.log(active?'Compatibility plan ready for '+version:'An adaptation PR already exists for this upstream version; skipping duplicate model calls.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});