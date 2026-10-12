import * as os from 'node:os';

export function createHostSampler(source = os) {
  const times = () => {
    try {
      const cores = source.cpus(); if (!cores.length) return null;
      let total = 0, idle = 0;
      for (const core of cores) { total += Object.values(core.times).reduce((sum, value) => sum + value, 0); idle += core.times.idle; }
      return Number.isFinite(total) && Number.isFinite(idle) ? { total, idle } : null;
    } catch { return null; }
  };
  let previous = times();
  return {
    cpu() {
      const current = times(), before = previous; previous = current;
      if (!before || !current || current.total <= before.total || current.idle < before.idle) return NaN;
      const ratio = 1 - (current.idle - before.idle) / (current.total - before.total);
      return ratio >= 0 && ratio <= 1 ? ratio : NaN;
    },
    memory() {
      try {
        const total = source.totalmem(), free = source.freemem();
        if (Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0 && free <= total) return { total, used: total - free };
      } catch { /* Unavailable measurements stay NaN, never a fabricated zero. */ }
      return { total: NaN, used: NaN };
    },
  };
}
