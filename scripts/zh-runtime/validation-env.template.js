// Validation uses its own temporary Compose runner, outside the deploy dispatcher.
async function __zhValidationEnv(name, compose, context, env, getSets, getSource, getDirectory) {
  const selected = (process.env.ZH_GLOBAL_ENV_CONFIG_SET || '').trim();
  if (!selected || selected === 'off') return { compose, env };
  const path = await import('node:path');
  const source = context?.existing ? await getSource(name, context.environmentId ?? null) : null;
  const directory = source?.composePath
    ? path.dirname(source.composePath)
    : await getDirectory(name, context?.environmentId ?? undefined);
  const defaults = await __zhGlobalEnv({
    workingDir: directory, composePath: source?.composePath, envPath: source?.envPath
  }, env, {}, getSets);
  const merged = { ...defaults, ...(env || {}) };
  // Keep the upstream validator's isolated env_file stubs. Resolve only extends
  // paths against the real stack location before writing the temporary YAML.
  const yamlModule = await import('js-yaml');
  const yaml = yamlModule.default || yamlModule;
  let document;
  try { document = yaml.load(compose); } catch { return { compose, env: merged }; }
  let changed = false;
  for (const service of Object.values(document?.services || {})) {
    const extension = service?.extends;
    if (!extension || typeof extension !== 'object' || typeof extension.file !== 'string') continue;
    const resolved = extension.file.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (whole, key) => Object.hasOwn(merged, key) ? merged[key] : whole);
    if (resolved.includes('$')) continue; // Let Compose report missing/unsupported variables.
    const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(directory, resolved);
    if (absolute !== extension.file) { extension.file = absolute; changed = true; }
  }
  return { compose: changed ? yaml.dump(document, { lineWidth: -1, noRefs: true }) : compose, env: merged };
}


// The editor's missing-variable markers use a separate name-only endpoint.
async function __zhGlobalEnvMarkers(result, getSets) {
  const globals = await __zhReadGlobalDefaults(getSets);
  if (!globals) return result;
  const referenced = new Set([...(result.required || []), ...(result.optional || [])]);
  const supplied = Object.keys(globals).filter(key => referenced.has(key));
  const defined = [...new Set([...(result.defined || []), ...supplied])].sort();
  const missing = (result.missing || []).filter(key => !Object.hasOwn(globals, key));
  // Never send global values, or mark unreferenced shared defaults as unused.
  const source = process.env.ZH_GLOBAL_ENV_CONFIG_SET.trim();
  const variables = Object.keys(globals).sort().map(key => ({ key, derived: key === 'TRAEFIK_DOMAIN_REGEX' && Object.hasOwn(globals, 'TRAEFIK_DOMAINS') }));
  return { ...result, defined, missing, valid: missing.length === 0, globalEnv: { source, variables } };
}

