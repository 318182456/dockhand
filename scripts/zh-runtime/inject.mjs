#!/usr/bin/env node
/**
 * 镜像加速注入器 —— 在 overlay 镜像构建期执行(见 Dockerfile.zh)。
 * 仅包装服务端镜像拉取与 Stack 预拉取,界面翻译由上游原生提供。
 *
 * 用法: node inject.mjs <buildDir> <assetDir>
 *   buildDir — SvelteKit adapter-node 产物目录
 *   assetDir — 存放 registry-mirror.template.js 的目录
 */
import fs from 'node:fs';
import path from 'node:path';

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
	const call = 'await __zhComposePrepull(' + [op, pullPolicy, serviceName, arr, arr + '.__zhBase', cwd, envVar,
		stdinFlag + '?' + stdinContent + ':null', logPrefix, progress].join(',') + ');';
	// 先改后面的 spawn 处,再改前面的 push 处,避免下标偏移
	s = s.slice(0, spawnHits[0].index) + call + s.slice(spawnHits[0].index);
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

// ---- 3) 启动时安装更新检查加速,先于 scheduler/hook 等入口捕获全局 fetch ----
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
