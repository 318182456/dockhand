import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./inject.mjs',import.meta.url),'utf8');
const literal=/^const PUSH_RE = \/(.+)\/g;$/m.exec(source)?.[1];
assert.ok(literal,'Compose push matcher must remain identifiable');
const matches=text=>[...text.matchAll(new RegExp(literal,'g'))];
for(const [version,extra]of [['1.0.55',''],['1.0.56','pullBase:q,noBuild:z,']]){
 test('recognize '+version+' argument list without losing operation bindings',()=>{
  const text='k.push(...si(t,{forceRecreate:i,removeVolumes:l,build:h,noBuildCache:g,'+extra+'pullPolicy:w,serviceName:p}))';
  const hits=matches(text);assert.equal(hits.length,1);assert.deepEqual(hits[0].slice(1),['k','t','w','p']);assert.equal(hits[0][0],text);
 });
}
test('reject incomplete or unrelated operation objects',()=>{
 assert.equal(matches('k.push(...si(t,{forceRecreate:i,removeVolumes:l,build:h,pullPolicy:w,serviceName:p}))').length,0);
 assert.equal(matches('k.push(...si(t,{build:h,pullPolicy:w}))').length,0);
});