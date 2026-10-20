import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { types } from 'node:util';

const DEFAULTS = Object.freeze({
  rpcTimeoutMs: 10000, maxRpcPending: 8, maxLineBytes: 256 * 1024,
  maxRawRpcBytes: 4 * 1024 * 1024, maxEvents: 10000, maxWriteBufferBytes: 256 * 1024,
});
const METHODS = new Set(['get_state', 'set_auto_retry', 'set_auto_compaction', 'prompt', 'abort']);
// Fixed pi 1.1.0 AgentSessionEvent names plus its RPC extension error notification.
const EVENTS = new Set([
  'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end',
  'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'queue_update', 'compaction_start', 'compaction_end', 'entry_appended',
  'session_info_changed', 'thinking_level_changed', 'auto_retry_start', 'auto_retry_end',
  'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished',
  'extension_error',
]);
const error = code => new Error(code);

function record(value, code) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw error(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw error(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) throw error(code);
  }
  return descriptors;
}
function exact(value, keys, code) {
  const descriptors = record(value, code);
  const own = Object.keys(descriptors);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) throw error(code);
  return Object.fromEntries(own.map(key => [key, descriptors[key].value]));
}
function limitsFrom(value) {
  const descriptors = record(value, 'rpc_invalid_limits');
  const limits = { ...DEFAULTS };
  for (const [key, descriptor] of Object.entries(descriptors)) {
    const candidate = descriptor.value;
    if (!Object.hasOwn(DEFAULTS, key) || !Number.isSafeInteger(candidate) || candidate < 1 || candidate > DEFAULTS[key]) throw error('rpc_invalid_limits');
    limits[key] = candidate;
  }
  return Object.freeze(limits);
}
function fieldsFor(type, value) {
  if (typeof type !== 'string' || !METHODS.has(type)) throw error('rpc_invalid_request');
  const fields = exact(value, type === 'prompt' ? ['message'] : type.startsWith('set_auto_') ? ['enabled'] : [], 'rpc_invalid_request');
  if (type.startsWith('set_auto_') && fields.enabled !== false) throw error('rpc_invalid_request');
  if (type === 'prompt' && (typeof fields.message !== 'string' || !fields.message.length ||
      !fields.message.isWellFormed() || Buffer.byteLength(fields.message, 'utf8') > 32768)) throw error('rpc_invalid_request');
  return fields;
}

/**
 * Bounded transport over an already connected stream. It never launches a workload.
 * `event` payloads and resolved data are untrusted sandbox output, not execution,
 * billing, completion, or resource reclamation evidence. The trusted controller
 * separately checks readiness/model/session and native background tool cleanup.
 */
export class SandboxRpcChannel extends EventEmitter {
  #stream; #limits; #pending = new Map(); #buffer = Buffer.alloc(0); #bufferUsed = 0;
  #dead = false; #taskActive = false; #promptPending = false; #requiresRecycle = false;
  #rawBytes = 0; #events = 0; #writeBytes = 0; #blocked = false;
  #onData; #onEnd; #onError; #onClose; #onDrain;

  constructor(stream, limits = {}) {
    super();
    this.#limits = limitsFrom(limits);
    if (types.isProxy(stream) || !(stream instanceof Duplex) || stream.destroyed || !stream.readable || !stream.writable || stream.readableEncoding) throw error('rpc_invalid_stream');
    this.#stream = stream;
    this.#onData = chunk => this.#consume(chunk);
    this.#onEnd = () => this.#fail('rpc_dead');
    this.#onError = () => this.#fail('rpc_dead');
    this.#onClose = () => { this.#fail('rpc_dead'); this.#removeFinalListeners(); };
    this.#onDrain = () => { this.#blocked = false; };
    stream.on('data', this.#onData); stream.on('end', this.#onEnd);
    stream.on('error', this.#onError); stream.on('close', this.#onClose); stream.on('drain', this.#onDrain);
  }

  get dead() { return this.#dead; }
  get taskActive() { return this.#taskActive; }
  get requiresRecycle() { return this.#requiresRecycle; }

  async request(type, fields = {}) {
    if (arguments.length > 2) throw error('rpc_invalid_request');
    const data = fieldsFor(type, fields);
    if (this.#dead) throw error('rpc_dead');
    if (type === 'prompt' && this.#requiresRecycle) throw error('rpc_recycle_required');
    if (type === 'prompt' && this.#taskActive) throw error('rpc_task_active');
    if (this.#pending.size >= this.#limits.maxRpcPending) throw error('rpc_busy');
    if (this.#blocked) throw error('rpc_backpressure');
    const id = randomUUID();
    const line = Buffer.from(JSON.stringify(Object.assign(Object.create(null), { id, type }, data)) + '\n');
    if (Math.max(this.#writeBytes, this.#stream.writableLength) + line.length > this.#limits.maxWriteBufferBytes) throw error('rpc_write_limit');
    if (type === 'prompt') {
      this.#taskActive = true; this.#promptPending = true; this.#resetBudget();
    }
    // An abort acknowledgement/agent_settled is never native process reclamation.
    if (type === 'abort') this.#requiresRecycle = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('rpc_timeout'), this.#limits.rpcTimeoutMs);
      this.#pending.set(id, { type, resolve, reject, timer, written: false, response: null });
      this.#writeBytes += line.length;
      try {
        const ready = this.#stream.write(line, writeError => {
          this.#writeBytes -= line.length;
          if (writeError) { this.#fail('rpc_dead'); return; }
          const pending = this.#pending.get(id);
          if (pending) { pending.written = true; this.#complete(id, pending); }
        });
        if (!ready) this.#blocked = true;
      } catch { this.#fail('rpc_dead'); }
    });
  }

  /** Trusted controller only: call after native completion/background tool checks. */
  endTask() {
    if (this.#dead) throw error('rpc_dead');
    if (!this.#taskActive) throw error('rpc_no_task');
    if (this.#promptPending) throw error('rpc_task_pending');
    this.#taskActive = false; this.#resetBudget();
  }

  /** Destroys this stream only; does not prove native sandbox/container cleanup. */
  close() { this.#fail('rpc_closed'); }

  #resetBudget() { this.#rawBytes = 0; this.#events = 0; }

  #consume(chunk) {
    if (this.#dead) return;
    if (!Buffer.isBuffer(chunk)) return this.#fail('rpc_protocol');
    // Never concatenate an arbitrary peer-controlled chunk into the line buffer.
    if (chunk.length > this.#limits.maxRawRpcBytes) return this.#fail('rpc_overflow');
    let offset = 0;
    while (offset < chunk.length && !this.#dead) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const consumed = end - offset + (newline < 0 ? 0 : 1);
      this.#rawBytes += consumed;
      if (this.#rawBytes > this.#limits.maxRawRpcBytes || this.#bufferUsed + end - offset > this.#limits.maxLineBytes) return this.#fail('rpc_overflow');
      const part = chunk.subarray(offset, end);
      let line = part;
      if (newline < 0 || this.#bufferUsed) {
        const needed = this.#bufferUsed + part.length;
        if (needed > this.#buffer.length) {
          // Geometric growth keeps one-byte peer fragmentation linear in work;
          // capacity never exceeds the fixed line budget.
          const capacity = Math.min(this.#limits.maxLineBytes, Math.max(4096, this.#buffer.length * 2, needed));
          const grown = Buffer.alloc(capacity); this.#buffer.copy(grown, 0, 0, this.#bufferUsed); this.#buffer = grown;
        }
        part.copy(this.#buffer, this.#bufferUsed); this.#bufferUsed = needed;
        line = this.#buffer.subarray(0, needed);
      }
      if (newline < 0) return;
      this.#bufferUsed = 0; offset = newline + 1;
      let frame;
      try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)); }
      catch { return this.#fail('rpc_protocol'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') return this.#fail('rpc_protocol');
      if (frame.type === 'response') this.#response(frame);
      else {
        if (!EVENTS.has(frame.type) || ['id', 'command', 'method'].some(key => Object.hasOwn(frame, key))) return this.#fail('rpc_protocol');
        // pi 1.1.0 auto_retry_end legitimately has a boolean success field.
        // It is not a response, and other event types cannot borrow this field.
        if (frame.type === 'auto_retry_end' ? typeof frame.success !== 'boolean' : Object.hasOwn(frame, 'success')) return this.#fail('rpc_protocol');
        if (++this.#events > this.#limits.maxEvents) return this.#fail('rpc_overflow');
        this.emit('event', frame);
      }
    }
  }

  #response(frame) {
    const pending = this.#pending.get(frame.id);
    if (!pending || pending.response || pending.type !== frame.command || typeof frame.success !== 'boolean') return this.#fail('rpc_protocol');
    const allowed = frame.success ? ['id', 'type', 'command', 'success', 'data'] : ['id', 'type', 'command', 'success', 'error'];
    if (Object.keys(frame).some(key => !allowed.includes(key)) || (!frame.success && typeof frame.error !== 'string')) return this.#fail('rpc_protocol');
    if (frame.success && pending.type === 'prompt') {
      let data;
      try { data = exact(frame.data, ['disposition'], 'rpc_protocol'); }
      catch { return this.#fail('rpc_protocol'); }
      if (!['started', 'queued', 'handled'].includes(data.disposition)) return this.#fail('rpc_protocol');
    }
    if (frame.success && ['abort', 'set_auto_retry', 'set_auto_compaction'].includes(pending.type) && Object.hasOwn(frame, 'data')) return this.#fail('rpc_protocol');
    // Do not let an early peer acknowledgement cancel a still blocked write's
    // deadline. In particular it cannot release a partially sent prompt fence.
    pending.response = { success: frame.success, data: frame.data };
    this.#complete(frame.id, pending);
  }

  #complete(id, pending) {
    if (!pending.written || !pending.response) return;
    this.#pending.delete(id); clearTimeout(pending.timer);
    if (pending.type === 'prompt') this.#promptPending = false;
    if (pending.response.success) pending.resolve(pending.response.data); else pending.reject(error('rpc_rejected'));
  }

  #removeFinalListeners() {
    this.#stream.off('error', this.#onError); this.#stream.off('close', this.#onClose);
  }

  #fail(code) {
    if (this.#dead) return;
    this.#dead = true; this.#buffer = Buffer.alloc(0); this.#bufferUsed = 0;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error(code)); }
    this.#pending.clear();
    this.#stream.off('data', this.#onData); this.#stream.off('end', this.#onEnd); this.#stream.off('drain', this.#onDrain);
    // Keep only the error sink until close so asynchronous stream write errors
    // cannot become unhandled. The close handler removes these last listeners.
    if (this.#stream.closed) this.#removeFinalListeners();
    this.#stream.destroy(); this.emit('dead', code);
  }
}
