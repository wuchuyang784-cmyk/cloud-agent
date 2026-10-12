const business = '/api/admin/grafana/d/bairui-platform/bairui-platform?kiosk';
const preprod = 'https://localhost:9443/d/bairui-platform/bairui-platform?kiosk';

export function monitoringTarget(value: unknown): { url: string; scope: 'business' | 'preprod' } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as { dashboardUrl?: unknown };
  if (data.dashboardUrl === business) return { url: business, scope: 'business' };
  if (data.dashboardUrl === undefined || data.dashboardUrl === preprod) return { url: preprod, scope: 'preprod' };
  return null;
}
