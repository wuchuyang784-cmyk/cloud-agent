import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { ModelAccessError } from './errors.mjs';

// Conservatively exclude special-purpose space, including globally reachable
// exceptions within reserved blocks. No metadata, translation or mapped routes.
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(ip, bits, 'ipv4');
blocked.addAddress('168.63.129.16', 'ipv4'); // Azure host-fabric WireServer, not a model endpoint.
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(ip, bits, 'ipv6');
export function isPublicModelAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); reject(new ModelAccessError('model_upstream_unavailable')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

// Resolver/request injection is programmatic for isolated acceptance, never
// supplied by configuration, a browser, or an upstream response.
export function createProviderTransport({ resolve = (host => lookup(host, { all: true, verbatim: true })), request = httpsRequest } = {}) {
  return async ({ provider, apiKey, payload, signal }) => {
    try {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || isIP(url.hostname) || !url.pathname.endsWith('/v1')) throw new Error();
      const addresses = await abortable(resolve(url.hostname), signal);
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 16 || addresses.some(row => !isPublicModelAddress(row.address) || isIP(row.address) !== row.family)) throw new Error();
      if (signal?.aborted) throw new Error();
      const pinned = addresses[0], body = Buffer.from(JSON.stringify(payload));
      return await new Promise((resolveResponse, reject) => {
        const upstream = request({ protocol: 'https:', hostname: url.hostname, servername: url.hostname, port: 443,
          path: url.pathname + '/chat/completions', method: 'POST', agent: false, proxyEnv: {}, family: pinned.family, autoSelectFamily: false,
          lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
          rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16384, signal,
          headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity', 'content-length': body.length },
        }, response => {
          if (response.statusCode !== 200 || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers['content-type'] ?? '') || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy(); reject(new ModelAccessError('model_upstream_unavailable')); return;
          }
          resolveResponse(response);
        });
        upstream.on('error', () => reject(new ModelAccessError('model_upstream_unavailable')));
        upstream.end(body);
      });
    } catch { throw new ModelAccessError('model_upstream_unavailable'); }
  };
}
