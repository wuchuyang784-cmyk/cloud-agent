export function createReadiness(store, timeoutMs = 2000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_readiness_timeout');
  let pending;
  return async () => {
    // Keep one check in flight even after its callers time out.
    if (!pending) pending = Promise.resolve().then(() => store.ping?.())
      .then(() => true, () => false).finally(() => { pending = null; });
    let timer;
    try {
      return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  };
}

export function createShutdown(server, { graceMs = 10000 } = {}) {
  let pending;
  return () => {
    if (pending) return pending;
    server.platform.beginShutdown();
    pending = (async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), graceMs);
        server.close(error => {
          clearTimeout(timer);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      await server.platform.store.close?.();
    })();
    return pending;
  };
}
