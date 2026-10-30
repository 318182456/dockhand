import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {applyPatch} from './prepare.mjs';
const env=process.env,repo=env.GITHUB_REPOSITORY;
if(repo!=='318182456/dockhand')throw Error('Unexpected repository');
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8'});
const api=(p,body,method)=>JSON.parse(gh('api','repos/'+repo+'/'+p,...(method?['--method',method]:[]),...(body?['--input','-']:[]))||'{}');
function request(p,body,method='POST'){return JSON.parse(execFileSync('gh',['api','repos/'+repo+'/'+p,'--method',method,'--input','-'],{encoding:'utf8',input:JSON.stringify(body)})||'{}');}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'});
const patch=fs.readFileSync(env.ADAPT_PATCH,'utf8');if(!patch.trim()){console.log('No source changes are necessary; nothing to publish.');process.exit(0);}
if(!/^auto-adapt\/v\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/.test(env.ADAPT_BRANCH||''))throw Error('Invalid branch');
if(!/^[0-9a-f]{40}$/.test(env.ADAPT_BASE||'')||git('rev-parse','HEAD').trim()!==env.ADAPT_BASE)throw Error('Baseline mismatch');
if(api('git/ref/heads/main').object.sha!==env.ADAPT_BASE)throw Error('Main changed during adaptation; refusing a stale merge');
applyPatch(patch);
const names=git('diff','--name-only','HEAD').trim().split('\n');
const baseCommit=api('git/commits/'+env.ADAPT_BASE);
const tree=request('git/trees',{base_tree:baseCommit.tree.sha,tree:names.map(p=>({path:p,mode:'100644',type:'blob',content:fs.readFileSync(p,'utf8')}))});
const commit=request('git/commits',{message:'fix: adapt overlay to upstream '+env.ADAPT_VERSION,tree:tree.sha,parents:[env.ADAPT_BASE]});
request('git/refs',{ref:'refs/heads/'+env.ADAPT_BRANCH,sha:commit.sha});
let verdict={approved:false,reason:'Review did not complete successfully.'};if(fs.existsSync(env.ADAPT_REVIEW))verdict=JSON.parse(fs.readFileSync(env.ADAPT_REVIEW,'utf8'));
const approved=env.VALIDATE_RESULT==='success'&&env.REVIEW_RESULT==='success'&&verdict.approved===true;
const evidence='https://github.com/'+repo+'/actions/runs/'+env.GITHUB_RUN_ID;
const body='修复上游 '+env.ADAPT_VERSION+' 与现有镜像加速/全局变量补丁的兼容问题。\n\n- 原始失败运行：https://github.com/'+repo+'/actions/runs/'+env.ADAPT_FAILED_RUN+'\n- 完整镜像构建与原有回归测试：'+env.VALIDATE_RESULT+'\n- 独立 Gemini 审核：'+env.REVIEW_RESULT+'\n- 审核意见：'+String(verdict.reason).slice(0,6000)+'\n- 本次检查：'+evidence+'\n\n仅在构建、测试和独立审核均通过后自动合并，再触发镜像及 SPK 发布。';
const pr=request('pulls',{title:'fix: 自动适配上游 '+env.ADAPT_VERSION,head:env.ADAPT_BRANCH,base:'main',body,draft:!approved});
console.log('PR created: '+pr.html_url);
if(!approved){console.log('Validation/review did not pass; draft PR retained without release.');process.exit(0);}
// These are the exact checks for the generated commit. No edited code executes in this write-token job.
request('statuses/'+commit.sha,{state:'success',context:'compatibility/full-build-and-tests',description:'Original regressions and complete official-image overlay build passed',target_url:evidence});
request('statuses/'+commit.sha,{state:'success',context:'compatibility/independent-review',description:'Independent Gemini review approved the exact proposed patch',target_url:evidence});
if(api('git/ref/heads/main').object.sha!==env.ADAPT_BASE)throw Error('Main changed before merge; PR retained');
const merged=request('pulls/'+pr.number+'/merge',{sha:commit.sha,merge_method:'squash',commit_title:'fix: 自动适配上游 '+env.ADAPT_VERSION},'PUT');
if(!merged.merged)throw Error('PR was not merged; no release dispatched');
request('actions/workflows/sync-and-publish.yml/dispatches',{ref:'main'});
console.log('PR merged and image publish dispatched; the native SPK workflow follows successful image publishing.');