# Multi-tenant Agent Runtime

## Ownership

Every Agent has one authoritative owner (`owner_user_id`) and one isolated
Hermes Runtime record. `agent_memberships` allows future operator and viewer
sharing without weakening the owner boundary.

The browser can address only Agents owned by its authenticated user. Platform
administrators observe fleet metadata through `/admin`; they do not receive
Hermes machine credentials or conversation content.

## Runtime routing

The platform sends `organization_id`, `user_id`, and `agent_id` to the BaiRui
Runtime Boundary. `BairuiRuntimeClient.resolveRuntime(agent)` is the placement
boundary for resolving an Agent-specific endpoint and machine credential.
Hermes API keys never enter browser responses.

The supported user data path is:

```text
BaiLongma Brain UI
  -> BaiRui browser adapter
  -> /api/user/agents/{agent_id}/...
  -> signed Runtime operation or stream
  -> Agent-specific Runtime Boundary
  -> Hermes public API server
```

## Transcript authority

Hermes Sessions are authoritative for conversation metadata, messages,
lineage, usage, and streaming events. The legacy PostgreSQL conversation and
message tables remain migration-compatible but are no longer written by user
chat APIs. PostgreSQL may later hold search and usage projections with Hermes
session identifiers as provenance.

## BaiLongma boundary

BaiLongma contributes its Brain UI. Its Agent loop, model runtime, SQLite
state, memory engine, and tool executor are not imported. The browser adapter
maps native Hermes session SSE event names into the existing Brain UI view
events. It does not manufacture successful completion events or assistant
messages.

## Initialization states

Agents and Runtimes expose explicit lifecycle state. Creating an Agent produces
an `uninitialized` Runtime and opaque `workspace_ref`; it does not claim that
Hermes is ready. Provisioning, configuration application, health verification,
and activation are control-plane operations implemented separately.
