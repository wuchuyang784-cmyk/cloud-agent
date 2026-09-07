export interface User {
  userId: string;
  organizationId: string;
  role: string;
  email: string;
}

export interface BackendAgent {
  id: string;
  name: string;
  status: string;
  runtimeKind?: string;
  host?: string;
  runtimeUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt?: string;
}

export interface BackendChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt?: string;
}

export type ResourceKind = 'knowledge_base' | 'skill' | 'tool' | 'plugin';

export interface BackendResource {
  id: string;
  kind: ResourceKind;
  name: string;
  description?: string | null;
  status: 'active' | 'archived';
  config: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResourceContentItem {
  id: string;
  resourceId: string;
  kind: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResourceDetail {
  resource: BackendResource;
  contentItems: ResourceContentItem[];
}

export interface ResourceInput {
  kind: ResourceKind;
  name: string;
  description?: string;
  content?: string;
}

export interface ResourcePatch {
  name?: string;
  description?: string | null;
  status?: 'active' | 'archived';
  config?: Record<string, unknown>;
  content?: string | null;
}

export interface UsagePayload {
  range: string;
  updatedAt: string;
  summary: {
    totalCalls: number;
    failedCalls: number;
    successRate: number;
    avgLatencyMs: number;
    totalTokens: number;
    estimatedCostUsd: number;
    totalConversations: number;
    activeAgents: number;
  };
  modelBreakdown: unknown[];
  series: unknown[];
}

const API_BASE = import.meta.env.VITE_API_BASE || '';
const DEV_EMAIL = import.meta.env.VITE_DEV_EMAIL || 'dev@example.test';
const DEV_PASSWORD = import.meta.env.VITE_DEV_PASSWORD || 'dev-password-change-me';

type ApiError = Error & { status?: number };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(API_BASE + path, {
    ...init,
    credentials: 'include',
    headers: { accept: 'application/json', ...init.headers },
  });

  if (!response.ok) {
    let message = String(response.status) + ' ' + response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message || message;
    } catch {
      // Keep the HTTP status when the server did not return JSON.
    }
    const error = new Error(message) as ApiError;
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return undefined as T;

  return response.json() as Promise<T>;
}

export async function fetchResources(kind?: ResourceKind): Promise<BackendResource[]> {
  const query = kind ? '?kind=' + encodeURIComponent(kind) : '';
  return (await request<{ resources: BackendResource[] }>('/api/user/resources' + query)).resources;
}

export async function createResource(input: ResourceInput): Promise<BackendResource> {
  return (
    await request<{ resource: BackendResource }>('/api/user/resources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  ).resource;
}

export async function updateResource(id: string, patch: ResourcePatch): Promise<BackendResource> {
  return (
    await request<{ resource: BackendResource }>(
      '/api/user/resources/' + encodeURIComponent(id),
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    )
  ).resource;
}

export async function deleteResource(id: string): Promise<void> {
  await request<void>('/api/user/resources/' + encodeURIComponent(id), { method: 'DELETE' });
}

export async function fetchResource(id: string): Promise<ResourceDetail> {
  return request<ResourceDetail>('/api/user/resources/' + encodeURIComponent(id));
}

export async function fetchHealth(): Promise<{ status: string; database: string }> {
  return request<{ status: string; database: string }>('/healthz');
}

export async function ensureDevSession(): Promise<User> {
  try {
    return (await request<{ user: User }>('/api/auth/me')).user;
  } catch (error) {
    if ((error as ApiError).status !== 401) throw error;
  }

  return (
    await request<{ user: User }>('/api/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
    })
  ).user;
}

export async function fetchAgents(): Promise<BackendAgent[]> {
  return (await request<{ agents: BackendAgent[] }>('/api/user/agents')).agents;
}

export async function createAgent(name: string): Promise<BackendAgent> {
  return (
    await request<{ agent: BackendAgent }>('/api/user/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'console-create-' + crypto.randomUUID(),
      },
      body: JSON.stringify({ name }),
    })
  ).agent;
}

export async function createSession(agentId: string, title: string): Promise<Session> {
  return (
    await request<{ session: Session }>(
      '/api/user/agents/' + encodeURIComponent(agentId) + '/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    )
  ).session;
}

export async function fetchMessages(agentId: string, sessionId: string): Promise<BackendChatMessage[]> {
  return (
    await request<{ messages: BackendChatMessage[] }>(
      '/api/user/agents/' +
        encodeURIComponent(agentId) +
        '/sessions/' +
        encodeURIComponent(sessionId) +
        '/messages',
    )
  ).messages;
}

export async function streamChat(
  agentId: string,
  sessionId: string,
  message: string,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const path =
    '/api/user/agents/' +
    encodeURIComponent(agentId) +
    '/sessions/' +
    encodeURIComponent(sessionId) +
    '/chat/stream';
  const response = await fetch(API_BASE + path, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });

  if (!response.ok || !response.body) {
    throw new Error('Chat request failed: ' + response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (frame: string) => {
    const event = frame.match(/^event:\s*(.+)$/m)?.[1] || 'message';
    const raw = frame.match(/^data:\s*(.+)$/m)?.[1];
    if (raw) onEvent(event, JSON.parse(raw) as Record<string, unknown>);
  };

  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    frames.filter((frame) => frame.trim()).forEach(consume);
    if (chunk.done) break;
  }

  if (buffer.trim()) consume(buffer);
}

export async function fetchUsage(range: 'today' | '7d' | '30d'): Promise<UsagePayload> {
  return request<UsagePayload>('/api/user/usage?range=' + range);
}

export interface FavoriteItem {
  id: string;
  targetType: 'agent' | 'resource';
  targetId: string;
  name: string;
  status?: string | null;
  createdAt?: string;
}

export interface BackendNotification {
  id: string;
  type: 'system' | 'billing' | 'agent' | 'resource';
  title: string;
  body: string;
  isRead: boolean;
  readAt?: string | null;
  createdAt?: string;
}

export interface UserSettings {
  displayName: string | null;
  prefs: Record<string, unknown>;
  updatedAt?: string;
}

export interface AccountInfo {
  balanceCents: number;
  currency: string;
  updatedAt?: string;
}

export interface BillingTransaction {
  id: string;
  type: 'recharge' | 'consume';
  amountCents: number;
  balanceAfterCents: number;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string | null;
  createdAt?: string;
}

export interface FilingRecord {
  id: string;
  domain: string;
  subjectName: string;
  subjectType: 'enterprise' | 'individual';
  icpNumber?: string | null;
  status: 'submitted' | 'approved' | 'rejected' | 'draft';
  remark?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export async function fetchFavorites(): Promise<FavoriteItem[]> {
  return (await request<{ favorites: FavoriteItem[] }>('/api/user/favorites')).favorites;
}

export async function addFavorite(targetType: 'agent' | 'resource', targetId: string): Promise<FavoriteItem> {
  return (
    await request<{ favorite: FavoriteItem }>('/api/user/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetType, targetId }),
    })
  ).favorite;
}

export async function removeFavorite(id: string): Promise<void> {
  await request<void>('/api/user/favorites/' + encodeURIComponent(id), { method: 'DELETE' });
}

export async function fetchNotifications(): Promise<{ notifications: BackendNotification[]; unreadCount: number }> {
  return request<{ notifications: BackendNotification[]; unreadCount: number }>('/api/user/notifications');
}

export async function readAllNotifications(): Promise<number> {
  return (
    await request<{ ok: boolean; updated: number }>('/api/user/notifications/read-all', { method: 'POST' })
  ).updated;
}

export async function markNotificationRead(id: string): Promise<void> {
  await request<{ ok: boolean }>('/api/user/notifications/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ read: true }),
  });
}

export async function fetchSettings(): Promise<UserSettings> {
  return (await request<{ settings: UserSettings }>('/api/user/settings')).settings;
}

export async function updateSettings(patch: { displayName?: string | null; prefs?: Record<string, unknown> }): Promise<UserSettings> {
  return (
    await request<{ settings: UserSettings }>('/api/user/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
  ).settings;
}

export async function fetchAccount(): Promise<AccountInfo> {
  return (await request<{ account: AccountInfo }>('/api/user/account')).account;
}

export async function rechargeAccount(amountCents: number, remark?: string): Promise<{ transaction: BillingTransaction; account: AccountInfo }> {
  return request<{ transaction: BillingTransaction; account: AccountInfo }>('/api/user/billing/recharge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amountCents, remark }),
  });
}

export async function fetchTransactions(): Promise<BillingTransaction[]> {
  return (await request<{ transactions: BillingTransaction[] }>('/api/user/billing/transactions')).transactions;
}

export async function fetchFilings(): Promise<FilingRecord[]> {
  return (await request<{ filings: FilingRecord[] }>('/api/user/filings')).filings;
}

export async function createFiling(input: { domain: string; subjectName: string; subjectType?: 'enterprise' | 'individual'; icpNumber?: string }): Promise<FilingRecord> {
  return (
    await request<{ filing: FilingRecord }>('/api/user/filings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  ).filing;
}
