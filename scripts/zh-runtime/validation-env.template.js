// Validation uses its own temporary Compose runner, outside the deploy dispatcher.
async function __zhValidationEnv(name, compose, context, env, getSource, getDirectory) {
  const path = await import('node:path');
  const source = context?.existing ? await getSource(name, context.environmentId ?? null) : null;
  const directory = source?.composePath
    ? path.dirname(source.composePath)
    : await getDirectory(name, context?.environmentId ?? undefined);
  const merged = env || {};
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
