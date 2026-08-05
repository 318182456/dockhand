#!/usr/bin/env node
/**
 * 运行时中文化注入器 —— 在 overlay 镜像构建期执行(见 Dockerfile.zh),不修改上游源码。
 *
 * 1. 将 translation-dict.json 内嵌进 translator.template.js,生成 build/client/zh-translate.js
 *    (build/client 由 adapter-node 的 handler 按站点根路径伺服,即 /zh-translate.js)
 * 2. 在含 SSR HTML 模板的 server chunk(以 app.html 的 data-sveltekit-preload-data 为指纹)
 *    的 </head> 前插入 <script defer src=/zh-translate.js></script>。
 *    注入片段刻意不含引号/反斜杠/反引号/${,可安全嵌入任意 JS 字符串字面量上下文。
 *
 * 用法: node inject.mjs <buildDir> <assetDir>
 *   buildDir — SvelteKit adapter-node 产物目录(含 client/ server/ handler.js)
 *   assetDir — 存放 dict.json 与 translator.template.js 的目录
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
