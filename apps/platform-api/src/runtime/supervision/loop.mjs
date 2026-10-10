export function startControllerLoop({ cycle, telemetry, intervalMs = 1000, onError = () => {} }) {
  if (typeof cycle !== 'function' || !telemetry?.update || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000) {
    throw new TypeError('runtime_controller_loop_invalid');
  }
  let closed = false, timer, pending, closing;
  const run = () => {
    if (closed) return;
    pending = (async () => {
      try { telemetry.update({ ok: true, snapshot: await cycle(() => !closed) }); }
      catch { telemetry.update({ ok: false }); onError('runtime_controller_cycle_failed'); }
      finally { if (!closed) timer = setTimeout(run, intervalMs); }
    })();
  };
  // Start asynchronously so the caller can shut down before the first claim.
  timer = setTimeout(run, 0);
  return { close() {
    closed = true; clearTimeout(timer);
    closing ??= Promise.resolve(pending);
    return closing;
  } };
}
