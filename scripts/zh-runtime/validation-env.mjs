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
function dbExport(items, key) {
  const found = [];
  for (const item of items) {
    const pattern = new RegExp('(?:[,{])\\s*' + key + '\\s*:\\s*([\\w$]+)\\s*(?=[,}])', 'g');
    for (const match of item.source.matchAll(pattern)) {
      const local = match[1];
      for (const clause of item.source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
        for (const entry of clause[1].split(',')) {
          const binding = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(entry);
          if (binding?.[1] === local) found.push({ file: item.file, key: binding[2] || local });
        }
      }
    }
  }
  if (found.length !== 1) throw Error('ValidationEnv: expected one DB export for ' + key);
  return found[0];
}
function relative(from, to) {
  let value = path.relative(path.dirname(from), to).split(path.sep).join('/');
  return value.startsWith('.') ? value : './' + value;
}
export function injectValidationEnv(buildDir, templatePath, globalTemplatePath) {
  const items = [...walk(path.join(buildDir, 'server'))].map(file => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const targets = items.filter(x => x.source.includes('"dockhand-validate-"') && x.source.includes('COMPOSE_SCHEMA_ERROR'));
  if (targets.length !== 1) throw Error('ValidationEnv: expected one isolated validator');
  const target = targets[0];
  if (target.source.includes('/* __zhValidationEnv */')) return { patched: false, file: target.file };
  const sets = dbExport(items, 'getConfigSets'), stack = dbExport(items, 'getStackSource');
  const directories = [];
  for (const item of items.filter(x => x.source.includes('source:"default"') && x.source.includes('stackDir:'))) {
    const getter = /else\s+[\w$]+\s*=\s*await\s+([\w$]+)\([^)]*\);return json\(\{stackDir:/.exec(item.source)?.[1];
    if (!getter) continue;
    for (const statement of item.source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      for (const entry of statement[1].split(',')) {
        const binding = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(entry);
        if (binding && (binding[2] || binding[1]) === getter) directories.push({
          file: path.resolve(path.dirname(item.file), statement[2]), key: binding[1]
        });
      }
    }
  }
  if (directories.length !== 1) throw Error('ValidationEnv: expected one stack-directory export');
  const directory = directories[0];
  const load = ref => 'async(...args)=>{const m=await import(' + JSON.stringify(relative(target.file, ref.file)) + ');return m[' + JSON.stringify(ref.key) + '](...args);}';
  let source = target.source;
  const isolated = /async function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+);try\{\6=await mkdtemp\(join\(tmpdir\(\),"dockhand-validate-"\)\)/g;
  const matches = [...source.matchAll(isolated)];
  if (matches.length !== 1) throw Error('ValidationEnv: isolated runner shape changed');
  const [, runner, name, compose, dockerHost, env] = matches[0];
  const header = 'async function ' + runner + '(' + [name, compose, dockerHost, env].join(',') + '){';
  source = source.replace(header, () => 'async function ' + runner + '(' + [name, compose, dockerHost, env, '__zhContext'].join(',') + '){' +
    'const __zhv=await __zhValidationEnv(' + [name, compose, '__zhContext', env, load(sets), load(stack), load(directory)].join(',') + ');' +
    compose + '=__zhv.compose;' + env + '=__zhv.env;/* __zhValidationEnv */');
  const escape = value => value.replace(/[$]/g, '\\$');
  const callers = [...source.matchAll(new RegExp('async function ([\\w$]+)\\(([^()]*)\\)\\{const ([\\w$]+)=([\\w$]+)\\([^;]*?\\),([\\w$]+)=await ' + escape(runner) + '\\(([^()]*)\\);if\\(', 'g'))];
  if (callers.length !== 1) throw Error('ValidationEnv: linter caller shape changed');
  const [, lint, parameters, , , , argumentsText] = callers[0];
  if (parameters.split(',').length !== 6 || argumentsText.split(',').length !== 4) throw Error('ValidationEnv: linter signature changed');
  source = source.replace('async function ' + lint + '(' + parameters + '){', () => 'async function ' + lint + '(' + parameters + ',__zhContext){');
  source = source.replace('await ' + runner + '(' + argumentsText + ')', () => 'await ' + runner + '(' + argumentsText + ',__zhContext)');
  const callsites = [...source.matchAll(new RegExp('await ' + escape(lint) + '\\(([^();]*)\\)', 'g'))];
  if (callsites.length !== 1) throw Error('ValidationEnv: API caller shape changed');
  const args = callsites[0][1].split(',');
  const body = /^([\w$]+)\.config\?\?\{\}$/.exec(args[4])?.[1];
  const url = /const [\w$]+=async\(\{cookies:[\w$]+,url:([\w$]+),params:[\w$]+,request:[\w$]+\}\)=>/.exec(source)?.[1];
  if (args.length !== 6 || !body || !url) throw Error('ValidationEnv: request context shape changed');
  source = source.replace(callsites[0][0], () => callsites[0][0].slice(0, -1) +
    ',{existing:!!' + body + '.existing,environmentId:Number(' + url + '.searchParams.get("env"))||null})');
  source += '\n' + fs.readFileSync(globalTemplatePath, 'utf8') + '\n' + fs.readFileSync(templatePath, 'utf8');
  fs.writeFileSync(target.file, source);
  return { patched: true, file: target.file };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , build, template, globalTemplate] = process.argv;
  const result = injectValidationEnv(build, template, globalTemplate);
  console.log('全局变量校验补丁: ' + path.relative(build, result.file) + ' (' + (result.patched ? '已注入' : '已存在') + ')');
}

