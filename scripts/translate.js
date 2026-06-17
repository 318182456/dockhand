import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
