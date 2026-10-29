import fs from 'node:fs';
import path from 'node:path';

export function patchTemplateSource(source) {
  const mark='/* __zhLiveComposeDefault */';
  if(source.includes(mark))return {source,patched:false};
  const bindings=[...source.matchAll(/const ([\w$]+)=([\w$]+)\(\)\.defaultComposeTemplate(?=[,;])/g)];
  if(bindings.length!==1)throw new Error(`Default template: expected one snapshot binding, found ${bindings.length}`);
  const binding=bindings[0];
  let scope;
  const declarations=[...source.matchAll(/function [\w$]+\([^(){}]*\)\{/g)].filter(x=>x.index<binding.index);
  for(const declaration of declarations.reverse()){
    // Ignore unrelated earlier helpers whose regex literals are not this
    // component's structure; select the nearest enclosing function only.
    let end;try{end=functionEnd(source,declaration.index+declaration[0].length-1);}catch{continue;}
    if(end>binding.index){scope={start:declaration.index,end};break;}
  }
  if(!scope)throw new Error('Default template: component scope not found');
  const name=binding[1];
  const escaped=name.replace(/[$]/g,'\\$');
  const body=source.slice(scope.start,scope.end);
  const references=[...body.matchAll(new RegExp('(?<![\\w$])'+escaped+'(?![\\w$])','g'))]
    .map(match=>scope.start+match.index);
  // One declaration plus preview, validation, reset-on-open and editor fallback.
  // Recheck when upstream changes rather than silently missing an active read.
  if(references.length!==5||references[0]!==binding.index+'const '.length)
    throw new Error(`Default template: unexpected snapshot references (${references.length})`);
  let result=source;
  for(const at of references.slice(1).reverse())result=result.slice(0,at)+name+'()'+result.slice(at+name.length);
  result=result.slice(0,binding.index)+binding[0].replace('='+binding[2]+'()', '=()=>'+binding[2]+'()')+result.slice(binding.index+binding[0].length);
  return {source:result+'\n'+mark+'\n',patched:true};
}

function functionEnd(source,start){
  let depth=0,quote='',escaped=false;
  for(let i=start;i<source.length;i++){
    const c=source[i];
    if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"||c==='`')quote=c;
    else if(c==='{')depth++;
    else if(c==='}'&&--depth===0)return i+1;
  }
  throw new Error('Default template: unterminated function');
}

export function patchDefaultTemplate(buildDir){
  let count=0;
  function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,item.name);
    if(item.isDirectory())walk(file);
    else if(file.endsWith('.js')){
      const before=fs.readFileSync(file,'utf8');
      if(!before.includes('/* __zhLiveComposeDefault */')&&!/const [\w$]+=[\w$]+\(\)\.defaultComposeTemplate/.test(before))continue;
      const result=patchTemplateSource(before);count++;
      if(result.patched)fs.writeFileSync(file,result.source);
    }
  }}
  walk(path.join(buildDir,'client'));
  if(count!==1)throw new Error(`Default template: expected one client component, found ${count}`);
  console.log('已修正新建堆栈读取最新默认模板');
}
