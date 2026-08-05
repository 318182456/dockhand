/**
 * Dockhand 运行时中文化脚本(浏览器端)
 * 由 inject.mjs 在镜像构建期填入字典后写入 build/client/zh-translate.js。
 * 注意:下方 DICT 的占位符是本文件唯一的占位符字面量,不要在别处(含注释)重复书写。
 * 原理:MutationObserver 监听 DOM,对文本节点/常见属性做字典翻译。
 * 不修改上游任何源码,对上游版本升级完全免疫。
 */
(function () {
	'use strict';

	var DICT = __DICT_JSON__;

	// 子串回退表:仅收录较长词条(>=10 字符),按长度降序,避免短词误伤
	var SUB_KEYS = [];
	for (var k in DICT) {
		if (Object.prototype.hasOwnProperty.call(DICT, k) && k.length >= 10 && DICT[k] && DICT[k] !== k) {
			SUB_KEYS.push(k);
		}
	}
	SUB_KEYS.sort(function (a, b) { return b.length - a.length; });

	// 翻译结果缓存(含"无需翻译"结论),保证幂等且高频 mutation 下开销极低
	var memo = Object.create(null);

	// 这些容器内的文本绝不能动:代码/日志/终端/编辑器/用户输入
	var SKIP_SELECTOR = 'script,style,noscript,textarea,code,pre,kbd,samp,' +
		'[contenteditable="true"],[contenteditable=""],.xterm,.cm-editor,.monaco-editor';

	var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

	function translateText(s) {
		if (!s || s.length > 2000) return s;
		var cached = memo[s];
		if (cached !== undefined) return cached;
		var out = s;
		// 保留首尾空白,只翻译核心文本
		var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
		var core = m[2];
		if (core && /[A-Za-z]/.test(core)) {
			var hit = DICT[core];
			if (hit) {
				out = m[1] + hit + m[3];
			} else if (core.length >= 10) {
				// 精确匹配失败时,对长词条做子串替换(覆盖含动态数字/名称的句子)
				var t = core;
				for (var i = 0; i < SUB_KEYS.length; i++) {
					var key = SUB_KEYS[i];
					if (t.indexOf(key) !== -1) t = t.split(key).join(DICT[key]);
				}
				if (t !== core) out = m[1] + t + m[3];
			}
		}
		memo[s] = out;
		return out;
	}

	function isSkipped(el) {
		return !!(el && el.closest && el.closest(SKIP_SELECTOR));
	}

	function processTextNode(node) {
		if (isSkipped(node.parentElement)) return;
		var v = node.nodeValue;
		var t = translateText(v);
		if (t !== v) node.nodeValue = t;
	}

	function processElement(el) {
		if (el.nodeType !== 1 || isSkipped(el)) return;
		for (var i = 0; i < ATTRS.length; i++) {
			var a = ATTRS[i];
			var v = el.getAttribute && el.getAttribute(a);
			if (v) {
				var t = translateText(v);
				if (t !== v) el.setAttribute(a, t);
			}
		}
		if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
			var bt = translateText(el.value);
			if (bt !== el.value) el.value = bt;
		}
	}

	function walk(root) {
		if (root.nodeType === 3) { processTextNode(root); return; }
		if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
		if (root.nodeType === 1) processElement(root);
		var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
		var n;
		while ((n = w.nextNode())) {
			if (n.nodeType === 3) processTextNode(n);
			else processElement(n);
		}
	}

	function start() {
		walk(document.documentElement);
		var mo = new MutationObserver(function (muts) {
			for (var i = 0; i < muts.length; i++) {
				var m = muts[i];
				if (m.type === 'characterData') {
					processTextNode(m.target);
				} else if (m.type === 'attributes') {
					processElement(m.target);
				} else if (m.type === 'childList') {
					for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
				}
			}
		});
		mo.observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ATTRS
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();
