import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';

export function createClientIPResolver(env = process.env) {
  const configured = env.BAIRUI_TRUSTED_PROXIES?.trim() ?? '';
  let trust;
  try {
    const entries = configured ? configured.split(',').map(value => value.trim()) : [];
    for (const entry of entries) {
      const [ip, prefix, extra] = entry.split('/');
      if (!isIP(ip) || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) === 0))) throw new Error('invalid_proxy');
    }
    trust = proxyaddr.compile(entries);
  } catch {
    throw new Error('BAIRUI_TRUSTED_PROXIES requires explicit IP addresses or nonzero CIDRs');
  }
  return request => {
    const peer = request.socket?.remoteAddress;
    if (!peer || !isIP(peer)) throw new Error('invalid_client_ip');
    // Ignore all forwarding headers unless the actual TCP peer is trusted.
    if (!trust(peer, 0)) return peer;
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded === undefined) return peer;
    if (typeof forwarded !== 'string' || forwarded.length > 2048) throw new Error('invalid_client_ip');
    const chain = forwarded.split(',').map(value => value.trim());
    if (chain.length > 16 || chain.some(ip => !isIP(ip))) throw new Error('invalid_client_ip');
    return proxyaddr(request, trust);
  };
}
