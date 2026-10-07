import test from "node:test";
import assert from "node:assert/strict";
import { MemoryTaskStore } from "../src/scheduler/task-store.mjs";
import { runSimulationWorker } from '../src/scheduler/simulation-worker.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const a = { userId: "a", organizationId: "oa" };
const b = { userId: "b", organizationId: "ob" };
const input = { durationMs: 2000, outcome: "success" };
test("scheduler: isolation, idempotency and queue admission", async () => {
  const s = new MemoryTaskStore();
  const t = await s.submit(a, "one", input);
  assert.equal((await s.submit(a, "one", input)).id, t.id);
  await assert.rejects(s.submit(a, "one", { ...input, durationMs: 3000 }), /idempotency_conflict/);
  assert.equal(await s.get(b, t.id), null);
  assert.equal(await s.cancel(b, t.id), null);
  for (let i=1;i<20;i++) await s.submit(a, "a"+i, input);
  await assert.rejects(s.submit(a, "overflow", input), /queue_full/);
  assert.equal((await s.cancel(a,t.id)).status, "cancelled");
  assert.equal((await s.submit(a,"replacement",input)).status,"queued");
});
test("scheduler: global/user/worker caps and rotation", async () => {
  const s=new MemoryTaskStore();
  for(const scope of [a,b,{userId:"c",organizationId:"oc"}]) for(let i=0;i<10;i++) await s.submit(scope,"k"+i,input);
  const running=(await Promise.all(Array.from({length:30},(_,i)=>s.claim("w"+i%2)))).filter(Boolean);
  assert.equal(running.length,10);
  assert.notEqual(running[0].userId,running[1].userId);
  for(const user of ["a","b","c"]) assert.ok(running.filter(t=>t.userId===user).length<=5);
  for(const worker of ["w0","w1"]) assert.equal(running.filter(t=>t.workerId===worker).length,5);
});
test("scheduler: expired leases fence stale workers and cancellation",async()=>{
 let now=1000; const s=new MemoryTaskStore({clock:()=>now});
 const t=await s.submit(a,"one",input); const first=await s.claim("old");
 now+=16000; const second=await s.claim("new");
 assert.equal(second.id,t.id); assert.equal(second.attempt,2);
 assert.equal(await s.finish(first,"succeeded"),false);
 await s.cancel(a,t.id); assert.equal(await s.heartbeat(second),false);
 assert.equal(await s.finish(second,"succeeded"),false);
 assert.equal((await s.get(a,t.id)).status,"cancelled");
});
test("scheduler: retries stop after three leases",async()=>{
 let now=1000; const s=new MemoryTaskStore({clock:()=>now});
 const t=await s.submit(a,"one",input);
 for(let i=0;i<3;i++){assert.ok(await s.claim("w"));now+=16000;}
 assert.equal(await s.claim("w"),null);assert.equal((await s.get(a,t.id)).status,"failed");
});

test('scheduler: global queue cap and input validation', async () => {
  const s = new MemoryTaskStore();
  for (let i = 0; i < 10; i++) for (let j = 0; j < 20; j++) {
    await s.submit({ userId: 'u' + i, organizationId: 'o' + i }, 'k' + j, input);
  }
  await assert.rejects(s.submit(a, 'global-overflow', input), /queue_full/);
  for (const bad of [null, {}, { ...input, durationMs: 5001 }, { ...input, outcome: 'execute' }]) {
    await assert.rejects(s.submit(a, 'bad', bad), /invalid_task/);
  }
});

test('scheduler: independent worker loop completes and shuts down', { timeout: 10000 }, async () => {
  const store = new MemoryTaskStore();
  const success = await store.submit(a, 'success', input);
  const failure = await store.submit(a, 'failure', { ...input, outcome: 'failure' });
  const controller = new AbortController(), errors = [];
  const work = runSimulationWorker(store, 'worker-loop', { signal: controller.signal, onError: e => errors.push(e) });
  try {
    for (let i = 0; i < 60; i++) {
      if ((await store.get(a, failure.id)).status === 'failed') break;
      await delay(100);
    }
    assert.equal((await store.get(a, success.id)).status, 'succeeded');
    assert.equal((await store.get(a, failure.id)).status, 'failed');
    assert.deepEqual(errors, []);
  } finally { controller.abort(); await work; }
});
test('scheduler: account governance cancels queued/running work and fences old workers', async () => {
  let now = 1000;
  const accounts = new Map([['a', { status: 'active', version: 0 }]]);
  const s = new MemoryTaskStore({
    clock: () => now,
    governance: { get: userId => accounts.get(userId) ?? { status: 'active', version: 0 } },
  });
  const running = await s.submit(a, 'running', input);
  const queued = await s.submit(a, 'queued', input);
  const claim = await s.claim('old-worker');
  const queuedId = claim.id === running.id ? queued.id : running.id;
  assert.equal(queued.governanceVersion, 0);
  assert.equal(claim.governanceVersion, 0);

  accounts.set('a', { status: 'suspended', version: 1 });
  assert.equal(await s.claim('replacement-worker'), null);
  assert.equal((await s.get(a, queuedId)).status, 'cancelled');
  assert.equal((await s.get(a, queuedId)).cancelReason, 'account_suspended');
  assert.equal((await s.get(a, running.id)).status, 'cancelled');
  assert.equal((await s.get(a, running.id)).cancelReason, 'account_suspended');
  assert.ok((await s.get(a, running.id)).cancelledAt >= now);
  assert.equal(await s.heartbeat(claim), false);
  assert.equal(await s.finish(claim, 'succeeded'), false);
  await assert.rejects(s.submit(a, 'blocked-suspended', input), /account_suspended/);

  accounts.set('a', { status: 'banned', version: 2 });
  await assert.rejects(s.submit(a, 'blocked-banned', input), /account_banned/);
  now += 16000;
  assert.equal(await s.claim('after-governance'), null);
});

test('scheduler: governance version fences a task even after account is restored', async () => {
  let now = 1000;
  const accounts = new Map([['a', { status: 'active', version: 0 }]]);
  const s = new MemoryTaskStore({
    clock: () => now,
    governance: { get: userId => accounts.get(userId) ?? { status: 'active', version: 0 } },
  });
  const task = await s.submit(a, 'version-fence', input);
  accounts.set('a', { status: 'suspended', version: 1 });
  accounts.set('a', { status: 'active', version: 2 });
  assert.equal(await s.claim('worker'), null);
  const cancelled = await s.get(a, task.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, 'governance_changed');
  assert.equal(cancelled.governanceVersion, 0);
});

for (const status of ['suspended', 'banned', 'active']) {
  test(`scheduler: governance takes precedence over the final expired lease (${status})`, async () => {
    let now = 1000, account = { status: 'active', version: 0 };
    const store = new MemoryTaskStore({ clock: () => now, governance: { get: () => account } });
    const task = await store.submit(a, 'final-lease', input);
    let claim;
    for (let attempt = 1; attempt <= 3; attempt++) {
      claim = await store.claim('worker');
      assert.equal(claim.attempt, attempt);
      now += 16000;
    }
    account = { status, version: status === 'active' ? 2 : 1 };
    assert.equal(await store.finish(claim, 'succeeded'), false);
    const cancelled = await store.get(a, task.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelReason, status === 'active' ? 'governance_changed' : `account_${status}`);
    assert.equal(cancelled.cancelledAt, now);
    assert.equal(cancelled.workerId, null);
    assert.equal(cancelled.leaseUntil, null);
  });
}

test('scheduler: unavailable governance rolls back lease recovery and permits a safe retry', async () => {
  let now = 1000, unavailable = false;
  const store = new MemoryTaskStore({ clock: () => now, governance: { get: () => {
    if (unavailable) throw new Error('offline');
    return { status: 'active', version: 0 };
  } } });
  const task = await store.submit(a, 'unavailable', input);
  for (let i = 0; i < 3; i++) { await store.claim('worker'); now += 16000; }
  const before = await store.get(a, task.id);
  unavailable = true;
  await assert.rejects(store.claim('replacement'), /governance_unavailable/);
  assert.deepEqual(await store.get(a, task.id), before);
  unavailable = false;
  assert.equal(await store.claim('replacement'), null);
  assert.equal((await store.get(a, task.id)).status, 'failed');
});
