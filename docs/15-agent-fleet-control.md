# Agent Fleet Control

## Scope

The BaiRui control plane manages deployment state around Hermes. It does not
submit prompts, inspect conversation content, invoke tools, or mutate runtime
memory.

## User initialization

1. The user creates an owned Agent and isolated Runtime record.
2. The user completes the Hermes model form with either an Agent-owned
   OpenAI-compatible Provider, HTTPS Base URL, model id, and API key/token, or
   explicitly selects a platform-managed Provider.
3. The platform verifies ownership and model policy, encrypts an Agent-owned
   credential when supplied, and verifies that a healthy server has capacity.
4. The platform creates an Agent-scoped configuration revision, Deployment,
   desired state, and `deployment.provision` command in one transaction.
5. The Agent remains `provisioning` until an Agent heartbeat proves that
   Hermes and the Runtime Boundary are healthy.

No API reports `ready` merely because a command was queued.
Agent-owned model credentials are scoped by organization, owner, and Agent.
They are masked in every browser response and cannot be read by another user
in the same organization or by the administrator fleet view.

## Fleet telemetry

Each Runtime reports an ordered heartbeat containing identifiers, versions,
five-layer component health, numeric metrics, usage aggregates, and redacted
operational events. The ingestion endpoint rebuilds the payload from an
allowlist and never stores submitted prompt, message, memory, or secret fields.
The server identity separately reports CPU, memory, Agent storage, host storage,
OS/architecture, managed container roles, images/versions, and start time. The
platform derives organization and owner from deployment records rather than
trusting sender-supplied tenant fields.

PostgreSQL authorities:

- `agent_runtimes` for current Runtime placement and health;
- `agent_components` for the latest five-layer component observation;
- `heartbeats` for ordered liveness evidence;
- `agent_resource_samples` for aggregate infrastructure history;
- `agent_container_resource_samples` for Hermes/Boundary container details;
- `telemetry_events` for redacted operational events;
- `usage_rollups` for per-Agent model usage and cost;
- `alerts` for actionable fleet incidents;
- `secret_references` for vault references, never plaintext secrets.

## Administrator view

`/admin` reads fleet metadata through scoped administrator APIs. Platform
administrators see all organizations; organization administrators see only
their organization. Ordinary users cannot access these APIs.
