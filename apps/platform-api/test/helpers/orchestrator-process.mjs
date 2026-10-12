import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function launchOrchestrator(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/runtime/orchestrator/index.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('orchestrator_start_timeout')), 30000);
      let output = '';
      const finish = fn => { clearTimeout(timer); child.off('exit', exited); child.off('error', errored); child.stdout.off('data', data); fn(); };
      const exited = () => finish(() => reject(new Error('orchestrator_child_exited')));
      const errored = () => finish(() => reject(new Error('orchestrator_child_error')));
      const data = chunk => { output = (output + chunk).slice(-1024); if (output.includes('orchestrator_isolation_ready')) finish(resolve); };
      child.once('exit', exited); child.once('error', errored); child.stdout.on('data', data);
      child.stderr.resume();
    });
    child.stdout.resume();
    return child;
  } catch (error) { await killOrchestrator(child); throw error; }
}

export async function killOrchestrator(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
}

export async function signedHttps(port, certFile, method, path, headers, body = '') {
  const ca = await readFile(certFile);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, ca, timeout: 25000 }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; if (raw.length > 65536) req.destroy(new Error('body_too_large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('timeout', () => req.destroy(new Error('https_timeout'))); req.on('error', reject); req.end(body);
  });
}
