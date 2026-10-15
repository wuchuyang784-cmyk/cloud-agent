const dashboard = '/api/admin/grafana/d/bairui-platform/bairui-platform?kiosk';

export function monitoringTarget(value: unknown): { url: string; scope: 'business' | 'preprod' } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as { dashboardUrl?: unknown; scope?: unknown };
  if (data.dashboardUrl === dashboard && (data.scope === 'business' || data.scope === 'preprod')) return { url: dashboard, scope: data.scope };
  return null;
}
