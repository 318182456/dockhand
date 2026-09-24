#!/usr/bin/env node
/**
 * 运行时中文化注入器 —— 在 overlay 镜像构建期执行(见 Dockerfile.zh),不修改上游源码。
 *
 * 1. 将 translation-dict.json 内嵌进 translator.template.js,生成 build/client/zh-translate.js
 *    (build/client 由 adapter-node 的 handler 按站点根路径伺服,即 /zh-translate.js)
 * 2. 在含 SSR HTML 模板的 server chunk(以 app.html 的 data-sveltekit-preload-data 为指纹)
 *    的 </head> 前插入 <script defer src=/zh-translate.js></script>。
 *    注入片段刻意不含引号/反斜杠/反引号/${,可安全嵌入任意 JS 字符串字面量上下文。
 * 3. 包装 server 端 dockerFetch,拉取镜像时自动改走国内镜像站(见 registry-mirror.template.js)。
 *
 * 用法: node inject.mjs <buildDir> <assetDir>
 *   buildDir — SvelteKit adapter-node 产物目录(含 client/ server/ handler.js)
 *   assetDir — 存放 dict.json、translator.template.js、registry-mirror.template.js 的目录
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , buildDir, assetDir] = process.argv;
if (!buildDir || !assetDir) {
	console.error('用法: node inject.js <buildDir> <assetDir>');
	process.exit(1);
}

const TAG = '<script defer src=/zh-translate.js></script>';
const MARK = 'zh-translate.js';

// ---- 1) 生成客户端翻译脚本 ----
const dictRaw = fs.readFileSync(path.join(assetDir, 'dict.json'), 'utf8').trim();
JSON.parse(dictRaw); // 仅校验合法性
const template = fs.readFileSync(path.join(assetDir, 'translator.template.js'), 'utf8');
const PLACEHOLDER = '__DICT_' + 'JSON__'; // 拼接书写,避免本文件自身成为误替换目标
const occurrences = template.split(PLACEHOLDER).length - 1;
if (occurrences !== 1) {
	// 曾经踩过:模板注释里也写了占位符,replace 命中注释导致 DICT 未定义、翻译器静默失效
	console.error('错误: 模板中占位符出现 ' + occurrences + ' 次,必须且只能出现 1 次');
	process.exit(1);
}
// split/join 而非 replace:避免字典内容中的 $ 序列被当作替换模式解释
const clientJs = template.split(PLACEHOLDER).join(dictRaw);
if (clientJs.includes(PLACEHOLDER) || !clientJs.includes('var DICT = {')) {
	console.error('错误: 字典未能正确注入 DICT 变量');
	process.exit(1);
}

const clientDir = path.join(buildDir, 'client');
if (!fs.existsSync(clientDir)) {
	console.error('错误: 未找到 ' + clientDir + ',请确认 buildDir 是否正确');
	process.exit(1);
}
fs.writeFileSync(path.join(clientDir, 'zh-translate.js'), clientJs);
console.log('已生成 client/zh-translate.js(字典 ' + Object.keys(JSON.parse(dictRaw)).length + ' 条)');

// ---- 2) 给 SSR HTML 模板打注入补丁 ----
function* walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

let patched = 0;
for (const file of walk(buildDir)) {
	// client 目录是纯静态资源,模板只在 server 侧
	if (file.startsWith(clientDir + path.sep)) continue;
	if (!/\.(js|mjs|cjs|html)$/.test(file)) continue;
	let s = fs.readFileSync(file, 'utf8');
	if (!s.includes('</head>')) continue;
	// 指纹校验:必须真的是 app 的 HTML 模板,防止误伤其它含 </head> 字样的代码
	if (!s.includes('data-sveltekit-preload-data') && !/<!doctype html/i.test(s)) continue;
	if (s.includes(MARK)) { patched++; continue; } // 幂等:已注入则跳过
	s = s.split('</head>').join(TAG + '</head>');
	fs.writeFileSync(file, s);
	console.log('已注入 script 标签: ' + path.relative(buildDir, file));
	patched++;
}

if (patched === 0) {
	console.error('错误: 未在任何 server 产物中找到 SSR HTML 模板,注入失败(上游产物结构可能已变化)');
	process.exit(1);
}
console.log('注入完成,共命中 ' + patched + ' 个文件');

// ---- 3) 镜像加速:包装 server 端 dockerFetch ----
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

// ---- 4) 镜像加速:Stack 部署前预拉取 ----
// docker compose 自行拉取镜像,不经过 dockerFetch。在本地 compose 执行函数 spawn 之前插入预拉取调用。
// 两处指纹(压缩后变量名以捕获组取得):
//   k.push(...si(t,{forceRecreate:i,removeVolumes:l,build:h,noBuildCache:g,pullPolicy:w,serviceName:p}))
//     → 记下操作参数之前的长度 k.__zhBase,并取得 op/pullPolicy/serviceName 变量名
//   try{console.log(`${$} Spawning docker compose process from ${C}: ${k.join(" ")}`);const I=spawn(k[0],k.slice(1),{cwd:C,env:_,stdio:[x?"pipe":"inherit",...]});x&&I.stdin&&(I.stdin.write(D)
//     → 取得 日志前缀/cwd/env/是否 stdin/compose 内容 变量名,在 try 前插入 await __zhComposePrepull(...)
const PUSH_RE = /([\w$]+)\.push\(\.\.\.[\w$]+\(([\w$]+),\{forceRecreate:[\w$]+,removeVolumes:[\w$]+,build:[\w$]+,noBuildCache:[\w$]+,pullPolicy:([\w$]+),serviceName:([\w$]+)\}\)\)/g;
const SPAWN_RE = /try\{console\.log\(`\$\{([\w$]+)\} Spawning docker compose process from \$\{([\w$]+)\}: \$\{([\w$]+)\.join\(" "\)\}`\);const ([\w$]+)=[\w$]+\(\3\[0\],\3\.slice\(1\),\{cwd:\2,env:([\w$]+),stdio:\[([\w$]+)\?"pipe":"inherit","pipe","pipe"\]\}\);\6&&\4\.stdin&&\(\4\.stdin\.write\(([\w$]+)\)/g;
const PREPULL_MARK = '__zhComposePrepull(';

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
	const [, logPrefix, cwd, argsVar, , envVar, stdinFlag, stdinContent] = spawnHits[0];
	if (arr !== argsVar || pushHits[0].index > spawnHits[0].index) {
		console.error('错误: compose 指纹不一致(push 数组 ' + arr + ' / spawn 参数 ' + argsVar + '),拒绝注入');
		process.exit(1);
	}
	const call = 'await __zhComposePrepull(' + [op, pullPolicy, serviceName, arr, arr + '.__zhBase', cwd, envVar,
		stdinFlag + '?' + stdinContent + ':null', logPrefix].join(',') + ');';
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
