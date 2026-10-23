
/**
 * Dockhand 镜像加速:拉取镜像时自动改走国内镜像站(服务端)
 * 由 inject.mjs 在镜像构建期追加到含 dockerFetch 的 server chunk 末尾,
 * 并把原 dockerFetch 改名为 <名称>__zhOrig,由 __zhMirrorFetch 包一层。
 *
 * 流程:POST /images/create 且 registry 命中映射表 →
 *   0) 按优先级探测镜像站(取 manifest + 最大层前 1MB),最多并发两路,选最先完成测速的;
 *      回源缓存型镜像站(如 NJU)对冷门镜像会一直不吐数据,探测可在十几秒内识别并跳过
 *   1) 从镜像站拉取,进度原样转发给调用方
 *   2) 成功后 tag 回原名(容器/compose 引用、界面显示均不变)
 *   3) 镜像站任一环节失败 → 丢弃其错误行,换站重试,全部失败才回源
 * 镜像站的 tag 刻意保留:删掉它会连带删除 RepoDigests,上游的更新检测依赖该 digest。
 * 已配置凭据(带 X-Registry-Auth)的私有镜像不走镜像站。
 *
 * Stack 部署由 docker compose 自行拉取,不经过 dockerFetch。
 * inject.mjs 同时把本文件追加到 compose 执行 chunk,在 spawn 前调用 __zhComposePrepull 预拉取。
 * 更新检查直接 fetch registry,同样不经过 dockerFetch;文件末尾包装全局 fetch,让 Docker Hub 的 digest 查询走镜像站。
 *
 * 环境变量 ZH_REGISTRY_MIRRORS:
 *   未设置  → 使用下方默认映射
 *   off/空  → 关闭
 *   其他    → 完全替换默认映射,格式 "ghcr.io=ghcr.linkos.org|ghcr.nju.edu.cn,docker.io=docker.1ms.run"
 *             同一 registry 可用 | 分隔多个镜像站,按顺序探测
 */
// 国内镜像站在前(按 2026-09 直连实测速度),境外镜像站只在最后兜底。
//   daocloud(上海阿里云)快但有白名单,白名单外直接 403,探测会立即跳过
//   1ms(国内)速度稳定;NJU(教育网)普遍限速约 0.4MB/s 且冷门镜像需长时间回源
//   xuanyuan(Cloudflare)、linkos(加拿大 Cogent)、dockerproxy(美国)为境外节点,无代理时通常很慢
var __zhMirrorDefaults = [
	'docker.io=docker.m.daocloud.io|docker.1ms.run|docker.xuanyuan.me|docker.linkos.org',
	'ghcr.io=ghcr.m.daocloud.io|ghcr.1ms.run|ghcr.nju.edu.cn|ghcr.linkos.org',
	'gcr.io=gcr.m.daocloud.io|gcr.nju.edu.cn|gcr.linkos.org',
	'quay.io=quay.m.daocloud.io|quay.nju.edu.cn|quay.linkos.org|quay.dockerproxy.net',
	'registry.k8s.io=k8s.m.daocloud.io|k8s.nju.edu.cn|k8s.linkos.org',
	'nvcr.io=nvcr.m.daocloud.io|nvcr.1ms.run|nvcr.nju.edu.cn'
].join(',');
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
			var to = items[i].slice(eq + 1).split('|').map(function (h) {
				return h.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
			}).filter(Boolean);
			if (from && to.length) table[from] = to;
		}
	}
	var keys = Object.keys(table);
	console.log('[ZhMirror] ' + (keys.length
		? '镜像加速已启用: ' + keys.map(function (k) { return k + ' → ' + table[k].join('|'); }).join(', ')
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

var __zhMirrorAccept = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(',');
// 探测门槛:最大层前 1MB 须在 12s 内读完(≈85KB/s),慢于此的镜像站跳过
var __zhMirrorProbeBytes = 1048576;
var __zhMirrorProbeMs = 12000;
var __zhMirrorProbeTotalMs = 20000;
// 模板可能注入多个 chunk,共享探测状态,不缓存 manifest/digest 或拉取结果。
var __zhMirrorProbeState = globalThis.__zhMirrorProbeState || (globalThis.__zhMirrorProbeState = new Map());
var __zhMirrorProbeCacheLimit = 256;
var __zhMirrorProbeSuccessMs = 60000;
var __zhMirrorProbeFailureMs = 15000;

function __zhMirrorProbeKey(mirror, repoPath, tag) {
	return JSON.stringify([mirror, repoPath, tag]);
}

function __zhMirrorProbeStore(key, value) {
	__zhMirrorProbeState.delete(key);
	while (__zhMirrorProbeState.size >= __zhMirrorProbeCacheLimit) {
		__zhMirrorProbeState.delete(__zhMirrorProbeState.keys().next().value);
	}
	__zhMirrorProbeState.set(key, value);
}

function __zhMirrorProbeFailed(mirror, repoPath, tag, reason) {
	__zhMirrorProbeStore(__zhMirrorProbeKey(mirror, repoPath, tag), {
		result: { ok: false, ms: 0, reason: reason }, exp: Date.now() + __zhMirrorProbeFailureMs
	});
}

// 只复用短期可用性:实际拉取仍由 Docker 校验,失败立即覆盖成功缓存。
async function __zhMirrorProbe(mirror, repoPath, tag) {
	var key = __zhMirrorProbeKey(mirror, repoPath, tag);
	var hit = __zhMirrorProbeState.get(key);
	if (hit && hit.pending) return hit.pending;
	if (hit && hit.exp > Date.now()) return hit.result;
	var entry = {};
	entry.pending = __zhMirrorProbeUncached(mirror, repoPath, tag).then(function (result) {
		// 已被实际拉取失败覆盖时,不能用较早的探测结果恢复成功缓存。
		if (__zhMirrorProbeState.get(key) === entry) {
			entry.result = result;
			entry.exp = Date.now() + (result.ok ? __zhMirrorProbeSuccessMs : __zhMirrorProbeFailureMs);
			delete entry.pending;
		}
		return result;
	});
	__zhMirrorProbeStore(key, entry);
	return entry.pending;
}
var __zhMirrorArch ={ x64: 'amd64', arm64: 'arm64', arm: 'arm', ppc64: 'ppc64le', s390x: 's390x' }[process.arch] || process.arch;

/**
 * 探测镜像站能否真正提供该镜像:取 manifest(多架构时选本机架构),再取最大层的前 1MB(小层取整层)。
 * 由 Dockhand 进程直接请求,与 daemon 所在网络通常一致。返回 { ok, ms, reason }。
 */
async function __zhMirrorProbeUncached(mirror, repoPath, tag) {
	var t0 = Date.now();
	var base = 'https://' + mirror + '/v2/' + repoPath;
	var auth = null;
	var get = async function (url, accept, ms, firstBytes) {
		ms = Math.min(ms, __zhMirrorProbeTotalMs - (Date.now() - t0));
		if (ms <= 0) throw new Error('探测总时间超过 ' + (__zhMirrorProbeTotalMs / 1000) + 's');
		var ac = new AbortController();
		var timer = setTimeout(function () { ac.abort(); }, ms);
		var reader = null;
		try {
			var build = function () {
				var h = {};
				if (accept) h.Accept = accept;
				if (auth) h.Authorization = auth;
				if (firstBytes) h.Range = 'bytes=0-' + (firstBytes - 1);
				return h;
			};
			var res = await fetch(url, { headers: build(), signal: ac.signal });
			if (res.status === 401 && !auth) {
				// 标准 registry token 流程
				var wa = res.headers.get('www-authenticate') || '';
				if (res.body) await res.body.cancel().catch(function () {});
				var realm = /realm="([^"]+)"/i.exec(wa);
				if (!realm) throw new Error('HTTP 401');
				var svc = /service="([^"]+)"/i.exec(wa);
				var turl = realm[1] + (realm[1].indexOf('?') === -1 ? '?' : '&') +
					'scope=' + encodeURIComponent('repository:' + repoPath + ':pull') +
					(svc ? '&service=' + encodeURIComponent(svc[1]) : '');
				var tr = await fetch(turl, { signal: ac.signal });
				var tj = tr.ok ? await tr.json() : {};
				if (!tr.ok && tr.body) await tr.body.cancel().catch(function () {});
				var tok = tj.token || tj.access_token;
				if (!tok) throw new Error('获取 token 失败 HTTP ' + tr.status);
				auth = 'Bearer ' + tok;
				res = await fetch(url, { headers: build(), signal: ac.signal });
			}
			if (!res.ok) {
				if (res.body) await res.body.cancel().catch(function () {});
				throw new Error('HTTP ' + res.status);
			}
			if (!firstBytes) return await res.json();
			// 读满 __zhMirrorProbeBytes(或整层)才算通过:只看首包会放过"能连通但极慢"的镜像站
			reader = res.body.getReader();
			var got = 0;
			for (;;) {
				var r = await reader.read();
				if (r.done) break;
				got += r.value.length;
				if (got >= firstBytes) break;
			}
			if (got < firstBytes) throw new Error('层数据不足: ' + got + '/' + firstBytes + ' bytes');
			return got;
		} catch (e) {
			if (ac.signal.aborted) throw new Error(Math.round(ms / 1000) + 's 探测超时');
			throw e;
		} finally {
			clearTimeout(timer);
			if (reader) {
				reader.cancel().catch(function () {});
				reader.releaseLock();
			}
		}
	};
	try {
		var m = await get(base + '/manifests/' + encodeURIComponent(tag), __zhMirrorAccept, 10000);
		if (m && Array.isArray(m.manifests)) {
			var list = m.manifests.filter(function (x) { return x.platform && x.platform.os !== 'unknown'; });
			var pick = list.filter(function (x) { return x.platform.os === 'linux' && x.platform.architecture === __zhMirrorArch; })[0] || list[0];
			if (!pick) throw new Error('manifest 列表中无可用平台');
			m = await get(base + '/manifests/' + pick.digest, __zhMirrorAccept, 10000);
		}
		if (!m || m.schemaVersion !== 2 || !Array.isArray(m.layers)) throw new Error('无效的镜像 manifest');
		var layers = m.layers;
		if (layers.length) {
			var big = layers.reduce(function (a, b) { return (b.size || 0) > (a.size || 0) ? b : a; });
			if (!big.digest || !Number.isSafeInteger(big.size) || big.size <= 0) throw new Error('无效的镜像层描述');
			await get(base + '/blobs/' + big.digest, null, __zhMirrorProbeMs, Math.min(big.size, __zhMirrorProbeBytes));
		}
		return { ok: true, ms: Date.now() - t0 };
	} catch (e) {
		return { ok: false, ms: Date.now() - t0, reason: (e && e.message) || String(e) };
	}
}

// 优先探测排在前面的站点;500ms 未完成时增加一路探测,最多并发 2 路。
// 首个完成完整层测速的站点胜出;已开始的探测仍会收尾并更新共享缓存。
// skip 为本次拉取已经实际失败的站点,防止回退时重复尝试。
async function __zhMirrorPick(mirrors, repoPath, tag, label, logPrefix, skip) {
	var candidates = mirrors.filter(function (m) { return !skip || skip.indexOf(m) === -1; });
	return new Promise(function (resolve) {
		var next = 0, active = 0, settled = false, timer;
		var finish = function (mirror) { if (!settled) { settled = true; clearTimeout(timer); resolve(mirror); } };
		var launch = function () {
			if (settled || active >= 2) return;
			if (next >= candidates.length) { if (!active) finish(null); return; }
			var mirror = candidates[next++];
			active++;
			Promise.resolve().then(function () { return __zhMirrorProbe(mirror, repoPath, tag); }).catch(function (e) {
				return { ok: false, reason: e.message };
			}).then(function (p) {
				active--;
				if (p.ok) {
					if (!settled) console.log(logPrefix + ' 探测 ' + mirror + ' 可用(' + p.ms + 'ms): ' + label);
					finish(mirror);
				} else {
					console.warn(logPrefix + ' 探测 ' + mirror + ' 不可用,跳过: ' + p.reason);
					launch();
				}
			});
		};
		launch();
		if (!settled) timer = setTimeout(launch, 500);
	});
}

// 只跟踪拉取前已存在的镜像 ID,不对 daemon 执行全局 prune。
// 跨 chunk 共享队列;持久化后,更新中途重启也能在下次访问该环境时继续回收。
var __zhCleanupState = globalThis.__zhCleanupState || (globalThis.__zhCleanupState = {
	scopes: Object.create(null), adapters: new Map(), ready: null, writes: Promise.resolve(), busy: false, timer: null, active: 0
});

async function __zhCleanupAttach(adapter) {
	var s = __zhCleanupState;
	s.adapters.set(adapter.key, adapter);
	if (!s.ready) s.ready = (async function () {
		try {
			s.fs = await import('node:fs/promises');
			var path = await import('node:path');
			s.file = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'zh-image-cleanup.json');
			try {
				var saved = JSON.parse(await s.fs.readFile(s.file, 'utf8'));
				if (saved.version === 1 && saved.scopes && typeof saved.scopes === 'object') {
					for (var key of Object.keys(saved.scopes)) {
						if (Array.isArray(saved.scopes[key])) s.scopes[key] = saved.scopes[key].filter(function (x) {
							return x && /^sha256:[a-f0-9]{64}$/.test(x.id) && typeof x.original === 'string' &&
								Array.isArray(x.aliases) && x.aliases.every(function (a) { return typeof a === 'string'; });
						});
					}
				}
			} catch (e) { if (e.code !== 'ENOENT') console.warn('[ZhMirror] 读取旧镜像清理队列失败: ' + e.message); }
		} catch (e) { console.warn('[ZhMirror] 初始化旧镜像清理队列失败: ' + e.message); }
	})();
	await s.ready;
	if (!s.scopes[adapter.key]) s.scopes[adapter.key] = [];
	if (!s.timer) {
		s.timer = setInterval(function () { __zhCleanupSweep().catch(function (e) {
			console.warn('[ZhMirror] 旧镜像清理失败,稍后重试: ' + e.message);
		}); }, 30000);
		if (s.timer.unref) s.timer.unref();
	}
}

async function __zhCleanupSave() {
	var s = __zhCleanupState;
	if (!s.fs || !s.file) return;
	var json = JSON.stringify({ version: 1, scopes: s.scopes });
	s.writes = s.writes.catch(function () {}).then(async function () {
		await s.fs.writeFile(s.file + '.tmp', json, { mode: 0o600 });
		await s.fs.rename(s.file + '.tmp', s.file);
	}).catch(function (e) { console.warn('[ZhMirror] 保存旧镜像清理队列失败: ' + e.message); });
	await s.writes;
}

async function __zhCleanupCapture(adapter, from, tag, mirrors) {
	try {
		await __zhCleanupAttach(adapter);
		var parsed = __zhMirrorParseRef(from);
		var original = from + ':' + tag;
		var aliases = mirrors.map(function (m) { return m + '/' + parsed.path + ':' + tag; });
		var queue = __zhCleanupState.scopes[adapter.key];
		for (var name of [original].concat(aliases)) {
			var image = await adapter.inspect(name);
			if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) continue;
			var entry = queue.find(function (x) { return x.id === image.Id && x.original === original; });
			if (!entry) { entry = { id: image.Id, original: original, aliases: [] }; queue.push(entry); }
			for (var alias of aliases) if (!entry.aliases.includes(alias)) entry.aliases.push(alias);
		}
		await __zhCleanupSave();
	} catch (e) { console.warn('[ZhMirror] 记录旧镜像失败,拉取照常继续: ' + e.message); }
}

async function __zhCleanupSweep() {
	var s = __zhCleanupState;
	if (s.busy || s.active) return;
	s.busy = true;
	var changed = false;
	try {
		for (var pair of s.adapters) {
			var adapter = pair[1];
			var queue = s.scopes[pair[0]] || [];
			// 快照遍历,不覆盖并发拉取刚加入的记录。
			for (var entry of queue.slice()) {
				try {
					var image = await adapter.inspect(entry.id);
					var done = !image;
					if (image) {
						var current = await adapter.inspect(entry.original);
						// 新版必须已存在;仍为当前版本或更新失败时不处理。
						if (!current || current.Id === entry.id) continue;
						var tags = (image.RepoTags || []).filter(function (t) { return t !== '<none>:<none>'; });
						if (tags.some(function (t) { return !entry.aliases.includes(t); })) continue;
						// 包含已停止的容器;Docker 最后的非强制删除还会再次检查引用。
						if (await adapter.inUse(entry.id)) continue;
						if (s.active) continue;
						// 只按 ID 非强制删除;并发拉取重新打上标签或创建容器时由 Docker 拒绝删除。
						// 多标签镜像同样交给 Docker 的冲突保护,不逐个删标签以免和并发 tag 竞争。
						done = await adapter.remove(entry.id);
						if (done) console.log('[ZhMirror] 已清理被替换的旧镜像: ' + entry.original + ' (' + entry.id + ')');
					}
					if (done) { var index = queue.indexOf(entry); if (index !== -1) queue.splice(index, 1); changed = true; }
				} catch (e) { /* 环境离线/引用冲突等保留记录,下轮重试 */ }
			}
		}
		if (changed) await __zhCleanupSave();
	} finally { s.busy = false; }
}

function __zhCleanupApi(orig, envId) {
	return {
		key: 'api:' + (envId == null ? 'default' : String(envId)),
		inspect: async function (ref) {
			var r = await orig('/images/' + encodeURIComponent(ref) + '/json', {}, envId);
			if (r.status === 404) { await r.text(); return null; }
			if (!r.ok) { await r.text(); throw new Error('inspect HTTP ' + r.status); }
			return r.json();
		},
		inUse: async function (id) {
			var r = await orig('/containers/json?all=true&filters=' + encodeURIComponent(JSON.stringify({ ancestor: [id] })), {}, envId);
			if (!r.ok) { await r.text(); throw new Error('containers HTTP ' + r.status); }
			return (await r.json()).length > 0;
		},
		remove: async function (ref) {
			var r = await orig('/images/' + encodeURIComponent(ref) + '?force=false&noprune=true', { method: 'DELETE' }, envId);
			await r.text();
			return r.ok || r.status === 404;
		}
	};
}

async function __zhCleanupCli(run, args, cwd, env) {
	// 保存队列中仅记录作用域哈希,不保存 CLI 环境变量或凭据。
	var crypto = await import('node:crypto');
	var identity = [args[0], cwd, env.DOCKER_HOST || '', env.DOCKER_CONTEXT || '', env.DOCKER_CONFIG || '',
		env.DOCKER_TLS_VERIFY || '', env.DOCKER_CERT_PATH || ''];
	return {
		key: 'cli:' + crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
		inspect: async function (ref) {
			var r = await run(['image', 'inspect', ref], null, 30000);
			if (r.code !== 0) {
				if (/No such (image|object)/i.test(r.out)) return null;
				throw new Error(r.out);
			}
			return JSON.parse(r.out)[0];
		},
		inUse: async function (id) {
			var r = await run(['ps', '-a', '--filter', 'ancestor=' + id, '--format', '{{.ID}}'], null, 30000);
			if (r.code !== 0) throw new Error(r.out);
			return !!r.out.trim();
		},
		remove: async function (ref) {
			var r = await run(['image', 'rm', '--no-prune', ref], null, 30000);
			return r.code === 0 || /No such image/i.test(r.out);
		}
	};
}

// 清理与实际拉取互斥到响应流结束,包括调用方取消或网络异常的路径。
async function __zhMirrorFetch(orig, path, opts, envId, tried) {
	var pulling = opts && (opts.method || 'GET').toUpperCase() === 'POST' &&
		typeof path === 'string' && path.indexOf('/images/create?') === 0;
	if (!pulling) return __zhMirrorFetchImpl(orig, path, opts, envId, tried);
	var s = __zhCleanupState;
	s.active++;
	var finished = false;
	var finish = function () { if (!finished) { finished = true; s.active--; } };
	try {
		var res = await __zhMirrorFetchImpl(orig, path, opts, envId, tried);
		if (!res.body) { finish(); return res; }
		var reader = res.body.getReader();
		var body = new ReadableStream({
			pull: async function (ctrl) {
				try {
					var r = await reader.read();
					if (r.done) { finish(); reader.releaseLock(); ctrl.close(); }
					else ctrl.enqueue(r.value);
				} catch (e) { finish(); reader.releaseLock(); ctrl.error(e); }
			},
			cancel: async function (reason) {
				try { await reader.cancel(reason); } finally { finish(); reader.releaseLock(); }
			}
		});
		return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
	} catch (e) { finish(); throw e; }
}

async function __zhMirrorFetchImpl(orig, path, opts, envId, tried) {
	opts = opts || {};
	var cleanup = __zhCleanupApi(orig, envId);
	await __zhCleanupAttach(cleanup);
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
	var ref = __zhMirrorParseRef(from);
	var mirrors = __zhMirrorTable()[ref.registry];
	if (!tried) await __zhCleanupCapture(cleanup, from, tag, mirrors || []);
	if (__zhMirrorHasAuth(opts.headers)) return orig(path, opts, envId);
	if (!mirrors) return orig(path, opts, envId);
	var label = from + ':' + tag;
	var mirror = await __zhMirrorPick(mirrors, ref.path, tag, label, '[ZhMirror]', tried);
	if (!mirror) {
		console.warn('[ZhMirror] 无可用镜像站,直接从原地址拉取: ' + label);
		return orig(path, opts, envId);
	}

	var mirrored = mirror + '/' + ref.path;
	var mq = new URLSearchParams(qs);
	mq.set('fromImage', mirrored);
	mq.set('tag', tag);

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
		await __zhCleanupCapture(cleanup, from, tag, mirrors);
		__zhMirrorProbeFailed(mirror, ref.path, tag, firstError);
		console.warn('[ZhMirror] ' + mirrored + ':' + tag + ' 拉取失败,尝试其他镜像站 ' + label + ': ' + firstError);
		return __zhMirrorFetch(orig, path, opts, envId, (tried || []).concat(mirror));
	}

	var enc = new TextEncoder();
	var body = new ReadableStream({
		start: async function (ctrl) {
			// start 的异步生产可能在消费者取消后才结束,独立保护该阶段。
			__zhCleanupState.active++;
			try {
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
				await __zhCleanupCapture(cleanup, from, tag, mirrors);
				__zhMirrorProbeFailed(mirror, ref.path, tag, failed);
				console.warn('[ZhMirror] ' + mirrored + ':' + tag + ' 拉取失败,尝试其他镜像站 ' + label + ': ' + failed);
				emit({ status: '[镜像加速] 镜像站失败,尝试其他镜像站,全部失败后回源: ' + failed });
				try {
					var fr = await __zhMirrorFetch(orig, path, opts, envId, (tried || []).concat(mirror));
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
			} finally { __zhCleanupState.active--; }
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

		var cleanup = await __zhCleanupCli(run, args, cwd, env);
		await __zhCleanupAttach(cleanup);
		__zhCleanupState.active++;
		var cleanupActive = true;
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
			var mirrors = table[parsed.registry];
			if (!mirrors) continue;
			var origRef = ref.from + ':' + ref.tag;

			if (!pullAll) {
				var ins = await run(['image', 'inspect', '--format', '{{.Id}}', origRef], null, 30000);
				if (ins.code === 0) continue; // 本地已有,compose 也不会拉
			}

			// 逐个镜像站:探测通过才拉,拉取失败换下一个;全部失败交还 compose
			await __zhCleanupCapture(cleanup, ref.from, ref.tag, mirrors);
			var tried = [];
			var done = false;
			while (!done) {
				var mirror = await __zhMirrorPick(mirrors, parsed.path, ref.tag, origRef, tag0, tried);
				if (!mirror) break;
				tried.push(mirror);
				var mirrorRef = mirror + '/' + parsed.path + ':' + ref.tag;
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
					await __zhCleanupCapture(cleanup, ref.from, ref.tag, mirrors);
					__zhMirrorProbeFailed(mirror, parsed.path, ref.tag, 'docker pull 失败');
					console.warn(tag0 + ' ' + mirror + ' 拉取失败: ' + pr.out.trim().split('\n').pop());
					continue;
				}
				var tr = await run(['tag', mirrorRef, origRef], null, 30000);
				if (tr.code !== 0) {
					await __zhCleanupCapture(cleanup, ref.from, ref.tag, mirrors);
					console.warn(tag0 + ' tag 回原名失败: ' + tr.out.trim());
					continue;
				}
				console.log(tag0 + ' ' + origRef + ' 已通过 ' + mirror + ' 拉取');
				done = true;
			}
			if (!done) console.warn(tag0 + ' 无可用镜像站,交给 compose 从原地址拉取: ' + origRef);
		}
	} catch (e) {
		console.warn(tag0 + ' 预拉取异常,跳过: ' + ((e && e.message) || String(e)));
	} finally {
		if (cleanupActive) __zhCleanupState.active--;
	}
}

/**
 * 更新检查经镜像站查询 Docker Hub
 * 上游的更新检查/自动更新由 Dockhand 进程直接 fetch registry:先 GET https://index.docker.io/v2/ 拿 challenge,
 * 再到 auth.docker.io 取匿名 token,最后 HEAD/GET manifest 比对 Docker-Content-Digest。
 * auth.docker.io 在国内常常连不上,取 token 失败后上游会匿名请求 manifest,得到 401,界面就显示成"私有镜像或缺少凭据"。
 *
 * 这里包装全局 fetch,只处理 Docker Hub 的匿名请求:
 *   1) GET <hub>/v2/                     → 直接返回标准 challenge,不发网络请求
 *   2) 匿名 GET auth.docker.io/token     → 返回占位 token,不发网络请求
 *   3) <hub>/v2/<repo>/...(带占位 token 或无凭据)→ 按顺序改发到镜像站,镜像站各自走 token 流程;
 *      全部失败时回退到 Docker Hub 原地址(真实取 token)
 * 带凭据(Basic)的 token 请求、真实 token 的请求原样放行,Docker Hub 凭据不会发给镜像站。
 * 镜像站返回的 Docker-Content-Digest 与 Docker Hub 一致,上游的 digest 比对不受影响。
 */
var __zhHubHosts = { 'index.docker.io': 1, 'registry-1.docker.io': 1, 'registry.hub.docker.com': 1, 'registry.docker.io': 1, 'docker.io': 1 };
var __zhHubPlaceholder = 'zh-mirror-anonymous';
var __zhHubTokens = new Map(); // mirror|repo → { auth, exp }
var __zhHubCooldown = new Map(); // mirror → 不可达时的冷却截止时间
var __zhHubTimeoutMs = 10000;
var __zhHubCooldownMs = 5 * 60 * 1000;

function __zhHeaderGet(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === 'function') return headers.get(name);
	var lower = name.toLowerCase();
	for (var k in headers) if (k.toLowerCase() === lower) return headers[k];
	return null;
}

// 合并调用方的 signal 与本地超时
function __zhHubSignal(signal) {
	var t = AbortSignal.timeout(__zhHubTimeoutMs);
	return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : t;
}

// 向镜像站(或 Docker Hub)取匿名 pull token;无需认证返回 '',无法取得返回 null
async function __zhHubAuth(orig, host, repo, signal) {
	var key = host + '|' + repo;
	var hit = __zhHubTokens.get(key);
	if (hit && hit.exp > Date.now()) return hit.auth;
	var c = await orig('https://' + host + '/v2/', { headers: { 'User-Agent': 'Dockhand/1.0' }, signal: __zhHubSignal(signal) });
	if (c.body) await c.body.cancel().catch(function () {});
	var auth = null;
	var ttl = 60;
	if (c.ok) {
		auth = '';
	} else if (c.status === 401) {
		var wa = c.headers.get('www-authenticate') || '';
		var realm = /realm="([^"]+)"/i.exec(wa);
		if (!/^bearer/i.test(wa) || !realm) return null;
		var svc = /service="([^"]+)"/i.exec(wa);
		var u = new URL(realm[1]);
		if (svc) u.searchParams.set('service', svc[1]);
		u.searchParams.set('scope', 'repository:' + repo + ':pull');
		var tr = await orig(u.toString(), { headers: { 'User-Agent': 'Dockhand/1.0' }, signal: __zhHubSignal(signal) });
		var tj = tr.ok ? await tr.json().catch(function () { return {}; }) : {};
		if (!tr.ok && tr.body) await tr.body.cancel().catch(function () {});
		var tok = tj.token || tj.access_token;
		if (!tok) return null;
		auth = 'Bearer ' + tok;
		if (tj.expires_in > 0) ttl = tj.expires_in;
	} else {
		return null;
	}
	// 提前 10 秒过期,最长缓存 5 分钟
	__zhHubTokens.set(key, { auth: auth, exp: Date.now() + Math.min(Math.max(ttl - 10, 10), 300) * 1000 });
	return auth;
}

async function __zhHubRequest(orig, host, pathAndQuery, init, auth) {
	var h = {};
	var src = init.headers;
	if (src && typeof src.forEach === 'function') src.forEach(function (v, k) { h[k] = v; });
	else if (src) for (var k in src) h[k] = src[k];
	for (var k2 in h) if (k2.toLowerCase() === 'authorization') delete h[k2];
	if (auth) h.Authorization = auth;
	var opts = Object.assign({}, init, { headers: h, signal: __zhHubSignal(init.signal) });
	return orig('https://' + host + pathAndQuery, opts);
}

async function __zhHubViaMirror(orig, url, init, mirrors) {
	var m = /^\/v2\/(.+?)\/(manifests|tags|blobs|referrers)\//.exec(url.pathname);
	if (!m) return null;
	var repo = m[1];
	var pathAndQuery = url.pathname + url.search;
	var last = null;
	for (var i = 0; i < mirrors.length; i++) {
		var mirror = mirrors[i];
		if ((__zhHubCooldown.get(mirror) || 0) > Date.now()) continue;
		try {
			for (var attempt = 0; attempt < 2; attempt++) {
				var auth = await __zhHubAuth(orig, mirror, repo, init.signal);
				if (auth === null) break;
				var res = await __zhHubRequest(orig, mirror, pathAndQuery, init, auth);
				if (res.ok) return res;
				if (res.body) await res.body.cancel().catch(function () {});
				// token 过期或被拒:清缓存重试一次
				if (res.status === 401 && attempt === 0 && auth) { __zhHubTokens.delete(mirror + '|' + repo); continue; }
				last = mirror + ' HTTP ' + res.status;
				break;
			}
		} catch (e) {
			if (init.signal && init.signal.aborted) throw e;
			__zhHubCooldown.set(mirror, Date.now() + __zhHubCooldownMs);
			last = mirror + ' ' + (((e && e.cause && e.cause.code) || (e && e.message)) || String(e));
			console.warn('[ZhMirror] 更新检查: ' + mirror + ' 不可达,' + Math.round(__zhHubCooldownMs / 60000) + ' 分钟内跳过: ' + last);
		}
	}
	console.warn('[ZhMirror] 更新检查: 镜像站均不可用,回退 Docker Hub: ' + repo + (last ? '(' + last + ')' : ''));
	return null;
}

async function __zhRegistryFetch(orig, input, init) {
	if (typeof input !== 'string' && !(input instanceof URL)) return orig(input, init);
	var raw = String(input);
	if (raw.indexOf('docker.io') === -1) return orig(input, init);
	var url;
	try { url = new URL(raw); } catch (e) { return orig(input, init); }
	if (url.protocol !== 'https:') return orig(input, init);
	var host = url.hostname.toLowerCase();
	var isHub = !!__zhHubHosts[host];
	if (!isHub && host !== 'auth.docker.io') return orig(input, init);
	var mirrors = __zhMirrorTable()['docker.io'];
	if (!mirrors) return orig(input, init);
	init = init || {};
	var method = (init.method || 'GET').toUpperCase();
	var auth = __zhHeaderGet(init.headers, 'authorization');

	// 1) challenge:与 Docker Hub 一致,realm 指向 auth.docker.io
	if (isHub && url.pathname === '/v2/' && method === 'GET' && !auth) {
		return new Response(null, { status: 401, headers: {
			'WWW-Authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'
		} });
	}
	// 2) 匿名取 token:返回占位 token;带凭据则放行到真实 auth.docker.io
	if (host === 'auth.docker.io') {
		if (url.pathname !== '/token' || auth) return orig(input, init);
		return new Response(JSON.stringify({ token: __zhHubPlaceholder, access_token: __zhHubPlaceholder, expires_in: 300 }), {
			status: 200, headers: { 'Content-Type': 'application/json' }
		});
	}
	// 3) 匿名(占位 token 或无凭据)的 /v2/<repo>/... 请求改走镜像站
	if (url.pathname.indexOf('/v2/') !== 0 || (auth && auth !== 'Bearer ' + __zhHubPlaceholder)) return orig(input, init);
	if (method !== 'GET' && method !== 'HEAD') return orig(input, init);
	var res = await __zhHubViaMirror(orig, url, init, mirrors);
	if (res) return res;
	// 回退:到 Docker Hub 真实取匿名 token 后请求原地址
	var m = /^\/v2\/(.+?)\/(manifests|tags|blobs|referrers)\//.exec(url.pathname);
	var hubAuth = null;
	if (m) {
		try { hubAuth = await __zhHubAuth(orig, 'registry-1.docker.io', m[1], init.signal); } catch (e) { hubAuth = null; }
	}
	return __zhHubRequest(orig, host, url.pathname + url.search, init, hubAuth);
}

if (typeof globalThis.fetch === 'function' && !globalThis.__zhRegistryFetchOrig) {
	globalThis.__zhRegistryFetchOrig = globalThis.fetch;
	globalThis.fetch = function (input, init) { return __zhRegistryFetch(globalThis.__zhRegistryFetchOrig, input, init); };
}
