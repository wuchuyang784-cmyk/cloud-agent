// No app/Worker import: only explicit publisher-entry starts this independent loop.
export function startPublisherLoop({ cycle, telemetry, intervalMs = 5000, maxBackoffMs = 60000, onError = () => {} }) {
  if (typeof cycle !== 'function' || typeof telemetry?.update !== 'function' || !Number.isSafeInteger(intervalMs)
    || intervalMs < 1 || intervalMs > 60000 || !Number.isSafeInteger(maxBackoffMs) || maxBackoffMs < intervalMs || maxBackoffMs > 60000) {
    throw new TypeError('announcement_publisher_loop_invalid');
  }
  let closed = false, timer, pending, closing, failures = 0;
  const run = () => {
    if (closed) return;
    pending = (async () => {
      try { telemetry.update({ ok: true, snapshot: await cycle() }); failures = 0; }
      catch { failures = Math.min(failures + 1, 16); telemetry.update({ ok: false }); onError('announcement_publisher_cycle_failed'); }
      finally { if (!closed) timer = setTimeout(run, Math.min(maxBackoffMs, intervalMs * 2 ** failures)); }
    })();
  };
  timer = setTimeout(run, 0);
  return { close() { closed = true; clearTimeout(timer); closing ??= Promise.resolve(pending); return closing; } };
}
