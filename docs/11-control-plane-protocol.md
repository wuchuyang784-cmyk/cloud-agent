# Bairui Control Plane Protocol

Protocol version `1.0` is operational control traffic only.

`@bairui/contracts` is the canonical schema, generated type, and runtime
validation source. Platform pins an immutable contracts tag and
`packages/server-protocol/control-plane.mjs` only re-exports that implementation.

Allowed actions:

- `snapshot.collect`
- `probe.run`
- `contract.test`
- `smoke.test`
- `upstream.check`
- `config.stage`
- `config.apply`
- `backup.create`
- `backup.verify`
- `backup.restore`
- `backup.expire`
- `release.stage`
- `release.apply`
- `release.rollback`
- `service.restart`

There is no generic command and no prompt, conversation, task, model, tool,
skill, runtime-memory, or Runtime API action. The shared contracts validator
enforces the allow-list and action-specific identifier arguments.

## State machine

```text
queued -> leased -> accepted -> running -> completion_candidate
                                      \-> failed
completion_candidate -> verifying -> command.verified -> succeeded
queued/leased/accepted/running -> cancelled or expired
```

Each lease has an expiry and attempt number. Each event has a monotonic sequence.
The platform deduplicates command id, idempotency key, attempt, and event
sequence. A command that expired before execution is never started.

## Separation

| Protocol | Data | Credential |
| --- | --- | --- |
| Control | deployment state, references, observations, evidence | deployment identity |
| Resource telemetry | CPU, memory, storage, OS/architecture, container lifecycle | server identity |
| Runtime | `RuntimeRequest`, result, runtime event | Runtime shared secret |
| Channel | inbound/outbound message, delivery receipt | connector identity |

A credential from one protocol cannot authenticate to another. Control command
arguments contain revision/release/backup/probe/service identifiers, never raw
secret values, user content, or executable text.

`config.apply-user` is a legacy-readable, quarantined action. Contracts
`v2.3.0-rc.2` rejects it in new command and lease envelopes, and consumers must
not translate it into another canonical action. Existing repository rows and
the legacy Supervisor handler remain migration input for C00-03; they are not a
valid issuance path. The general `config.apply` path remains
platform-administrator approval-gated.

## Closed-loop result

A command is not successful merely because an API accepted it. A Server Agent
may emit only `completion_candidate`; success requires Authority verification
against a newer matching post-action observation and evidence. Configuration
and release records stay `pending` or `applying` until verification succeeds;
failure records the evidence and either rolls back or blocks further rollout.
