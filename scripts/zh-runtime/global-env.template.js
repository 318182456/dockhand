// Opt in using a shared env file, or a legacy named Config Set.
// These are plain-text interpolation defaults, not a secret store.
async function __zhReadGlobalDefaults(getConfigSets) {
  const file = (process.env.ZH_GLOBAL_ENV_FILE || '').trim();
  const selected = (process.env.ZH_GLOBAL_ENV_CONFIG_SET || '').trim();
  let entries;
  if (file) {
    const path = await import('node:path');
    if (!path.isAbsolute(file)) throw new Error('[GlobalEnv] Shared env path must be absolute');
    try {
      const fs = await import('node:fs');
      const { parseEnv } = await import('node:util');
      const raw = fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('too large');
      entries = Object.entries(parseEnv(raw)).map(([key,value]) => ({key,value}));
    } catch { throw new Error('[GlobalEnv] Shared env file cannot be read'); }
  } else {
    if (!selected || selected === 'off') return null;
    const sets = await getConfigSets();
    const matches = sets.filter(set => set.name === selected);
    if (matches.length !== 1) throw new Error('[GlobalEnv] Config Set not found or ambiguous');
    entries = matches[0].envVars || [];
  }
  const globals = Object.create(null);
  for (const entry of entries) {
    const key = entry.key;
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        /^(?:DOCKER_|COMPOSE_|NODE_|LD_|DYLD_)/.test(key) ||
        ['PATH', 'HOME', 'SHELL', 'BASH_ENV', 'ENV', 'PWD', 'TMPDIR', 'TMP', 'TEMP', '__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new Error('[GlobalEnv] Invalid or reserved variable name');
    }
    if (typeof entry.value !== 'string' || entry.value.includes('\0')) throw new Error('[GlobalEnv] Invalid variable value');
    if (Object.hasOwn(globals, key)) throw new Error('[GlobalEnv] Duplicate variable name');
    globals[key] = entry.value;
  }
  // A container can expose several routers with independent subdomains/ports.
  // Docker's defaultRule has no per-router name in its template model, so those
  // routers use an explicit HostRegexp label with this derived root pattern.
  if (Object.hasOwn(globals, 'TRAEFIK_DOMAINS')) {
    const { domainToASCII } = await import('node:url');
    const entries = globals.TRAEFIK_DOMAINS.split(',').map(value => value.trim()).filter(Boolean);
    const domains = [...new Set(entries.map(value =>
      domainToASCII(value.replace(/\.$/, '')).toLowerCase()))];
    if (!domains.length || domains.some(domain => !domain || domain.length > 253 ||
        domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
      throw new Error('[GlobalEnv] Invalid TRAEFIK_DOMAINS list');
    }
    globals.TRAEFIK_DOMAIN_REGEX = domains.map(domain => domain.replaceAll('.', '[.]')).join('|');
  }
  return globals;
}

async function __zhGlobalEnv(options, envVars, secretVars, getConfigSets) {
  const globals = await __zhReadGlobalDefaults(getConfigSets);
  if (!globals || !Object.keys(globals).length) return secretVars;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const composeDir = options.composePath ? path.dirname(options.composePath) : options.workingDir;
  // All native callers must supply a resolved directory. Refuse to guess and
  // accidentally override an application's .env when an upstream caller changes.
  if (!composeDir) throw new Error('[GlobalEnv] Stack directory is unavailable');
  const paths = new Set([path.join(composeDir, '.env')]);
  if (options.envPath) paths.add(options.envPath);
  const contents = [];
  for (const file of paths) {
    try { contents.push(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('[GlobalEnv] Cannot read stack env file'); }
  }
  // Hawser may receive files before they have been staged locally.
  for (const [name, content] of Object.entries(options.stackFiles || {})) {
    if (path.basename(name) === '.env' && typeof content === 'string') contents.push(content);
  }
  for (const content of contents) {
    // Conservative key collection: never let a global shell value override a
    // key declared in an app env file, including blank and exported values.
    for (const match of content.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/gm)) delete globals[match[1]];
  }
  for (const key of Object.keys(envVars || {})) delete globals[key];
  for (const key of Object.keys(secretVars || {})) delete globals[key];
  // Route through the native secret-variable channel so Compose gets the shell
  // defaults even when --env-file is used, and native log redaction includes them.
  // No files/DB rows are written; globals never become persisted stack secrets.
  return { ...globals, ...(secretVars || {}) };
}
