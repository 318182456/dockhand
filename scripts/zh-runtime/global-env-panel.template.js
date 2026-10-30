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
      next.className = 'rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden';
      next.style.cssText = 'font-size:12px;min-width:0;margin-top:2px;box-shadow:0 1px 2px #00000004';
      const summary = create('summary');
      summary.style.cssText = 'cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;list-style:none;user-select:none';
      const title = create('span');
      title.style.cssText = 'display:flex;align-items:center;gap:7px;font-weight:600;white-space:nowrap';
      const chevron = create('span','⌄'); chevron.style.cssText = 'opacity:.55;font-size:15px;line-height:1';
      const count = create('span',String(metadata.variables.length));
      count.style.cssText = 'font-size:10px;line-height:18px;min-width:18px;text-align:center;border-radius:5px;background:#3b82f612;color:#3b82f6;padding:0 4px;font-weight:600';
      title.append(chevron,create('span',label('全局变量','Global variables')),count);
      const source = create('span',label('来源：','Source: ') + metadata.source);
      source.style.cssText = 'font-size:11px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      summary.append(title,source); next.append(summary);
      const scroll = create('div');
      scroll.style.cssText = 'max-height:224px;overflow:auto;scrollbar-gutter:stable;border-top:1px solid #a1a1aa24';
      const table = create('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;table-layout:fixed;text-align:left;font-size:12px;line-height:1.55';
      const colgroup = create('colgroup'), keyCol = create('col'), valueCol = create('col');
      keyCol.style.width = '190px'; colgroup.append(keyCol,valueCol); table.append(colgroup);
      const thead = create('thead'), titles = create('tr');
      for (const text of [label('名称','Name'),label('值','Value')]) {
        const cell = create('th',text);
        cell.style.cssText = 'padding:6px 12px;font-size:10px;font-weight:500;opacity:.55;background:rgba(127,127,127,.035)';
        titles.append(cell);
      }
      thead.append(titles); table.append(thead);
      const body = create('tbody');
      for (const variable of metadata.variables) {
        const row = create('tr'); row.dataset.globalKey = variable.key;
        row.style.cssText = 'border-top:1px solid #a1a1aa1a';
        const key = create('td',variable.key);
        key.style.cssText = 'padding:8px 12px;vertical-align:top;white-space:nowrap;font:500 11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace';
        key.title = variable.key + ' · ' + metadata.source + (variable.derived ? label('（派生）',' (derived)') : '');
        const value = create('td',status === 'ready' ? (values[variable.key] ?? '') :
          status === 'error' ? label('无法读取','Unavailable') : label('读取中…','Loading…'));
        value.style.cssText = 'padding:8px 12px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap;font:400 11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;user-select:text';
        row.append(key,value); body.append(row);
      }
      table.append(body); scroll.append(table); next.append(scroll);
      const footer = create('div');
      footer.style.cssText = 'padding:7px 12px;border-top:1px solid #a1a1aa24;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px';
      const hint = create('span',label('全局默认值 · 堆栈同名变量优先','Global defaults · Stack overrides take precedence'));
      hint.style.opacity = '.5';
      const link = create('a',label('管理全局变量 ↗','Manage globals ↗'));
      link.href = '/settings?tab=config-sets'; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.style.cssText = 'color:#3b82f6;text-decoration:none;white-space:nowrap';
      if (metadata.sourceType === 'file') {hint.textContent=label('共享 global.env · 堆栈同名变量优先','Shared global.env · Stack overrides take precedence'); footer.append(hint);} else footer.append(hint,link); next.append(footer);
      if (root) root.replaceWith(next); else header.append(next);
    }
  }
  async function readValues(current, token) {
    try {
      if (current.sourceType === 'file') {
        if (token !== version) return;
        values = Object.fromEntries(current.variables.map(item => [item.key, String(current.values?.[item.key] ?? '')]));
        status = 'ready'; schedule(); return;
      }
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
