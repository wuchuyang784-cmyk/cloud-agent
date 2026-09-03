# Durable channel bridge

## Deployment boundary

External channel traffic does not run inside Hermes and does not share Agent
Runtime credentials. The Platform owns tenant bindings, encrypted credentials,
durable state and Runtime routing. A separate Channel Worker owns vendor SDKs,
webhooks, long-lived connections and outbound delivery.

```text
Feishu / WeChat / QQ
  -> Channel Worker
  -> signed internal channel API
  -> PostgreSQL channel_inbox
  -> Platform ChannelIngressWorker
  -> Agent Runtime -> Hermes
  -> PostgreSQL channel_outbox
  -> leased Channel Worker delivery
  -> vendor API
  -> durable delivery receipt
```

The Channel Worker uses a dedicated `channel-worker` machine credential. It
cannot authenticate as an Agent Runtime or Server Agent. Inventory responses
contain binding metadata only. Decrypted vendor credentials are returned only
by the binding-scoped resolve endpoint and must not enter browser responses or
ordinary logs.

## Delivery semantics

Ingress is deduplicated by binding and vendor message ID. Runtime processing
and outbound creation commit through PostgreSQL. Outbound records are leased
with `FOR UPDATE SKIP LOCKED`; receipts must match the worker, binding, attempt
and lease token. Expired leases can be retried, and exhausted or terminal
failures enter `channel_dead_letters`.

The bridge provides at-least-once processing. Vendor APIs may accept a message
before a receipt reaches the Platform, so adapters must use vendor idempotency
or reply identifiers whenever the vendor supports them. The system must never
claim exactly-once external delivery.

## Dynamic bindings and health

The Worker periodically loads active binding inventory. A credential change
increments `connection_generation`, causing the corresponding adapter to stop,
resolve the new credential and restart. A failed adapter startup is not entered
into the active adapter set and is retried on the next inventory refresh.

`connected` is evidence, not a saved-form state. It requires both `receive` and
`send` capabilities and a real vendor handshake:

- Feishu: SDK WebSocket readiness.
- WeChat Official: successful token probe plus a verified callback handshake.
- QQ: Gateway `READY` or `RESUMED` after official token authentication.

Pending, failed or unconfigured accounts remain non-connected. Administrators
see adapter version, capabilities, health timestamps and error codes, but not
channel message content or credentials.

## Callback and operations

The public WeChat callback is `/callbacks/wechat/{binding_id}`. Host Nginx
proxies `/callbacks/wechat/` to the Worker loopback listener on port `8790`.
The Worker marks a replay only after the Platform durably acknowledges ingress.

Production requires the same `BAIRUI_CHANNEL_WORKER_ID` and rotated
`BAIRUI_CHANNEL_WORKER_TOKEN` in the Platform and Worker environments. The
token belongs in a restricted server secret file or GitHub Environment Secret,
never in source control. Platform migrations must complete before the Worker
starts; Worker `/ready` becomes healthy after a successful inventory fetch,
including the valid case where no channel bindings exist.
