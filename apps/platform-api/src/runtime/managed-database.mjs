// Managed deployments name their database, login and installation explicitly.
// pg accepts authority overrides in query parameters, so those are never allowed.
export function hasSafeDatabaseParameters(database) {
  const parameters = [...database.searchParams];
  return parameters.length <= 1 && parameters.every(([key, value]) => key === 'options'
    && /^-c search_path=[a-z][a-z0-9_]{0,62}(?:,public)?$/.test(value));
}

export function isManagedDatabase(env, database, connectionString, kind) {
  const deployment = env.BAIRUI_RUNTIME_DEPLOYMENT;
  const installation = env.BAIRUI_RUNTIME_INSTALLATION;
  const host = env.BAIRUI_RUNTIME_DATABASE_HOST;
  const name = kind === 'controller' ? (deployment === 'business' ? 'bairui' : 'bairui_preprod')
    : `bairui_runtime_ledger_${deployment}`;
  const role = kind === 'controller' ? 'bairui_runtime_controller' : 'bairui_runtime_ledger';
  return ['business', 'preprod'].includes(deployment) && /^[a-f0-9]{24}$/.test(installation ?? '')
    && typeof host === 'string' && /^[a-z0-9][a-z0-9_.-]{0,252}$/.test(host)
    && env.BAIRUI_RUNTIME_DATABASE_PORT === '5432' && database.port === '5432'
    && database.hostname === host && database.username === role && !!database.password
    && database.pathname === `/${name}` && !database.hash
    && connectionString !== env.DATABASE_URL && hasSafeDatabaseParameters(database)
    && (kind !== 'orchestrator' || env.BAIRUI_ORCHESTRATOR_INSTALLATION === installation);
}
