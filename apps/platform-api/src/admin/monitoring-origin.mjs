export function monitoringPublicOrigin(value, defaultValue = 'http://localhost:5173') {
  const origin = value === undefined ? defaultValue : value;
  try {
    if (typeof origin !== 'string' || !origin || /[\s\x00-\x1f\x7f\\]/u.test(origin)) throw new Error();
    const url = new URL(origin);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (loopback ? !['http:', 'https:'].includes(url.protocol) : url.protocol !== 'https:' || Boolean(url.port))) throw new Error();
    return origin;
  } catch { throw new Error('invalid_monitoring_public_origin'); }
}
