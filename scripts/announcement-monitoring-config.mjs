// Opt-in source assets for E rollout. Importing never changes a live stack or Secret.
import { publisherDashboardExpressions } from '../apps/platform-api/src/admin/grafana-dashboard.mjs';
export function announcementMonitoringAssets({ environment, targets, duration = '45s', interval = '15s' } = {}) {
  if (!['business', 'preprod', 'isolation'].includes(environment) || !Array.isArray(targets) || targets.length < 1 || targets.length > 8
    || new Set(targets).size !== targets.length || targets.some(target => typeof target !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}:[1-9][0-9]{0,4}$/.test(target) || Number(target.split(':')[1]) > 65535)
    || ![duration, interval].every(value => typeof value === 'string' && /^[1-9][0-9]{0,3}s$/.test(value))) throw new Error('announcement_monitoring_config_invalid');
  const selector = '{job="bairui-announcement-publisher",bairui_environment="' + environment + '"}';
  const metric = name => 'bairui_announcement_publisher_' + name + selector;
  const up = 'up' + selector;
  const panelExpressions = publisherDashboardExpressions(environment);
  const missing = name => `count(${up} == 1 unless on(instance,job,bairui_environment) ${metric(name)}) > 0`;
  const rule = (alert, expr) => ({ alert, expr, for: duration, labels: { severity: 'warning', bairui_environment: environment } });
  const expressions = {
    unavailable: `(min(${up}) or vector(0)) < 1 or (time() - min(${metric('last_success_timestamp_seconds')})) > 120 or `
      + ['cycle_ok', 'last_success_timestamp_seconds', 'pending', 'max_delay_seconds', 'blocked'].map(missing).join(' or '),
    failed: `min(${metric('cycle_ok')}) == 0`, delayed: `max(${metric('max_delay_seconds')}) > 60`,
    blocked: `max(${metric('blocked')}) > 0`, errors: `sum(increase(${metric('failures_total')}[5m])) > 0`,
  };
  const panel = (id, title, expr, unit) => ({ id, title, type: 'stat', datasource: { type: 'prometheus', uid: 'bairui-prometheus' },
    gridPos: { h: 6, w: 6, x: (id - 101) * 6, y: 80 }, targets: [{ refId: 'A', expr, instant: true }],
    fieldConfig: { defaults: { unit }, overrides: [] }, options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } });
  return {
    scrape: { job_name: 'bairui-announcement-publisher-' + environment, authorization: { type: 'Bearer', credentials_file: '/run/secrets/announcement-' + environment + '-metrics' },
      static_configs: [{ targets, labels: { bairui_environment: environment } }],
      relabel_configs: [{ target_label: 'job', replacement: 'bairui-announcement-publisher' }],
      scrape_interval: '15s', scrape_timeout: '5s', sample_limit: 100, label_limit: 10, label_value_length_limit: 128, body_size_limit: '64KB' },
    rules: { groups: [{ name: 'bairui-announcements-' + environment, interval, rules: [
      rule('AnnouncementPublisherUnavailable', expressions.unavailable), rule('AnnouncementPublisherCycleFailed', expressions.failed),
      rule('AnnouncementPublishDelayed', expressions.delayed), rule('AnnouncementPublishBlocked', expressions.blocked), rule('AnnouncementPublishFailed', expressions.errors),
    ] }] },
    // Shared database gauges must use max, not sum across multiple publisher replicas.
    panels: [panel(101, '公告到期待发布', panelExpressions[0], 'short'), panel(102, '公告最大发布延迟', panelExpressions[1], 's'),
      panel(103, '公告需重新确认', panelExpressions[2], 'short'), panel(104, '公告发布器周期状态', panelExpressions[3], 'short')],
  };
}
