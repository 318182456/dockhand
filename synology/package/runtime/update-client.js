(() => {
 if(globalThis.__dockhandNativeTransport)return;globalThis.__dockhandNativeTransport=true;
 const original=globalThis.fetch.bind(globalThis);
 // Keep the existing update dialog in its progress phase while the package replaces its own gateway.
 globalThis.fetch=async(input,init)=>{let u;try{u=new URL(typeof input==='string'?input:input.url,location.href);}catch{return original(input,init);}if(u.origin!==location.origin||u.pathname!=='/api/self-update/progress'||!/^native-[0-9a-f-]{36}$/.test(u.searchParams.get('id')||''))return original(input,init);
  const end=Date.now()+15*60*1000;while(Date.now()<end){try{const r=await original(u.href,{...init,signal:AbortSignal.timeout(5000)});if(r.ok)return r;if(![401,502,503,504].includes(r.status))return new Response(JSON.stringify({status:'exited',exitCode:1,logs:'更新进度读取失败：HTTP '+r.status}),{headers:{'content-type':'application/json'}});}catch{}await new Promise(resolve=>setTimeout(resolve,2000));}
  return new Response(JSON.stringify({status:'exited',exitCode:1,logs:'原生更新连接超时，请在群晖套件中心检查 DockhandNative 状态。'}),{headers:{'content-type':'application/json'}});
 };
 const labels=new Map([
 ['Container','原生套件'],['Current image','当前套件'],['New image','新版套件'],['Image','套件'],
 ['Pulling new image','检查套件版本'],['Building container config','准备更新任务'],['Pulling updater','检查更新服务'],['Creating new container','登记更新任务'],['Launching updater','启动更新任务'],['Stopping Dockhand','下载及校验套件'],['Removing old container','备份数据库与配置'],['Renaming container','安装原生套件'],['Connecting networks','恢复原生服务'],['Starting Dockhand','验证新版本'],
 ['Stopping container','下载及校验套件'],['Container stopped','套件校验完成'],['Old container removed','备份完成'],['Container renamed','套件安装完成'],['Connecting to network','恢复原生服务'],['Networks connected','服务已恢复'],['Starting container','验证新版本'],['Container is running','新版本验证通过']]);
 function refresh(){for(const dialog of document.querySelectorAll('[role="dialog"]')){if(!dialog.textContent.includes('DockhandNative')&&!dialog.textContent.includes('原生套件'))continue;const walker=document.createTreeWalker(dialog,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){const v=node.nodeValue.trim();if(labels.has(v))node.nodeValue=node.nodeValue.replace(v,labels.get(v));}}}
 let pending=false;new MutationObserver(()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;refresh();});}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});refresh();
})();