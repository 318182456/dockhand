import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (file.endsWith('.js')) yield file;
  }
}

function bodyEnd(source, start) {
  let depth = 0, quote = '', escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('GlobalEnv: unterminated upstream function');
}

export function injectGlobalEnv(buildDir, templatePath) {
  const files = [...walk(path.join(buildDir, 'server'))].map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const targets = [];
  for (const item of files) {
    if (!item.source.includes('hawser-standard') || !item.source.includes('Read ${')) continue;
    for (const match of item.source.matchAll(/async function ([\w$]+)\(([^(){}]*)\)\{/g)) {
      const start = match.index + match[0].length - 1;
      const body = item.source.slice(start, bodyEnd(item.source, start));
      if (!body.includes('hawser-standard') || !body.includes('hawser-edge') || !body.includes('vars from .env file for Hawser injection')) continue;
      const params = match[2].split(',');
      if (params.length !== 6 || !params.every(param => /^[\w$]+$/.test(param))) throw new Error('GlobalEnv: upstream Compose signature changed');
      targets.push({ ...item, start, params });
    }
  }
  if (targets.length !== 1) throw new Error(`GlobalEnv: expected one Compose dispatcher, found ${targets.length}`);
  const target = targets[0];
  if (target.source.includes('/* __zhGlobalEnvDispatcher */')) {
    if (!target.source.includes('async function __zhGlobalEnv(')) throw new Error('GlobalEnv: incomplete prior injection');
    return { patched: false, file: target.file };
  }
  const providers = [];
  for (const item of files) {
    for (const match of item.source.matchAll(/(?:[,{])\s*getConfigSets\s*:\s*([\w$]+)\s*(?=[,}])/g)) {
      const escaped = match[1].replace(/[$]/g, '\\$');
      // Rollup emits spaced export lists in the official image; esbuild's
      // compact lists used in early fixtures are not representative of those.
      // Resolve only ESM export clauses, accepting whitespace and shorthand.
      const binding = new RegExp('^\\s*' + escaped + '(?:\\s+as\\s+([\\w$]+))?\\s*$');
      const exported = [...item.source.matchAll(/\bexport\s*\{([^}]*)\}/g)]
        .flatMap(clause => clause[1].split(','))
        .map(entry => binding.exec(entry))
        .filter(Boolean);
      if (exported.length === 1) providers.push({ file: item.file, key: exported[0][1] || match[1] });
    }
  }
  if (providers.length !== 1) throw new Error(`GlobalEnv: expected one Config Set DB export, found ${providers.length}`);
  const provider = providers[0];
  let relative = path.relative(path.dirname(target.file), provider.file).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = './' + relative;
  const [, options, , envVars, secretVars] = target.params;
  const call = `${secretVars}=await __zhGlobalEnv(${options},${envVars},${secretVars},async()=>{const m=await import(${JSON.stringify(relative)});return m[${JSON.stringify(provider.key)}]();});/* __zhGlobalEnvDispatcher */`;
  const template = fs.readFileSync(templatePath, 'utf8');
  if (target.source.includes('__zhGlobalEnv')) throw new Error('GlobalEnv: identifier conflict');
  const result = target.source.slice(0, target.start + 1) + call + target.source.slice(target.start + 1) + '\n' + template;
  fs.writeFileSync(target.file, result);
  return { patched: true, file: target.file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , buildDir, templatePath] = process.argv;
  if (!buildDir || !templatePath) throw new Error('Usage: node global-env.mjs <buildDir> <templatePath>');
  const result = injectGlobalEnv(buildDir, templatePath);
  console.log(`全局变量部署补丁: ${path.relative(buildDir, result.file)} (${result.patched ? '已注入' : '已存在'})`);
}
