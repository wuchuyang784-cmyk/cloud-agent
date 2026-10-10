// Separate opt-in assets: never imported into the default preproduction stack.
export function runtimeRules({ duration = '45s', interval = '15s' } = {}) {
  if (![duration, interval].every(value => typeof value === 'string' && /^[1-9][0-9]{0,3}s$/.test(value))) {
    throw new Error('runtime_rule_duration_invalid');
  }
  const selector = '{job="bairui-runtime-controller"}';
  const metric = name => 'bairui_runtime_' + name + selector;
  const up = 'up' + selector;
  const missing = name => `count(${up} == 1 unless on(instance,job) ${metric(name)}) > 0`;
  const rule = (alert, expr) => ({ alert, expr, for: duration, labels: { severity: 'critical' } });
  return { groups: [{ name: 'bairui-runtime-supervision', interval, rules: [
    rule('RuntimeControllerUnavailable', `(min(${up}) or vector(0)) < 1 or (time() - min(${metric('controller_last_success_timestamp_seconds')})) > 60 or `
      + ['controller_last_success_timestamp_seconds', 'controller_cycle_ok', 'active', 'stopping', 'stop_overdue', 'dead_pending', 'observation_errors', 'observation_stale'].map(missing).join(' or ')),
    rule('RuntimeControllerCycleFailed', `min(${metric('controller_cycle_ok')}) == 0`),
    rule('RuntimeStopOverdue', `sum(${metric('stop_overdue')}) > 0`),
    rule('RuntimeCommandDead', `sum(${metric('dead_pending')}) > 0`),
    rule('RuntimeObservationUnavailable', `sum(${metric('observation_errors')}) > 0 or sum(${metric('observation_stale')}) > 0`),
  ] }] };
}
