export async function runWithKeepAlive(action, { setIntervalFn = setInterval, clearIntervalFn = clearInterval, intervalMs = 1000 } = {}) {
  const keepAlive = setIntervalFn(() => {}, intervalMs);
  try {
    return await action();
  } finally {
    clearIntervalFn(keepAlive);
  }
}
