
/**
 * Dockhand 中文化:拉取镜像时自动改走国内镜像站(服务端)
 * 由 inject.mjs 在镜像构建期追加到含 dockerFetch 的 server chunk 末尾,
 * 并把原 dockerFetch 改名为 <名称>__zhOrig,由 __zhMirrorFetch 包一层。
 *
 * 流程:POST /images/create 且 registry 命中映射表 →
 *   1) 从镜像站拉取,进度原样转发给调用方
 *   2) 成功后 tag 回原名(容器/compose 引用、界面显示均不变)
 *   3) 镜像站任一环节失败 → 丢弃其错误行,透明回退到原地址重拉
 * 镜像站的 tag 刻意保留:删掉它会连带删除 RepoDigests,上游的更新检测依赖该 digest。
 * 已配置凭据(带 X-Registry-Auth)的私有镜像不走镜像站。
 *
 * Stack 部署由 docker compose 自行拉取,不经过 dockerFetch。
 * inject.mjs 同时把本文件追加到 compose 执行 chunk,在 spawn 前调用 __zhComposePrepull 预拉取。
 *
 * 环境变量 ZH_REGISTRY_MIRRORS:
 *   未设置  → 使用下方默认映射
 *   off/空  → 关闭
 *   其他    → 完全替换默认映射,格式 "ghcr.io=ghcr.nju.edu.cn,docker.io=docker.1ms.run"
 */
var __zhMirrorDefaults = 'docker.io=docker.1ms.run,' +
	'ghcr.io=ghcr.nju.edu.cn,' +
	'gcr.io=gcr.nju.edu.cn,' +
	'quay.io=quay.nju.edu.cn,' +
	'registry.k8s.io=k8s.nju.edu.cn,' +
	'nvcr.io=nvcr.nju.edu.cn';
var __zhMirrorTableCache = null;

function __zhMirrorTable() {
	if (__zhMirrorTableCache) return __zhMirrorTableCache;
	var table = Object.create(null);
	var raw = process.env.ZH_REGISTRY_MIRRORS;
	if (raw === undefined) raw = __zhMirrorDefaults;
	raw = raw.trim();
	if (raw && !/^(off|false|0|no|none)$/i.test(raw)) {
		var items = raw.split(/[,;\s]+/);
		for (var i = 0; i < items.length; i++) {
			var eq = items[i].indexOf('=');
			if (eq <= 0) continue;
			var from = items[i].slice(0, eq).trim().toLowerCase();
			var to = items[i].slice(eq + 1).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
			if (from && to) table[from] = to;
		}
	}
	var keys = Object.keys(table);
	console.log('[ZhMirror] ' + (keys.length
		? '镜像加速已启用: ' + keys.map(function (k) { return k + ' → ' + table[k]; }).join(', ')
		: '镜像加速已关闭'));
	__zhMirrorTableCache = table;
	return table;
}

// 拆出 registry 与仓库路径;Docker Hub 官方镜像补 library/
function __zhMirrorParseRef(name) {
	var slash = name.indexOf('/');
	var first = slash === -1 ? '' : name.slice(0, slash);
	var registry, path;
	if (slash !== -1 && (first.indexOf('.') !== -1 || first.indexOf(':') !== -1 || first === 'localhost')) {
		registry = first.toLowerCase();
		path = name.slice(slash + 1);
	} else {
		registry = 'docker.io';
		path = name;
	}
	if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io';
	if (registry === 'docker.io' && path.indexOf('/') === -1) path = 'library/' + path;
	return { registry: registry, path: path };
}

function __zhMirrorHasAuth(headers) {
	if (!headers) return false;
	if (typeof headers.has === 'function') return headers.has('X-Registry-Auth');
	for (var k in headers) {
		if (k.toLowerCase() === 'x-registry-auth' && headers[k]) return true;
	}
	return false;
}

async function __zhMirrorFetch(orig, path, opts, envId) {
	opts = opts || {};
	var method = (opts.method || 'GET').toUpperCase();
	var PREFIX = '/images/create?';
	if (method !== 'POST' || typeof path !== 'string' || path.indexOf(PREFIX) !== 0) {
		return orig(path, opts, envId);
	}

	var qs = new URLSearchParams(path.slice(PREFIX.length));
	var from = qs.get('fromImage');
	var tag = qs.get('tag');
	// 仅处理普通 registry 拉取;digest 引用无法 tag 回原名,导入(fromSrc)不相关
	if (!from || from.indexOf('@') !== -1 || qs.get('fromSrc') || tag === '') return orig(path, opts, envId);
	if (!tag) {
		var colon = from.lastIndexOf(':');
		if (colon > from.lastIndexOf('/')) {
			tag = from.slice(colon + 1);
			from = from.slice(0, colon);
		} else {
			tag = 'latest';
		}
	}
	if (__zhMirrorHasAuth(opts.headers)) return orig(path, opts, envId);

	var ref = __zhMirrorParseRef(from);
	var mirror = __zhMirrorTable()[ref.registry];
	if (!mirror) return orig(path, opts, envId);

	var mirrored = mirror + '/' + ref.path;
	var mq = new URLSearchParams(qs);
	mq.set('fromImage', mirrored);
	mq.set('tag', tag);
	var label = from + ':' + tag;

	var res = null;
	var firstError = null;
	try {
		res = await orig(PREFIX + mq.toString(), opts, envId);
		if (!res.ok || !res.body) {
			firstError = 'HTTP ' + res.status + ' ' + (await res.text().catch(function () { return ''; }));
			res = null;
		}
	} catch (e) {
		firstError = (e && e.message) || String(e);
		res = null;
	}
	if (!res) {
		console.warn('[ZhMirror] ' + mirrored + ':' + tag + ' 拉取失败,回退原地址 ' + label + ': ' + firstError);
		return orig(path, opts, envId);
	}

	var enc = new TextEncoder();
	var body = new ReadableStream({
		start: async function (ctrl) {
			var failed = null;
			var emit = function (obj) { ctrl.enqueue(enc.encode(JSON.stringify(obj) + '\n')); };
			// 镜像站的错误行不转发(调用方会把它当成最终失败),记下后走回退
			var handle = function (line) {
				if (failed || !line.trim()) return;
				if (line.indexOf('"error"') !== -1) {
					try {
						var j = JSON.parse(line);
						if (j && j.error) { failed = String(j.error); return; }
					} catch (e) { /* 非 JSON 行按原样转发 */ }
				}
				ctrl.enqueue(enc.encode(line + '\n'));
			};

			emit({ status: '[镜像加速] ' + label + ' ← ' + mirrored + ':' + tag });
			try {
				var dec = new TextDecoder();
				var reader = res.body.getReader();
				var buf = '';
				for (;;) {
					var r = await reader.read();
					if (r.done) break;
					buf += dec.decode(r.value, { stream: true });
					var lines = buf.split('\n');
					buf = lines.pop();
					for (var i = 0; i < lines.length; i++) handle(lines[i]);
				}
				buf += dec.decode();
				handle(buf);
			} catch (e) {
				failed = failed || (e && e.message) || String(e);
			}

			if (!failed) {
				// 必须在关闭流之前 tag 回原名:调用方读完流后会立即按原名 inspect/创建容器
				try {
					var tr = await orig('/images/' + encodeURIComponent(mirrored + ':' + tag) + '/tag?repo=' +
						encodeURIComponent(from) + '&tag=' + encodeURIComponent(tag), { method: 'POST' }, envId);
					var trText = await tr.text().catch(function () { return ''; });
					if (!tr.ok) failed = 'tag 回原名失败: HTTP ' + tr.status + ' ' + trText;
				} catch (e) {
					failed = 'tag 回原名失败: ' + ((e && e.message) || String(e));
				}
			}

			if (failed) {
				console.warn('[ZhMirror] ' + mirrored + ':' + tag + ' 拉取失败,回退原地址 ' + label + ': ' + failed);
				emit({ status: '[镜像加速] 镜像站失败,回退原地址: ' + failed });
				try {
					var fr = await orig(path, opts, envId);
					if (!fr.ok || !fr.body) {
						emit({ error: 'Failed to pull image: ' + (await fr.text().catch(function () { return 'HTTP ' + fr.status; })) });
					} else {
						var fReader = fr.body.getReader();
						for (;;) {
							var fr2 = await fReader.read();
							if (fr2.done) break;
							ctrl.enqueue(fr2.value);
						}
					}
				} catch (e) {
					emit({ error: 'Failed to pull image: ' + ((e && e.message) || String(e)) });
				}
			} else {
				console.log('[ZhMirror] ' + label + ' 已通过 ' + mirror + ' 拉取');
			}
			ctrl.close();
		}
	});
	return new Response(body, { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
}

// 拆出仓库名与 tag;digest 引用返回 null(无法 tag 回原名)
function __zhMirrorSplitTag(image) {
	if (!image || image.indexOf('@') !== -1) return null;
	var colon = image.lastIndexOf(':');
	if (colon > image.lastIndexOf('/')) return { from: image.slice(0, colon), tag: image.slice(colon + 1) };
	return { from: image, tag: 'latest' };
}

/**
 * Stack 部署前预拉取:用与 compose 相同的参数/环境,先经镜像站拉好镜像并 tag 回原名,
 * compose 随后发现本地已有镜像便不再拉取。
 * 拉取语义对齐 compose:up 默认只拉本地缺失的;--pull always 或 pull 操作全部拉;--pull never 跳过。
 * 这里只做加速,任何失败都静默交还给 compose 按原地址处理,绝不抛出。
 *   op/pullPolicy/serviceName — 对应 buildComposeOperationArgs 的入参
 *   args/baseLen — 完整 compose 命令行与其中操作参数之前的长度(即 "docker compose -p .. -f .." 部分)
 *   stdinContent — compose 内容经 stdin 传入(-f -)时的内容,否则为 null
 */
async function __zhComposePrepull(op, pullPolicy, serviceName, args, baseLen, cwd, env, stdinContent, logPrefix) {
	var tag0 = (logPrefix || '[Stack]') + ' [ZhMirror]';
	try {
		if (op !== 'up' && op !== 'pull') return;
		if (op === 'up' && pullPolicy === 'never') return;
		if (!Array.isArray(args) || typeof baseLen !== 'number' || baseLen < 2) return;
		var table = __zhMirrorTable();
		if (!Object.keys(table).length) return;
		var pullAll = op === 'pull' || pullPolicy === 'always';
		var cp = await import('node:child_process');

		var run = function (argv, input, timeoutMs, onLine) {
			return new Promise(function (resolve) {
				var out = '';
				var pending = '';
				var done = false;
				var finish = function (code) { if (!done) { done = true; clearTimeout(timer); resolve({ code: code, out: out }); } };
				var proc;
				try {
					proc = cp.spawn(args[0], argv, { cwd: cwd, env: env, stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
				} catch (e) {
					out = (e && e.message) || String(e);
					resolve({ code: -1, out: out });
					return;
				}
				var timer = setTimeout(function () {
					out += '\n超时(' + Math.round(timeoutMs / 1000) + 's)';
					try { proc.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
					finish(-1);
				}, timeoutMs);
				var onData = function (d) {
					var s = d.toString();
					out += s;
					if (out.length > 65536) out = out.slice(-32768);
					if (!onLine) return;
					pending += s;
					var lines = pending.split(/\r?\n/);
					pending = lines.pop();
					for (var i = 0; i < lines.length; i++) if (lines[i].trim()) onLine(lines[i]);
				};
				proc.stdout.on('data', onData);
				proc.stderr.on('data', onData);
				proc.on('error', function (e) { out += (e && e.message) || String(e); finish(-1); });
				proc.on('close', function (code) { finish(code); });
				if (input != null) {
					proc.stdin.on('error', function () { /* 进程提前退出 */ });
					proc.stdin.end(input);
				}
			});
		};

		var base = args.slice(1, baseLen); // 去掉开头的 docker
		var cfg = await run(base.concat(['config', '--images'], serviceName ? [serviceName] : []), stdinContent, 60000);
		if (cfg.code !== 0) {
			console.warn(tag0 + ' 解析镜像列表失败,跳过预拉取: ' + cfg.out.trim().slice(0, 500));
			return;
		}
		var seen = Object.create(null);
		var images = cfg.out.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) {
			if (!s || seen[s]) return false;
			seen[s] = true;
			return true;
		});

		for (var i = 0; i < images.length; i++) {
			var ref = __zhMirrorSplitTag(images[i]);
			if (!ref) continue;
			var parsed = __zhMirrorParseRef(ref.from);
			var mirror = table[parsed.registry];
			if (!mirror) continue;
			var origRef = ref.from + ':' + ref.tag;
			var mirrorRef = mirror + '/' + parsed.path + ':' + ref.tag;

			if (!pullAll) {
				var ins = await run(['image', 'inspect', '--format', '{{.Id}}', origRef], null, 30000);
				if (ins.code === 0) continue; // 本地已有,compose 也不会拉
			}

			console.log(tag0 + ' 预拉取 ' + origRef + ' ← ' + mirrorRef);
			var last = 0;
			var pr = await run(['pull', mirrorRef], null, 30 * 60 * 1000, function (line) {
				// docker pull 非 TTY 下逐层输出状态,限流避免刷屏
				var now = Date.now();
				if (now - last > 3000 || /^(Status|Digest|Error|error)/.test(line)) {
					last = now;
					console.log(tag0 + '   ' + line);
				}
			});
			if (pr.code !== 0) {
				console.warn(tag0 + ' 镜像站拉取失败,交给 compose 从原地址拉取: ' + pr.out.trim().split('\n').pop());
				continue;
			}
			var tr = await run(['tag', mirrorRef, origRef], null, 30000);
			if (tr.code !== 0) {
				console.warn(tag0 + ' tag 回原名失败,交给 compose 从原地址拉取: ' + tr.out.trim());
				continue;
			}
			console.log(tag0 + ' ' + origRef + ' 已通过 ' + mirror + ' 拉取');
		}
	} catch (e) {
		console.warn(tag0 + ' 预拉取异常,跳过: ' + ((e && e.message) || String(e)));
	}
}
