import assert from 'node:assert/strict';
import test from 'node:test';
import { Duplex, PassThrough } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';

async function channelClass() {
  try { return (await import('../src/runtime/pi/sandbox/rpc-channel.mjs')).SandboxRpcChannel; }
  catch (error) { assert.fail(`Sandbox RPC transport feature missing: ${error.code}`); }
}
async function fixture(t, limits = {}, { slow = false } = {}) {
  const Channel = await channelClass();
  const incoming = new PassThrough();
  const outgoing = new PassThrough({ highWaterMark: slow ? 16 : 65536 });
  // Duplex.from uses platform-dependent wrapper water marks (16/64 KiB), so
  // bound the real outer writable explicitly as well as its underlying pipe.
  const stream = new Duplex({
    readableHighWaterMark: 65536,
    writableHighWaterMark: slow ? 16 : 65536,
    read() { incoming.resume(); },
    write(chunk, encoding, callback) { outgoing.write(chunk, encoding, callback); },
    final(callback) { outgoing.end(callback); },
    destroy(failure, callback) { incoming.destroy(); outgoing.destroy(); callback(failure); },
  });
  incoming.on('data', chunk => { if (!stream.push(chunk)) incoming.pause(); });
  incoming.on('end', () => stream.push(null));
  incoming.on('error', failure => stream.destroy(failure));
  outgoing.on('error', failure => stream.destroy(failure));
  const channel = new Channel(stream, limits);
  const frames = [], readers = [];
  let buffer = '';
  if (!slow) outgoing.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (readers.length) readers.shift()(frame); else frames.push(frame);
    }
  });
  t.after(() => { channel.close(); incoming.destroy(); outgoing.destroy(); });
  return {
    channel, stream, incoming, outgoing, frames,
    next: () => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => readers.push(resolve)),
    send: value => incoming.write(Buffer.from(JSON.stringify(value) + '\n')),
    respond(frame, data, success = true) {
      this.send({ type: 'response', id: frame.id, command: frame.type, success, ...(success ? data === undefined ? {} : { data } : { error: data }) });
    },
  };
}
const rejected = (promise, code) => assert.rejects(promise, error => error.message === code);
async function accepted(f, type, args, data) {
  const pending = f.channel.request(type, ...(args === undefined ? [] : [args]));
  const frame = await f.next(); f.respond(frame, data); return { frame, data: await pending };
}

test('fixed requests use generated UUIDs and actual pi 1.1.0 prompt wire shape', async t => {
  const f = await fixture(t);
  const ids = new Set();
  for (const [type, args, data] of [
    ['get_state', undefined, { model: { id: 'untrusted' } }],
    ['set_auto_retry', { enabled: false }], ['set_auto_compaction', { enabled: false }],
    ['prompt', { message: '  多字节\nmessage  ' }, { disposition: 'started' }], ['abort'],
  ]) {
    const result = await accepted(f, type, args, data);
    assert.match(result.frame.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(ids.has(result.frame.id), false); ids.add(result.frame.id);
    assert.deepEqual(result.frame, { id: result.frame.id, type, ...args });
    assert.deepEqual(result.data, data);
  }
});

test('rejects arbitrary methods, keys, id/type overrides and enabled retry before any write', async t => {
  const f = await fixture(t);
  for (const [type, args] of [
    ['bash', { command: 'canary' }], ['get_messages', {}], ['GET_STATE', {}],
    ['get_state', { id: 'override' }], ['abort', { type: 'prompt' }],
    ['prompt', { message: 'x', id: 'override' }], ['prompt', { message: 'x', images: [] }],
    ['set_auto_retry', { enabled: true }], ['set_auto_retry', {}], ['set_auto_compaction', { enabled: true }],
    ['prompt', { message: '' }], ['prompt', { message: '中'.repeat(10923) }],
    ['prompt', { message: '\ud800' }], ['prompt', { message: 1 }],
  ]) await rejected(f.channel.request(type, args), 'rpc_invalid_request');
  await rejected(f.channel.request('get_state', {}, 1), 'rpc_invalid_request');
  assert.equal(f.frames.length, 0); assert.equal(f.channel.dead, false);
});

test('rejects accessors and proxies without executing traps or normalizing fields', async t => {
  const f = await fixture(t); let touched = false;
  const accessor = Object.defineProperty({}, 'message', { enumerable: true, get() { touched = true; return 'x'; } });
  const proxy = new Proxy({}, { getPrototypeOf() { touched = true; throw Error('canary'); }, ownKeys() { touched = true; throw Error('canary'); } });
  for (const args of [accessor, proxy, [], null, Object.assign(Object.create({}), { message: 'x' }), { message: 'x', [Symbol()]: 1 }]) {
    await rejected(f.channel.request('prompt', args), 'rpc_invalid_request');
  }
  assert.equal(touched, false); assert.equal(f.frames.length, 0);
  const result = await accepted(f, 'prompt', { message: '   ' }, { disposition: 'queued' });
  assert.equal(result.frame.message, '   ');
});

test('strict limit configuration only permits lowering positive integer defaults', async t => {
  const Channel = await channelClass();
  for (const limits of [{ unknown: 1 }, { maxRpcPending: 9 }, { rpcTimeoutMs: 10001 }, { maxEvents: 0 }, { maxLineBytes: 1.5 }, { maxRawRpcBytes: NaN }, { maxWriteBufferBytes: Infinity }, { maxEvents: '1' }]) {
    const stream = new PassThrough(); t.after(() => stream.destroy());
    assert.throws(() => new Channel(stream, limits), /rpc_invalid_limits/);
  }
  let touched = false;
  const limits = Object.defineProperty({}, 'maxEvents', { enumerable: true, get() { touched = true; return 1; } });
  const stream = new PassThrough(); t.after(() => stream.destroy());
  assert.throws(() => new Channel(stream, limits), /rpc_invalid_limits/); assert.equal(touched, false);
  assert.throws(() => new Channel({}), /rpc_invalid_stream/);
});

test('correlates concurrent responses by both generated id and command', async t => {
  const f = await fixture(t);
  const a = f.channel.request('get_state'); const b = f.channel.request('set_auto_retry', { enabled: false });
  const fa = await f.next(), fb = await f.next();
  f.respond(fb); f.respond(fa, { value: 2 });
  assert.equal(await b, undefined); assert.deepEqual(await a, { value: 2 });
});

test('decodes strict UTF8 only after complete newline frames across multibyte splits', async t => {
  const f = await fixture(t); const events = []; f.channel.on('event', event => events.push(event));
  const bytes = Buffer.from(JSON.stringify({ type: 'message_update', payload: '中文🙂' }) + '\n');
  for (const byte of bytes) f.incoming.write(Buffer.of(byte));
  await turn(); assert.deepEqual(events, [{ type: 'message_update', payload: '中文🙂' }]); assert.equal(f.channel.dead, false);
});

test('one prompt stays fenced until trusted endTask even after agent_settled', async t => {
  const f = await fixture(t);
  const promise = f.channel.request('prompt', { message: 'first' }); const frame = await f.next();
  assert.equal(f.channel.taskActive, true); assert.throws(() => f.channel.endTask(), /rpc_task_pending/);
  f.send({ type: 'agent_settled', aborted: false });
  await rejected(f.channel.request('prompt', { message: 'second' }), 'rpc_task_active');
  f.respond(frame, { disposition: 'started' }); await promise;
  await rejected(f.channel.request('prompt', { message: 'second' }), 'rpc_task_active');
  f.channel.endTask(); assert.equal(f.channel.taskActive, false);
  await accepted(f, 'prompt', { message: 'second' }, { disposition: 'handled' });
  assert.equal(f.channel.taskActive, true); f.channel.endTask();
  assert.throws(() => f.channel.endTask(), /rpc_no_task/);
});

test('abort permanently requires recycling even after trusted endTask', async t => {
  const f = await fixture(t);
  await accepted(f, 'prompt', { message: 'first' }, { disposition: 'started' });
  await accepted(f, 'abort'); f.send({ type: 'agent_settled', aborted: true }); await turn();
  f.channel.endTask(); assert.equal(f.channel.requiresRecycle, true);
  await rejected(f.channel.request('prompt', { message: 'again' }), 'rpc_recycle_required');
  await accepted(f, 'get_state', undefined, {}); assert.equal(f.channel.dead, false);
});

test('upstream failures reject with fixed safe error while retaining the task fence', async t => {
  const f = await fixture(t); const promise = f.channel.request('prompt', { message: 'x' });
  const rejection = rejected(promise, 'rpc_rejected'); f.respond(await f.next(), 'PRIVATE-CANARY', false); await rejection;
  assert.equal(f.channel.dead, false); assert.equal(f.channel.taskActive, true); f.channel.endTask();
});

for (const [name, payload] of [
  ['malformed JSON', Buffer.from('{PRIVATE-CANARY\n')],
  ['malformed UTF8', Buffer.from([123, 34, 120, 34, 58, 34, 0xc0, 0xaf, 34, 125, 10])],
  ['array frame', Buffer.from('[]\n')], ['null frame', Buffer.from('null\n')],
  ['incoming method', { type: 'get_state', id: 'x' }], ['unknown event', { type: 'unknown' }],
  ['command-shaped event', { type: 'message_start', command: 'bash' }],
  ['method-shaped event', { type: 'message_start', method: 'bash' }],
  ['response-shaped ordinary event', { type: 'message_start', success: true }],
  ['invalid retry success field', { type: 'auto_retry_end', success: 'true', attempt: 1 }],
  ['response id in retry event', { type: 'auto_retry_end', success: true, attempt: 1, id: 'injected' }],
  ['wrong response id', { type: 'response', id: 'unknown', command: 'get_state', success: true }],
]) test(`fails channel and rejects all pending on ${name}`, async t => {
  const f = await fixture(t);
  const a = rejected(f.channel.request('get_state'), 'rpc_protocol');
  const b = rejected(f.channel.request('set_auto_retry', { enabled: false }), 'rpc_protocol');
  if (Buffer.isBuffer(payload)) f.incoming.write(payload); else f.send(payload);
  await Promise.all([a, b]); assert.equal(f.channel.dead, true);
  await rejected(f.channel.request('get_state'), 'rpc_dead');
});

for (const mutation of ['wrong-command', 'nonboolean', 'extra-key', 'missing-id', 'success-error', 'failed-data', 'bad-disposition']) {
  test(`rejects malformed response: ${mutation}`, async t => {
    const f = await fixture(t);
    const promise = rejected(f.channel.request('prompt', { message: 'x' }), 'rpc_protocol');
    const frame = await f.next();
    const response = { type: 'response', id: frame.id, command: frame.type, success: true, data: { disposition: 'started' } };
    if (mutation === 'wrong-command') response.command = 'get_state';
    if (mutation === 'nonboolean') response.success = 'true';
    if (mutation === 'extra-key') response.extra = 'PRIVATE-CANARY';
    if (mutation === 'missing-id') delete response.id;
    if (mutation === 'success-error') response.error = 'PRIVATE-CANARY';
    if (mutation === 'failed-data') { response.success = false; response.error = 'PRIVATE-CANARY'; }
    if (mutation === 'bad-disposition') response.data.disposition = 'invented';
    f.send(response); await promise; assert.equal(f.channel.dead, true);
  });
}

test('duplicate responses kill channel and reject other pending requests', async t => {
  const f = await fixture(t); const first = f.channel.request('get_state'); const frame = await f.next();
  f.respond(frame, {}); await first;
  const second = rejected(f.channel.request('get_state'), 'rpc_protocol'); f.respond(frame, {}); await second;
  assert.equal(f.channel.dead, true);
});

test('line limit includes buffered fragments and is checked before parsing', async t => {
  const f = await fixture(t, { maxLineBytes: 32 });
  const promise = rejected(f.channel.request('get_state'), 'rpc_overflow');
  f.incoming.write(Buffer.alloc(20, 120)); f.incoming.write(Buffer.alloc(13, 120)); await promise;
  assert.equal(f.channel.dead, true);
});

test('rejects huge incoming chunks before concatenation', async t => {
  const f = await fixture(t, { maxRawRpcBytes: 128 });
  const promise = rejected(f.channel.request('get_state'), 'rpc_overflow');
  f.incoming.write(Buffer.alloc(129)); await promise;
});

test('raw byte budget counts incomplete input and remains cumulative while idle', async t => {
  const f = await fixture(t, { maxRawRpcBytes: 64 });
  const event = Buffer.from('{"type":"agent_start"}\n');
  f.incoming.write(event); await turn(); f.incoming.write(event); await turn();
  assert.equal(f.channel.dead, false); f.incoming.write(event); await turn(); assert.equal(f.channel.dead, true);
});

test('active task raw budget includes both responses and events over many frames', async t => {
  const f = await fixture(t, { maxRawRpcBytes: 240 });
  await accepted(f, 'prompt', { message: 'x' }, { disposition: 'started' });
  for (let i = 0; i < 6; i++) f.send({ type: 'agent_start' });
  await turn(); assert.equal(f.channel.dead, true);
});

test('idle event budget cannot be reset by ordinary requests', async t => {
  const f = await fixture(t, { maxEvents: 1 });
  f.send({ type: 'agent_start' }); await turn();
  await accepted(f, 'get_state', undefined, {});
  f.send({ type: 'agent_start' }); await turn(); assert.equal(f.channel.dead, true);
});

test('per-task event counters are not reset by sandbox events', async t => {
  const f = await fixture(t, { maxEvents: 2 });
  await accepted(f, 'prompt', { message: 'x' }, { disposition: 'started' });
  f.send({ type: 'agent_settled', aborted: false }); f.send({ type: 'agent_start' }); f.send({ type: 'agent_end' });
  await turn(); assert.equal(f.channel.dead, true);
});

test('trusted endTask and new prompt start bounded fresh event and raw counters', async t => {
  const f = await fixture(t, { maxEvents: 1, maxRawRpcBytes: 240 });
  for (let i = 0; i < 3; i++) {
    await accepted(f, 'prompt', { message: 'x' }, { disposition: 'started' });
    f.send({ type: 'agent_settled', aborted: false }); await turn(); f.channel.endTask();
  }
  assert.equal(f.channel.dead, false);
});

test('pending request limit rejects without killing existing requests or writing extra bytes', async t => {
  const f = await fixture(t, { maxRpcPending: 2 });
  const a = f.channel.request('get_state'), b = f.channel.request('get_state');
  await rejected(f.channel.request('get_state'), 'rpc_busy');
  const fa = await f.next(), fb = await f.next(); f.respond(fa, 1); f.respond(fb, 2);
  assert.deepEqual(await Promise.all([a, b]), [1, 2]); assert.equal(f.frames.length, 0);
});

test('default pending bound is exactly eight requests', async t => {
  const f = await fixture(t); const pending = [];
  for (let i = 0; i < 8; i++) pending.push(f.channel.request('get_state'));
  await rejected(f.channel.request('get_state'), 'rpc_busy');
  for (let i = 0; i < 8; i++) f.respond(await f.next());
  await Promise.all(pending);
});

test('known pi events remain untrusted data and do not independently change control state', async t => {
  const f = await fixture(t); const received = []; f.channel.on('event', value => received.push(value.type));
  const names = ['agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end',
    'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
    'queue_update', 'compaction_start', 'compaction_end', 'entry_appended', 'session_info_changed', 'thinking_level_changed',
    'auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_attempt_start',
    'summarization_retry_finished', 'extension_error'];
  for (const type of names) f.send(type === 'auto_retry_end' ? { type, success: true, attempt: 1 } : { type, payload: 'PRIVATE-CANARY' });
  await turn(); assert.deepEqual(received, names);
  assert.equal(f.channel.dead, false); assert.equal(f.channel.requiresRecycle, false); assert.equal(f.channel.taskActive, false);
});

test('actual pi 1.1.0 auto_retry_end success fields remain untrusted legal events', async t => {
  const f = await fixture(t); const received = []; f.channel.on('event', value => received.push(value));
  const events = [
    { type: 'auto_retry_end', success: true, attempt: 1 },
    { type: 'auto_retry_end', success: false, attempt: 2, finalError: 'PRIVATE-CANARY' },
  ];
  for (const event of events) f.send(event);
  await turn(); assert.equal(f.channel.dead, false); assert.deepEqual(received, events);
  await accepted(f, 'get_state', undefined, {});
});

test('timeout is permanent, rejects every pending request and prevents late revival', async t => {
  const f = await fixture(t, { rpcTimeoutMs: 20 });
  const a = rejected(f.channel.request('get_state'), 'rpc_timeout'), b = rejected(f.channel.request('get_state'), 'rpc_timeout');
  const frame = await f.next(); await Promise.all([a, b]);
  f.respond(frame, {}); assert.equal(f.channel.dead, true); await rejected(f.channel.request('get_state'), 'rpc_dead');
});

for (const mode of ['end', 'error', 'close']) test(`${mode} makes channel permanently dead with safe error`, async t => {
  const f = await fixture(t); const pending = rejected(f.channel.request('get_state'), 'rpc_dead');
  if (mode === 'end') f.incoming.end();
  if (mode === 'error') f.stream.destroy(Error('PRIVATE-CANARY'));
  if (mode === 'close') f.stream.destroy();
  await pending; assert.equal(f.channel.dead, true);
});

test('oversized outbound frame is rejected before writing or claiming task fence', async t => {
  const f = await fixture(t, { maxWriteBufferBytes: 128 });
  await rejected(f.channel.request('prompt', { message: 'x'.repeat(100) }), 'rpc_write_limit');
  assert.equal(f.frames.length, 0); assert.equal(f.channel.taskActive, false);
});

test('slow peer cannot accumulate unbounded writes and write deadline covers backpressure', async t => {
  const f = await fixture(t, { rpcTimeoutMs: 25, maxWriteBufferBytes: 65536 }, { slow: true });
  const a = rejected(f.channel.request('prompt', { message: 'x'.repeat(32768) }), 'rpc_timeout');
  await rejected(f.channel.request('get_state'), 'rpc_backpressure');
  assert.ok(f.stream.writableLength <= 65536); await a; assert.equal(f.channel.dead, true);
});

test('slow peer fixture explicitly bounds its outer duplex write high water mark', async t => {
  const f = await fixture(t, {}, { slow: true });
  assert.equal(f.stream.writableHighWaterMark, 16);
});

test('early response cannot cancel the deadline while outbound write is still blocked', async t => {
  const f = await fixture(t, { rpcTimeoutMs: 35 }, { slow: true });
  const pending = f.channel.request('prompt', { message: 'x'.repeat(32768) });
  const rejection = rejected(pending, 'rpc_timeout');
  await turn();
  const prefix = f.outgoing.read(128).toString('utf8');
  const id = /"id":"([0-9a-f-]+)"/.exec(prefix)[1];
  f.send({ type: 'response', id, command: 'prompt', success: true, data: { disposition: 'started' } });
  await rejection; assert.equal(f.channel.dead, true);
});

test('close is idempotent, destroys the transport and clears pending timers/listeners', async t => {
  const f = await fixture(t); let deaths = 0; f.channel.on('dead', () => deaths++);
  const a = rejected(f.channel.request('get_state'), 'rpc_closed');
  f.channel.close(); f.channel.close(); await a; await turn();
  assert.equal(f.stream.destroyed, true); assert.equal(deaths, 1);
  for (const event of ['data', 'drain', 'end', 'error', 'close']) assert.equal(f.stream.listenerCount(event), 0);
  await rejected(f.channel.request('get_state'), 'rpc_dead');
});
