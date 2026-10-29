#!/usr/bin/env node
/**
 * 镜像加速注入器 —— 在 overlay 镜像构建期执行(见 Dockerfile.zh)。
 * 包装服务端镜像拉取、Stack 预拉取及日志进度行,界面翻译由上游原生提供。
 *
 * 用法: node inject.mjs <buildDir> <assetDir>
 *   buildDir — SvelteKit adapter-node 产物目录
 *   assetDir — 存放 registry-mirror.template.js 的目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const [, , buildDir, assetDir] = process.argv;
if (!buildDir || !assetDir) {
	console.error('用法: node inject.mjs <buildDir> <assetDir>');
	process.exit(1);
}

function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

// ---- 1) 镜像加速:包装 server 端 dockerFetch ----
// server 产物是压缩过的,函数名不可依赖;以函数开头的路径穿越守卫为指纹定位 dockerFetch:
//   async function C(e,n={},t){if(e.includes(".."))throw new Error("Invalid Docker API path");
// 把原函数改名为 C__zhOrig,再追加同名包装函数(函数声明会提升,chunk 内调用与 export 都自动指向包装)。
const FETCH_RE = /async function ([\w$]+)\(([\w$]+),([\w$]+)=\{\},([\w$]+)\)\{if\(\2\.includes\("\.\."\)\)throw new Error\("Invalid Docker API path"\)/g;
const MIRROR_MARK = '__zhMirrorFetch';
const mirrorJs = fs.readFileSync(path.join(assetDir, 'registry-mirror.template.js'), 'utf8');

let mirrorPatched = 0;
for (const file of walk(path.join(buildDir, 'server'))) {
	if (!file.endsWith('.js')) continue;
	let s = fs.readFileSync(file, 'utf8');
	if (!s.includes('Invalid Docker API path')) continue;
	if (s.includes(MIRROR_MARK)) { mirrorPatched++; continue; } // 幂等
	const hits = [...s.matchAll(FETCH_RE)];
	if (hits.length !== 1) {
		console.error('错误: ' + path.relative(buildDir, file) + ' 中 dockerFetch 指纹命中 ' + hits.length + ' 次,必须恰好 1 次');
		process.exit(1);
	}
	const name = hits[0][1];
	const orig = name + '__zhOrig';
	if (s.includes(orig)) {
		console.error('错误: 标识符 ' + orig + ' 已存在,无法安全改名');
		process.exit(1);
	}
	s = s.slice(0, hits[0].index) + hits[0][0].replace('async function ' + name + '(', 'async function ' + orig + '(') +
		s.slice(hits[0].index + hits[0][0].length);
	s += '\n;async function ' + name + '(p,o={},e){return __zhMirrorFetch(' + orig + ',p,o,e)}\n' + mirrorJs;
	fs.writeFileSync(file, s);
	console.log('已注入镜像加速: ' + path.relative(buildDir, file) + '(dockerFetch = ' + name + ')');
	mirrorPatched++;
}

if (mirrorPatched !== 1) {
	console.error('错误: 镜像加速补丁命中 ' + mirrorPatched + ' 个文件,预期恰好 1 个(上游产物结构可能已变化)');
	process.exit(1);
}

// ---- 2) 镜像加速:Stack 部署前预拉取 ----
// docker compose 自行拉取镜像,不经过 dockerFetch。在本地 compose 执行函数 spawn 之前插入预拉取调用。
// 两处指纹(压缩后变量名以捕获组取得):
//   k.push(...si(t,{forceRecreate:i,removeVolumes:l,build:h,noBuildCache:g,pullPolicy:w,serviceName:p}))
//     → 记下操作参数之前的长度 k.__zhBase,并取得 op/pullPolicy/serviceName 变量名
//   try{console.log(`${$} Spawning docker compose process from ${C}: ${k.join(" ")}`);const I=spawn(k[0],k.slice(1),{cwd:C,env:_,stdio:[x?"pipe":"inherit",...]});x&&I.stdin&&(I.stdin.write(D)
//     → 取得 日志前缀/cwd/env/是否 stdin/compose 内容 变量名,在 try 前插入 await __zhComposePrepull(...)
const PUSH_RE = /([\w$]+)\.push\(\.\.\.[\w$]+\(([\w$]+),\{forceRecreate:[\w$]+,removeVolumes:[\w$]+,build:[\w$]+,noBuildCache:[\w$]+,pullPolicy:([\w$]+),serviceName:([\w$]+)\}\)\)/g;
const SPAWN_RE = /try\{console\.log\(`\$\{([\w$]+)\} Spawning docker compose process from \$\{([\w$]+)\}: \$\{([\w$]+)\.join\(" "\)\}`\);const ([\w$]+)=[\w$]+\(\3\[0\],\3\.slice\(1\),\{cwd:\2,env:([\w$]+),stdio:\[([\w$]+)\?"pipe":"inherit","pipe","pipe"\]\}\);\6&&\4\.stdin&&\(\4\.stdin\.write\(([\w$]+)\)/g;
const PREPULL_MARK = '__zhComposePrepull(';
// collectProcess(proc, onLine ? makeLineForwarder(onLine, secrets) : undefined)
// 使用上游同一脱敏器和 envVars/secretVars,不能把携带 HOME/PATH 的 spawnEnv 当成敏感值表。
const FORWARD_RE = /(?:const|let|var) ([\w$]+)=(\[\.\.\.Object\.values\([\w$]+\?\?\{\}\),\.\.\.Object\.values\([\w$]+\?\?\{\}\)\]\.filter\(([\w$]+)=>typeof \3={2,3}"string"\)),\{exitCode:[\w$]+,stdout:[\w$]+,stderr:[\w$]+\}=await [\w$]+\(([\w$]+),([\w$]+)\?([\w$]+)\(\5,\1\):(?:void 0|undefined)\)/g;

let prepullPatched = 0;
for (const file of walk(path.join(buildDir, 'server'))) {
	if (!file.endsWith('.js')) continue;
	let s = fs.readFileSync(file, 'utf8');
	if (!s.includes('Spawning docker compose process from')) continue;
	if (s.includes('await ' + PREPULL_MARK)) { prepullPatched++; continue; } // 幂等
	const pushHits = [...s.matchAll(PUSH_RE)];
	const spawnHits = [...s.matchAll(SPAWN_RE)];
	if (pushHits.length !== 1 || spawnHits.length !== 1) {
		console.error('错误: ' + path.relative(buildDir, file) + ' 中 compose 指纹命中 push=' + pushHits.length +
			' spawn=' + spawnHits.length + ' 次,必须各恰好 1 次');
		process.exit(1);
	}
	const [, arr, op, pullPolicy, serviceName] = pushHits[0];
	const [, logPrefix, cwd, argsVar, proc, envVar, stdinFlag, stdinContent] = spawnHits[0];
	if (arr !== argsVar || pushHits[0].index > spawnHits[0].index) {
		console.error('错误: compose 指纹不一致(push 数组 ' + arr + ' / spawn 参数 ' + argsVar + '),拒绝注入');
		process.exit(1);
	}
	const forwards = [...s.slice(spawnHits[0].index).matchAll(FORWARD_RE)].filter((hit) => hit[4] === proc);
	if (forwards.length !== 1) {
		console.error('错误: ' + path.relative(buildDir, file) + ' 中 compose 脱敏进度回调指纹命中 ' + forwards.length +
			' 次,必须恰好 1 次,拒绝注入不可见或未脱敏的预拉取');
		process.exit(1);
	}
	const [, , secretsExpression, , , onLine, forwarder] = forwards[0];
	const progress = onLine + '?' + forwarder + '(' + onLine + ',' + secretsExpression + '):void 0';
	const call = 'const __zhPrepullResult=await __zhComposePrepull(' + [op, pullPolicy, serviceName, arr, arr + '.__zhBase', cwd, envVar,
		stdinFlag + '?' + stdinContent + ':null', logPrefix, progress].join(',') + ');' +
		'if(__zhPrepullResult&&__zhPrepullResult.skipCompose)return{success:true,output:__zhPrepullResult.output,command:' + arr + '.join(" "),exitCode:0};';
	// 先改后面的 spawn 处,再改前面的 push 处,避免下标偏移
	s = s.slice(0, spawnHits[0].index) + 'try{' + call + s.slice(spawnHits[0].index + 'try{'.length);
	s = s.slice(0, pushHits[0].index) + arr + '.__zhBase=' + arr + '.length,' + s.slice(pushHits[0].index);
	// 若与 dockerFetch 同处一个 chunk,模板已追加过;重复的顶层函数声明在 ESM 中是语法错误
	if (!s.includes('function __zhMirrorTable(')) s += '\n' + mirrorJs;
	fs.writeFileSync(file, s);
	console.log('已注入 Stack 预拉取: ' + path.relative(buildDir, file));
	prepullPatched++;
}

if (prepullPatched !== 1) {
	console.error('错误: Stack 预拉取补丁命中 ' + prepullPatched + ' 个文件,预期恰好 1 个(上游产物结构可能已变化)');
	process.exit(1);
}

// ---- 3) 自更新使用独立的本机 Docker streaming 请求,不经过 dockerFetch ----
// 只在自更新 route 中定位 pullImageLocal 的调用,不改变普通 Docker 环境的选择。
const SELF_PULL_RE = /await ([\w$]+)\(`\/images\/create\?fromImage=\$\{encodeURIComponent\([\w$]+\)\}&tag=\$\{encodeURIComponent\([\w$]+\)\}`,/g;
let selfUpdatePatched = 0;
for (const file of walk(path.join(buildDir, 'server'))) {
	if (!file.endsWith('.js')) continue;
	let s = fs.readFileSync(file, 'utf8');
	if (!s.includes('[SelfUpdate]') || !s.includes('pulling_updater')) continue;
	if (s.includes('/* __zhSelfUpdateMirror */')) { selfUpdatePatched++; continue; }
	const hits = [...s.matchAll(SELF_PULL_RE)];
	if (hits.length !== 1) {
		console.error('错误: ' + path.relative(buildDir, file) + ' 中自更新拉取指纹命中 ' + hits.length + ' 次,预期 1 次');
		process.exit(1);
	}
	const name = hits[0][1];
	const decl = new RegExp('function ' + name.replace(/\$/g, '\\$') + '\\([\\w$]+,[\\w$]+=\\{\\}\\)\\{', 'g');
	const declarations = [...s.matchAll(decl)];
	const pullFunctions = [...s.matchAll(/async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{/g)].filter((hit) => {
		const body = logFunctionBody(s, hit.index);
		return hit.index < hits[0].index && hit.index + body.length > hits[0].index;
	});
	if (declarations.length !== 1 || !logFunctionBody(s, declarations[0].index + declarations[0][0].length - 1).includes('process.env.DOCKER_SOCKET') ||
		pullFunctions.length !== 1 || s.includes(name + '__zhLocalOrig')) {
		console.error('错误: 自更新本机 streaming 请求函数结构已变化,拒绝注入');
		process.exit(1);
	}
	const pull = pullFunctions[0];
	const pullBody = logFunctionBody(s, pull.index);
	const authCalls = [...pullBody.matchAll(new RegExp('await ([\\w$]+)\\(' + pull[2].replace(/\$/g, '\\$') + '\\)', 'g'))];
	if (authCalls.length !== 1) {
		console.error('错误: 自更新凭据函数指纹已变化,拒绝注入');
		process.exit(1);
	}
	s = s.slice(0, pull.index) + 'async function ' + pull[1] + '(image,onProgress){return __zhSelfUpdatePull(' +
		name + ',' + authCalls[0][1] + ',image,onProgress)}' + s.slice(pull.index + pullBody.length);
	// 替换拉取解析器后重新定位,避免函数排列顺序变化造成偏移。
	decl.lastIndex = 0;
	const at = decl.exec(s).index;
	s = s.slice(0, at) + s.slice(at).replace('function ' + name + '(', 'function ' + name + '__zhLocalOrig(');
	// 原本机 streaming 请求也能读取 inspect/tag 等响应;不借用受环境选择影响的 dockerFetch。
	// 独立清理 scope 防止覆盖普通 API 的 default 环境适配器。
	s += '\n/* __zhSelfUpdateMirror */\nfunction ' + name + '(p,o={}){return __zhMirrorFetch(' +
		name + '__zhLocalOrig,p,o,"self-update-local")}\n';
	if (!s.includes('function __zhMirrorTable(')) s += '\n' + mirrorJs;
	fs.writeFileSync(file, s);
	console.log('已注入自更新镜像加速: ' + path.relative(buildDir, file));
	selfUpdatePatched++;
}
if (selfUpdatePatched !== 1) {
	console.error('错误: 自更新镜像加速命中 ' + selfUpdatePatched + ' 个文件,预期 1 个');
	process.exit(1);
}

// ---- 4) 启动时安装更新检查加速,先于 scheduler/hook 等入口捕获全局 fetch ----
// 仅在 dockerFetch chunk 末尾安装会依赖该 chunk 的首次加载时机。
// 官方 server.js 直接导入 handler.js,不会经过 adapter-node 的 index.js。
// 两个入口都先导入 runtime,确保独立的 registry 模块也经过同一包装。
const runtimeImport = "import './zh-registry-runtime.js';";
if (!fs.existsSync(path.join(buildDir, 'handler.js'))) {
	console.error('错误: adapter-node 入口 handler.js 不存在,无法保证更新检查补丁的加载顺序');
	process.exit(1);
}
fs.writeFileSync(path.join(buildDir, 'zh-registry-runtime.js'), mirrorJs);
for (const entryName of ['handler.js', 'index.js']) {
	const entryFile = path.join(buildDir, entryName);
	if (!fs.existsSync(entryFile)) continue;
	const entry = fs.readFileSync(entryFile, 'utf8');
	if (!entry.includes(runtimeImport)) {
		const shebang = /^(#![^\n]*\n)/.exec(entry);
		const offset = shebang ? shebang[0].length : 0;
		fs.writeFileSync(entryFile, entry.slice(0, offset) + runtimeImport + '\n' + entry.slice(offset));
	}
	console.log('已注入更新检查启动补丁: ' + entryName);
}

// ---- 5) 日志按镜像层原地刷新;同一处理也用于复制和下载日志 ----
const progressJs = fs.readFileSync(path.join(assetDir, 'pull-progress.template.js'), 'utf8');
const LOG_LINES_RE = /function ([\w$]+)\(([\w$]+)\)\{return \2\.split\((?:"\\n"|'\\n'|`(?:\\n|\r?\n)`)\)\.map\(/g;
function logFunctionBody(source, start) {
	let depth = 0, quote = '', escaped = false;
	for (let i = source.indexOf('{', start); i < source.length; i++) {
		const c = source[i];
		if (quote) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === quote) quote = '';
			continue;
		}
		if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
	}
	return '';
}
let clientLogPatched = 0;
const clientLogRoles = new Set();
for (const file of walk(buildDir)) {
	if (!file.endsWith('.js')) continue;
	let s = fs.readFileSync(file, 'utf8');
	if (!s.includes('@@git@@ ')) continue;
	const isClient = path.relative(buildDir, file).split(path.sep)[0] === 'client';
	const gitMarker = /(?:(?:const|let|var) |,)([\w$]+)=["']@@git@@ ["']/.exec(s);
	const hits = [...s.matchAll(LOG_LINES_RE)].filter((hit) => {
		const body = logFunctionBody(s, hit.index);
		return gitMarker && body.includes('.startsWith(' + gitMarker[1] + ')') && body.includes('.slice(' + gitMarker[1] + '.length)');
	});
	// SSR 会裁剪复制/下载按钮使用的纯文本格式化器,也可能把两个函数拆到不同 chunk。
	// 按保留的函数分别包装,在全部客户端 chunk 扫描结束后检查功能覆盖。
	if (!hits.length) continue;
	if (isClient) {
		for (const hit of hits) {
			clientLogRoles.add(logFunctionBody(s, hit.index).includes('log-line') ? 'html' : 'text');
		}
	}
	if (s.includes('function __zhCompactPullLines(')) { if (isClient) clientLogPatched++; continue; }
	for (const hit of hits.slice().reverse()) {
		const name = hit[1];
		if (s.includes(name + '__zhOrig')) throw new Error('日志包装标识符冲突: ' + name);
		s = s.slice(0, hit.index) + hit[0].replace('function ' + name + '(', 'function ' + name + '__zhOrig(') + s.slice(hit.index + hit[0].length);
	}
	for (const hit of hits) s += '\nfunction ' + hit[1] + '(text){return ' + hit[1] + '__zhOrig(__zhCompactPullLines(text))}\n';
	s += '\n' + progressJs;
	fs.writeFileSync(file, s);
	if (isClient) clientLogPatched++;
	console.log('已注入镜像层原地刷新: ' + path.relative(buildDir, file));
}
if (!clientLogPatched || !clientLogRoles.has('html') || !clientLogRoles.has('text')) {
	console.error('错误: 客户端日志格式化器覆盖不完整(显示/复制下载),拒绝构建无法完整刷新进度的镜像');
	process.exit(1);
}

// 自更新弹窗直接维护 step.logs 数组,不经过共享日志格式化器。
const SELF_LOG_RE = /([\w$]+)\.logs=\[\.\.\.\1\.logs,([\w$]+)\],\1\.showLogs=(?:!0|true)/g;
let selfLogPatched = 0;
for (const file of walk(path.join(buildDir, 'client'))) {
	if (!file.endsWith('.js')) continue;
	let s = fs.readFileSync(file, 'utf8');
	if (!s.includes('/api/self-update') || !s.includes('pulling_updater')) continue;
	if (s.includes('/* __zhSelfUpdateLog */')) { selfLogPatched++; continue; }
	const hits = [...s.matchAll(SELF_LOG_RE)];
	if (hits.length !== 1) {
		console.error('错误: 自更新日志数组指纹命中 ' + hits.length + ' 次,预期 1 次');
		process.exit(1);
	}
	s = s.replace(SELF_LOG_RE, '$1.logs=__zhAppendPullLog($1,$2),$1.showLogs=!0');
	if (!s.includes('function __zhAppendPullLog(')) s += '\n' + progressJs;
	s += '\n/* __zhSelfUpdateLog */\n';
	fs.writeFileSync(file, s);
	selfLogPatched++;
	console.log('已注入自更新日志原地刷新: ' + path.relative(buildDir, file));
}
if (selfLogPatched !== 1) {
	console.error('错误: 自更新日志补丁命中 ' + selfLogPatched + ' 个客户端文件,预期 1 个');
	process.exit(1);
}

// 内容哈希文件不能原名覆盖:浏览器可能已永久缓存旧版本。更新所有 JS 资产名称及其引用。
const cacheTag = createHash('sha256').update(mirrorJs + progressJs).digest('hex').slice(0, 12);
const clientDir = path.join(buildDir, 'client');
const renames = [];
const names = new Map();
const clientPaths = new Map();
for (const file of walk(clientDir)) {
	if (!file.endsWith('.js')) continue;
	const relativeClient = path.relative(clientDir, file).split(path.sep).join('/');
	if (!relativeClient.includes('/immutable/')) continue;
	const name = path.basename(file);
	const prior = /\.zh([a-f0-9]{12})\.js$/.exec(name);
	if (prior) {
		if (prior[1] !== cacheTag) throw new Error('请从未注入补丁的上游产物重新构建');
		continue;
	}
	const renamed = name.slice(0, -3) + '.zh' + cacheTag + '.js';
	names.set(name, renamed);
	clientPaths.set(relativeClient, relativeClient.slice(0, -name.length) + renamed);
	renames.push([file, path.join(path.dirname(file), renamed)]);
}
if (names.size) {
	const references = (values) => new RegExp([...values].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
	const referenceRe = references(names.keys());
	const serverReferenceRe = references(clientPaths.keys());
	for (const file of walk(buildDir)) {
		if (!/\.(js|json|css|html|map)$/.test(file)) continue;
		const previous = fs.readFileSync(file, 'utf8');
		const isClient = path.relative(buildDir, file).split(path.sep)[0] === 'client';
		// 服务端可能有同名 chunk,只改完整客户端资产路径,不改其自身的相对模块引用。
		const next = isClient ? previous.replace(referenceRe, (name) => names.get(name)) :
			previous.replace(serverReferenceRe, (name) => clientPaths.get(name));
		// 被修改的日志 chunk 也可能已经有旧压缩副本,即使其引用没有变化也要刷新。
		if (next !== previous) fs.writeFileSync(file, next);
		if (fs.existsSync(file + '.gz')) fs.writeFileSync(file + '.gz', gzipSync(next));
		if (fs.existsSync(file + '.br')) fs.writeFileSync(file + '.br', brotliCompressSync(next));
	}
	for (const [before, after] of renames) {
		for (const suffix of ['', '.gz', '.br', '.map', '.map.gz', '.map.br']) {
			if (fs.existsSync(before + suffix)) fs.renameSync(before + suffix, after + suffix);
		}
	}
}
console.log('客户端缓存版本: ' + cacheTag);
