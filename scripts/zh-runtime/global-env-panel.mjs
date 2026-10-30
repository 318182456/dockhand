import fs from 'node:fs';
import path from 'node:path';
export function patchGlobalEnvPanel(buildDir, templatePath) {
  const candidates = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())walk(file);
      else if(file.endsWith('.js')) {
        const source=fs.readFileSync(file,'utf8');
        if(source.includes('/env/validate') && source.includes('defaultComposeTemplate')) candidates.push({file,source});
      }
    }
  }
  walk(path.join(buildDir,'client'));
  if(candidates.length!==1)throw Error('GlobalEnvPanel: expected one stack modal client');
  const target=candidates[0];
  if(target.source.includes('/* __zhGlobalEnvPanel */'))return {patched:false,file:target.file};
  fs.writeFileSync(target.file,target.source+'\n'+fs.readFileSync(templatePath,'utf8'));
  return {patched:true,file:target.file};
}
