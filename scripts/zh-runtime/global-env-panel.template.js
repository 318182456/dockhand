/* __zhGlobalEnvPanel */
(() => {
  if (typeof window === 'undefined' || window.__zhGlobalEnvPanelInstalled) return;
  window.__zhGlobalEnvPanelInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  let metadata = null, values = {}, status = '', version = 0, scheduled = false;
  const chinese = () => (document.documentElement.lang || '').toLowerCase().startsWith('zh') ||
    [...document.querySelectorAll('[role="dialog"] span')].some(e => e.textContent.trim() === '环境变量');
  const label = (zh, en) => chinese() ? zh : en;
  const create = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  }
  function render() {
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      const heading = [...dialog.querySelectorAll('span')].find(e =>
        ['Environment variables', '环境变量', '環境変数'].includes(e.textContent.trim()));
      if (!heading) continue;
      const header = heading.parentElement?.parentElement?.parentElement;
      if (!header) continue;
      let root = header.querySelector('[data-zh-global-env-panel]');
      if (!metadata?.variables?.length) { root?.remove(); continue; }
      const signature = version + ':' + status;
      if (root?.dataset.signature === signature) continue;
      const next = create('details'); next.open = true;
      next.dataset.zhGlobalEnvPanel = ''; next.dataset.signature = signature;
      next.style.cssText = 'border-top:1px solid var(--border,#bbb5);padding-top:6px;font-size:12px;min-width:0';
      const summary = create('summary', label('全局变量', 'Global variables') + ' · ' + metadata.source + ' (' + metadata.variables.length + ')');
      summary.style.cssText = 'cursor:pointer;font-weight:600;padding:2px 0 6px';
      next.append(summary);
      const scroll = create('div'); scroll.style.cssText = 'max-height:224px;overflow:auto';
      const table = create('table'); table.style.cssText = 'width:100%;border-collapse:collapse;text-align:left';
      const titles = create('tr');
      for (const text of [label('名称','Name'),label('值','Value'),label('来源','Source')]) titles.append(create('th',text));
      table.append(titles);
      for (const variable of metadata.variables) {
        const row = create('tr'); row.dataset.globalKey = variable.key;
        const key = create('td',variable.key);
        const value = create('td',status === 'ready' ? (values[variable.key] ?? '') :
          status === 'error' ? label('无法读取','Unavailable') : label('读取中…','Loading…'));
        const source = create('td',metadata.source + (variable.derived ? label('（派生）',' (derived)') : ''));
        for (const cell of [key,value,source]) cell.style.cssText = 'padding:4px 8px 4px 0;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap';
        key.style.fontFamily = value.style.fontFamily = 'monospace';
        row.append(key,value,source); table.append(row);
      }
      scroll.append(table); next.append(scroll);
      const hint = create('div',label('全局默认值；同名堆栈变量优先。在全局配置集中修改。','Global defaults; stack variables with the same name take precedence. Edit in global settings.'));
      hint.style.cssText = 'opacity:.7;padding-top:5px'; next.append(hint);
      if (root) root.replaceWith(next); else header.append(next);
    }
  }
  async function readValues(current, token) {
    try {
      // Reuse the native Config Sets endpoint and its authorization checks.
      const response = await nativeFetch('/api/config-sets');
      if (!response.ok) throw Error('not authorized');
      const sets = await response.json();
      if (token !== version) return;
      const selected = sets.find(set => set.name === current.source);
      if (!selected) throw Error('config set missing');
      const record = Object.fromEntries((selected.envVars || []).map(item => [item.key,item.value]));
      if (current.variables.some(item => item.derived && item.key === 'TRAEFIK_DOMAIN_REGEX')) {
        const roots = [...new Set(String(record.TRAEFIK_DOMAINS || '').split(',').map(value => value.trim().replace(/\.$/,'')).filter(Boolean).map(value =>
          new URL('http://' + value).hostname.toLowerCase()))];
        record.TRAEFIK_DOMAIN_REGEX = roots.map(value => value.replaceAll('.','[.]')).join('|');
      }
      values = Object.fromEntries(current.variables.map(item => [item.key, String(record[item.key] ?? '')]));
      status = 'ready';
    } catch {
      if (token !== version) return;
      values = {}; status = 'error';
    }
    schedule();
  }
  window.fetch = function(input, init) {
    const promise = nativeFetch(input, init);
    const address = typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '';
    if (/\/api\/stacks\/[^/]+\/env\/validate(?:\?|$)/.test(address)) {
      promise.then(response => response.ok ? response.clone().json() : null).then(data => {
        metadata = data?.globalEnv || null; values = {}; status = 'loading'; const token = ++version;
        schedule();
        if (metadata?.variables?.length) void readValues(metadata,token);
      }).catch(() => {});
    }
    return promise;
  };
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
})();
