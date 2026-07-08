import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 临时修改 package.json，锁定依赖版本范围前缀（^和~）以防止漂移
try {
  const packageJsonPath = path.join(__dirname, '../package.json');
  if (fs.existsSync(packageJsonPath)) {
    const p = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const clean = (obj) => {
      if (!obj) return;
      for (let k in obj) {
        if (typeof obj[k] === 'string' && (obj[k].startsWith('^') || obj[k].startsWith('~'))) {
          obj[k] = obj[k].replace(/^[\^~]/, '');
        }
      }
    };
    clean(p.dependencies);
    clean(p.devDependencies);
    clean(p.overrides);
    fs.writeFileSync(packageJsonPath, JSON.stringify(p, null, 2), 'utf8');
    console.log('已临时锁定 package.json 中的依赖版本');
  }
} catch (err) {
  console.error('临时锁定 package.json 版本失败:', err);
}

const dictPath = path.join(__dirname, 'translation-dict.json');
const srcDir = path.join(__dirname, '../src');

// 1. 读取并解析字典
let dict = {};
try {
  const dictData = fs.readFileSync(dictPath, 'utf8');
  dict = JSON.parse(dictData);
} catch (err) {
  console.error('无法读取翻译字典 scripts/translation-dict.json:', err);
  process.exit(1);
}

// 将字典按 key 长度从长到短排序，防止子字符串替换导致匹配错乱（例如 "Audit log" 与 "log"）
const sortedKeys = Object.keys(dict).sort((a, b) => b.length - a.length);

// 2. 递归遍历目录
function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory) {
      walkDir(dirPath, callback);
    } else {
      callback(dirPath);
    }
  });
}

console.log('开始扫描并替换翻译文案...');

let processedCount = 0;
let replacedCount = 0;

walkDir(srcDir, (filePath) => {
  const ext = path.extname(filePath);
  // 仅处理 svelte, ts, js 页面文件
  if (['.svelte', '.ts', '.js'].includes(ext)) {
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    // 预处理特殊规则：防止 'Created' 被词典中的“创建时间”误替换
    if (content.includes("value: 'created', label: 'Created'")) {
      content = content.replace(/value: 'created', label: 'Created'/g, "value: 'created', label: '已创建'");
    }

    if (content.includes("label: 'Status'")) {
      content = content.replace(/label: 'Status'/g, "label: '状态'");
    }

    // 对排序后的每一个 key 执行安全替换
    for (const key of sortedKeys) {
      const value = dict[key];
      if (!value || key === value) continue;

      // 如果是 js/ts 文件，且 key 是保留关键字/HTTP头，则跳过以防破坏代码逻辑
      if (['.ts', '.js'].includes(ext) && ['Connection', 'Status', 'Type', 'Method', 'Unknown'].includes(key)) {
        continue;
      }

      // 性能优化极其重要：如果文件中不包含该文本，直接跳过，避免昂贵的 RegExp 编译和匹配
      if (!content.includes(key)) continue;

      // 统一转义所有正则元字符以进行安全精确匹配
      const keyPattern = escapeRegExp(key);

      // 1. 替换 Svelte 模板中文本节点 (处于 > 或 } 之后，且在 < 或 { 之前)
      const textRegex = new RegExp(`([>}]\\s*)${keyPattern}(\\s*[<{])`, 'g');
      content = content.replace(textRegex, `$1${value}$2`);

      // 2. 字符串引号内的文案替换 (支持双引号、单引号、反引号)
      const singleQuoteRegex = new RegExp(`'${keyPattern}'`, 'g');
      content = content.replace(singleQuoteRegex, `'${value}'`);

      const doubleQuoteRegex = new RegExp(`"${keyPattern}"`, 'g');
      content = content.replace(doubleQuoteRegex, `"${value}"`);

      const backtickRegex = new RegExp(`\`${keyPattern}\``, 'g');
      content = content.replace(backtickRegex, `\`${value}\``);
    }

    // 针对动态模板字面量的特殊替换
    if (content.includes('Search ${selectedRegistry.name} for images...')) {
      content = content.replace(/`Search \${selectedRegistry\.name} for images\.\.\.`/g, '`在 ${selectedRegistry.name} 中搜索镜像...`');
    }

    if (content.includes('Update environment: ${env?.name || \'Unknown\'}')) {
      content = content.replace(/`Update environment: \${env\?\.name \|\| 'Unknown'}`/g, '`更新环境: ${env?.name || \'未知\'}`');
    }

    if (content.includes('Prune images: ${env?.name || \'Unknown\'}')) {
      content = content.replace(/`Prune images: \${env\?\.name \|\| 'Unknown'}`/g, '`清理镜像: ${env?.name || \'未知\'}`');
    }

    if (content.includes('differ from the image:')) {
      // {containerData.divergence.env.length} env var{containerData.divergence.env.length === 1 ? '' : 's'} differ from the image:
      content = content.replace(/\{containerData\.divergence\.env\.length\}\s*env var\{containerData\.divergence\.env\.length === 1 \? '' : 's'\}\s*differ from the image:/g, '{containerData.divergence.env.length} 个环境变量与镜像不同:');
      // {containerData.divergence.labels.length} label{containerData.divergence.labels.length === 1 ? '' : 's'} differ from the image:
      content = content.replace(/\{containerData\.divergence\.labels\.length\}\s*label\{containerData\.divergence\.labels\.length === 1 \? '' : 's'\}\s*differ from the image:/g, '{containerData.divergence.labels.length} 个标签与镜像不同:');
    }

    if (content.includes('selectedCategories.length} categories')) {
      content = content.replace(/\{selectedCategories\.length\}\s*categories/g, '{selectedCategories.length} 个分类');
    }

    if (content.includes('selectedSources.length} sources')) {
      content = content.replace(/\{selectedSources\.length\}\s*sources/g, '{selectedSources.length} 个模板源');
    }

    if (content.includes('validation.count} templates')) {
      content = content.replace(/\(\{validation\.count\}\s*templates\)/g, '({validation.count} 个模板)');
    }

    if (content.includes('source(s) failed validation')) {
      content = content.replace(/`\$\{failedCount\}\s*source\(s\) failed validation`/g, '`${failedCount} 个模板源验证失败`');
    }

    if (content.includes('Disabled ${disabled} inactive source(s)')) {
      content = content.replace(/`Disabled \$\{disabled\}\s*inactive source\(s\)`/g, '`已禁用 ${disabled} 个失效模板源`');
    }

    // ----------------------------------------------------
    // Custom post-processing replacements (1ms.run docker pull acceleration)
    // ----------------------------------------------------
    const relativePath = filePath.replace(/\\/g, '/');

    if (relativePath.endsWith('src/lib/server/docker.ts')) {
      if (content.includes('export async function pullImage(')) {
        const targetPull = content.match(/export async function pullImage\([\s\S]*?\}\n\nexport async function removeImage\(/) ||
                           content.match(/export async function pullImage\([\s\S]*?\}\r\n\r\nexport async function removeImage\(/);
        if (targetPull) {
          const removeImageIndex = targetPull[0].indexOf('export async function removeImage');
          const originalBlock = targetPull[0].substring(0, removeImageIndex);
          const replacementBlock = `export async function pullImage(imageName: string, onProgress?: (data: any) => void, envId?: number | null) {
	// Parse image name and tag to avoid pulling all tags
	let fromImage = imageName;
	let tag = 'latest';

	if (imageName.includes('@')) {
		fromImage = imageName;
		tag = '';
	} else if (imageName.includes(':')) {
		const lastColonIndex = imageName.lastIndexOf(':');
		const potentialTag = imageName.substring(lastColonIndex + 1);
		if (!potentialTag.includes('/')) {
			fromImage = imageName.substring(0, lastColonIndex);
			tag = potentialTag;
		}
	}

	let isAccelerated = false;
	let pullFromImage = fromImage;
	let pullTag = tag;

	let registry = '';
	let repoAndTag = imageName;
	const firstSlash = imageName.indexOf('/');
	if (firstSlash > -1) {
		const firstPart = imageName.substring(0, firstSlash);
		if (firstPart.includes('.') || firstPart.includes(':') || firstPart === 'localhost') {
			registry = firstPart;
			repoAndTag = imageName.substring(firstSlash + 1);
		}
	}

	let targetRegistry = '';
	if (registry === '' || registry === 'docker.io' || registry === 'index.docker.io') {
		targetRegistry = 'docker.1ms.run';
	} else if (registry === 'ghcr.io') {
		targetRegistry = 'ghcr.1ms.run';
	} else if (registry === 'registry.k8s.io') {
		targetRegistry = 'k8s.1ms.run';
	}

	if (targetRegistry) {
		isAccelerated = true;
		let acceleratedRepo = repoAndTag;
		if (repoAndTag.includes('@')) {
			const [r] = repoAndTag.split('@');
			acceleratedRepo = r;
		} else if (repoAndTag.includes(':')) {
			const lastColon = repoAndTag.lastIndexOf(':');
			const potentialTag = repoAndTag.substring(lastColon + 1);
			if (!potentialTag.includes('/')) {
				acceleratedRepo = repoAndTag.substring(0, lastColon);
			}
		}
		pullFromImage = \`\${targetRegistry}/\${acceleratedRepo}\`;
		pullTag = tag;
		console.log(\`[Pull] 1ms Acceleration active: \${imageName} -> \${pullFromImage}\${pullTag ? ':' + pullTag : ''}\`);
	}

	const url = pullTag
		? \`/images/create?fromImage=\${encodeURIComponent(pullFromImage)}&tag=\${encodeURIComponent(pullTag)}\`
		: \`/images/create?fromImage=\${encodeURIComponent(pullFromImage)}\`;

	// We only use registry credentials for non-accelerated pulls (public mirrors don't need authentication)
	const headers = isAccelerated ? {} : await buildRegistryAuthHeader(imageName);

	console.log(\`[Pull] POST \${url} headers=\${Object.keys(headers).join(',') || '(none)'}\`);
	const response = await dockerFetch(url, { method: 'POST', streaming: true, headers }, envId);
	console.log(\`[Pull] response status=\${response.status} \${response.statusText}\`);

	if (!response.ok) {
		const body = await response.text();
		console.error(\`[Pull] error body: \${body}\`);
		throw new Error(\`Failed to pull image: \${body}\`);
	}

	const reader = response.body?.getReader();
	if (!reader) return;

	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (line.trim()) {
				try {
					const data = JSON.parse(line);
					if (data.error || data.errorDetail) {
						console.error(\`[Pull] stream error: \${line}\`);
					}
					if (onProgress) onProgress(data);
				} catch {
					// Ignore parse errors
				}
			}
		}
	}

	if (isAccelerated) {
		// Tag back to original name
		const pulledName = pullTag ? \`\${pullFromImage}:\${pullTag}\` : pullFromImage;
		let originalRepo = fromImage;
		let originalTag = tag || 'latest';
		console.log(\`[Pull] Tagging accelerated image \${pulledName} back to original \${originalRepo}:\${originalTag}\`);
		const tagUrl = \`/images/\${encodeURIComponent(pulledName)}/tag?repo=\${encodeURIComponent(originalRepo)}&tag=\${encodeURIComponent(originalTag)}\`;
		const tagResponse = await dockerFetch(tagUrl, { method: 'POST' }, envId);
		if (!tagResponse.ok) {
			const tagBody = await tagResponse.text();
			console.error(\`[Pull] Failed to tag image back: \${tagBody}\`);
			throw new Error(\`Failed to tag accelerated image back: \${tagBody}\`);
		}
		await drainResponse(tagResponse);

		// Clean up the accelerated temporary tag
		console.log(\`[Pull] Cleaning up temporary tag \${pulledName}\`);
		const removeResponse = await dockerFetch(\`/images/\${encodeURIComponent(pulledName)}?force=false\`, { method: 'DELETE' }, envId);
		await drainResponse(removeResponse);
	}
}`;
          content = content.replace(originalBlock, replacementBlock);
        }
      }
      content = content.replace(
        /const\s*\{\s*registry,\s*repo,\s*tag\s*\}\s*=\s*parseImageReference\(imageName\);\r?\n\t\tconst\s*token\s*=\s*await\s*getRegistryBearerToken\(registry,\s*repo\);\r?\n\t\tconst\s*manifestUrl\s*=\s*`https:\/\/\$\{registry\}\/v2\/\$\{repo\}\/manifests\/\$\{tag\}`;/g,
        `const { registry, repo, tag } = parseImageReference(imageName);
		let queryRegistry = registry;
		if (registry === 'index.docker.io' || registry === 'docker.io') {
			queryRegistry = 'docker.1ms.run';
		} else if (registry === 'ghcr.io') {
			queryRegistry = 'ghcr.1ms.run';
		} else if (registry === 'registry.k8s.io') {
			queryRegistry = 'k8s.1ms.run';
		}
		const token = await getRegistryBearerToken(queryRegistry, repo);
		const manifestUrl = \`https://\${queryRegistry}/v2/\${repo}/manifests/\${tag}\`;`
      );
    }

    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      replacedCount++;
    }
    processedCount++;
  }
});

console.log(`翻译完成！共处理了 ${processedCount} 个文件，修改了 ${replacedCount} 个文件。`);

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
