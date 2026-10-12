import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class PiRpc extends EventEmitter {
  constructor(config, prepared, paths, executable) {
    super(); this.config = config; this.pending = new Map(); this.dead = false; this.buffer = Buffer.alloc(0);
    const args = ['--mode', 'rpc', '--provider', config.provider, '--model', config.model, '--session', prepared.sessionFile, '--session-dir', prepared.sessionFile.slice(0, prepared.sessionFile.lastIndexOf(paths.state.includes('\\') ? '\\' : '/')), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline'];
    const env = { PATH: process.platform === 'win32' ? process.env.PATH : '/usr/local/bin:/usr/bin:/bin', HOME: paths.state, PI_CODING_AGENT_DIR: prepared.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', LANG: 'C.UTF-8' };
    if (process.platform === 'win32') { env.SystemRoot = process.env.SystemRoot; env.TEMP = paths.state; }
    if (config.gatewayCaFile) env.NODE_EXTRA_CA_CERTS = config.gatewayCaFile;
    const command = executable?.command || '/usr/local/bin/node';
    this.child = spawn(command, [...(executable?.args || ['/opt/pi/packages/coding-agent/dist/bundle/cli.js']), ...args], { cwd: paths.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fail('rpc_dead'));
    this.child.on('exit', () => this.fail('rpc_dead'));
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stdin.on('error', () => this.fail('rpc_dead'));
    this.exited = new Promise(resolve => this.child.once('close', resolve));
  }
  consume(chunk) {
    if (this.dead) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      if (end > this.config.limits.maxLineBytes) return this.fail('rpc_overflow');
      if (this.taskBytes !== undefined) {
        this.taskBytes += end + 1;
        if (this.taskBytes > this.config.limits.maxRawRpcBytes) return this.fail('rpc_task_overflow');
      }
      let value; try { value = JSON.parse(this.buffer.subarray(0, end).toString('utf8')); } catch { return this.fail('rpc_protocol'); }
      this.buffer = this.buffer.subarray(end + 1);
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') return this.fail('rpc_protocol');
      if (value.type === 'response') {
        const pending = this.pending.get(value.id);
        if (!pending || pending.type !== value.command) return this.fail('rpc_protocol');
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.success !== true) pending.reject(new Error('rpc_rejected')); else pending.resolve(value.data);
      } else this.emit('event', value);
      if (this.dead) return;
    }
    if (this.buffer.length > this.config.limits.maxLineBytes) this.fail('rpc_overflow');
  }
  beginTask() { this.taskBytes = 0; }
  endTask() { this.taskBytes = undefined; }
  request(type, data = {}, timeoutMs = this.config.limits.rpcTimeoutMs) {
    if (this.dead || this.pending.size >= this.config.limits.maxRpcPending) return Promise.reject(new Error('rpc_dead'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('rpc_timeout'), timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n', error => { if (error) this.fail('rpc_dead'); });
    });
  }
  fail(code) {
    if (this.dead) return;
    this.dead = true; this.buffer = Buffer.alloc(0);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(code)); }
    this.pending.clear(); this.child.kill('SIGKILL'); this.emit('dead', code);
  }
  async close() { this.fail('rpc_closed'); await this.exited; }
}
