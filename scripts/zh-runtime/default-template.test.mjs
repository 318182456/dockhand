import assert from 'node:assert/strict';
import {test} from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {patchTemplateSource,patchDefaultTemplate} from './default-template.mjs';

const original='function Component(){const snapshot=read().defaultComposeTemplate,other=1;function preview(){return typed||snapshot}function validate(){return typed||snapshot}function open(){return initial||snapshot}function editor(){return typed||snapshot}return {preview,validate,open,editor}}';

test('read the latest template when the modal opens and preserve typed/initial content',()=>{
  const result=patchTemplateSource(original);
  let current='stock';const context={read:()=>({defaultComposeTemplate:current}),typed:'',initial:''};
  const component=vm.runInNewContext(result.source+';Component()',context);
  current='custom-shared-preset';
  for(const key of ['preview','validate','open','editor'])assert.equal(component[key](),current);
  context.typed='unsaved edit';assert.equal(component.preview(),'unsaved edit');assert.equal(component.validate(),'unsaved edit');assert.equal(component.editor(),'unsaved edit');
  context.initial='explicit initial compose';assert.equal(component.open(),'explicit initial compose');
});

test('reject missing or changed reference shapes and remain idempotent',()=>{
  assert.throws(()=>patchTemplateSource('export{};'));
  assert.throws(()=>patchTemplateSource(original.replace('typed||snapshot','typed')));
  const first=patchTemplateSource(original);const second=patchTemplateSource(first.source);
  assert.equal(second.patched,false);assert.equal(first.source,second.source);
});

test('patch the client component once without mutating unrelated modules',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dockhand-live-template-'));
  try{fs.mkdirSync(path.join(root,'client'));const component=path.join(root,'client','modal.js');const other=path.join(root,'client','other.js');fs.writeFileSync(component,original);fs.writeFileSync(other,'export const x=1;');patchDefaultTemplate(root);const once=fs.readFileSync(component,'utf8');patchDefaultTemplate(root);assert.equal(fs.readFileSync(component,'utf8'),once);assert.equal(fs.readFileSync(other,'utf8'),'export const x=1;');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
