import assert from 'node:assert/strict';

export function authRetryDelay(path, status, retryAfter, attempt) {
  if (status !== 429 || attempt >= 3 || !['/api/auth/sign-up/email', '/api/auth/sign-in/email'].includes(path)) return null;
  const seconds = retryAfter === null ? 10 : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 60 ? seconds * 1000 + 250 : null;
}

export function serviceArgs({ name, image, network, secret, config, role }) {
  assert.ok(['api', 'worker'].includes(role));
  return ['service', 'create', '--detach=true', '--no-resolve-image', '--name', name,
    '--network', network, '--replicas', '2', '--user', '1000:1000',
    '--limit-cpu', '0.5', '--limit-memory', role === 'api' ? '384M' : '256M',
    '--reserve-cpu', '0.1', '--reserve-memory', '64M',
    '--restart-condition', 'any', '--restart-delay', '1s', '--stop-grace-period', '10s',
    '--secret', 'source=' + secret + ',target=check-env,uid=1000,gid=1000,mode=0400',
    '--config', 'source=' + config + ',target=/app/scheduler-check-entrypoint.mjs',
    '--env', 'CHECK_ROLE=' + role, '--env', 'NODE_ENV=test',
    image, 'node', '/app/scheduler-check-entrypoint.mjs'];
}

export function gatewayConfig(api) {
  assert.match(api, /^[a-z0-9-]+$/);
  return `{
  admin off
  auto_https off
}
:80 {
  @allowed path /healthz /api/auth/* /api/simulation/tasks*
  handle @allowed {
    reverse_proxy {
      dynamic a {
        name tasks.` + api + `
        port 8080
        refresh 1s
      }
      lb_policy round_robin
      transport http {
        keepalive off
      }
    }
  }
  handle {
    respond 404
  }
}
`;
}

export function summarizeSamples(samples) {
  const result = { samples: samples.length, peakRunning: 0, peakUser: 0, peakWorker: 0 };
  for (const rows of samples) {
    const running = rows.filter(t => t.status === 'running');
    const users = {}, workers = {};
    for (const task of running) {
      users[task.user_id] = (users[task.user_id] ?? 0) + 1;
      workers[task.workerId] = (workers[task.workerId] ?? 0) + 1;
    }
    const user = Math.max(0, ...Object.values(users)), worker = Math.max(0, ...Object.values(workers));
    assert.ok(running.length <= 10, 'global_concurrency_exceeded');
    assert.ok(user <= 5, 'user_concurrency_exceeded');
    assert.ok(worker <= 5, 'worker_concurrency_exceeded');
    result.peakRunning = Math.max(result.peakRunning, running.length);
    result.peakUser = Math.max(result.peakUser, user);
    result.peakWorker = Math.max(result.peakWorker, worker);
  }
  return result;
}
