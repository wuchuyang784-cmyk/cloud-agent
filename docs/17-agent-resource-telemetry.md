# Agent Resource Telemetry

## Scope

Resource telemetry belongs to the BaiRui control plane. It describes the
infrastructure around each Agent and does not participate in Hermes Agent
execution.

The Server Agent reports:

- Agent, Runtime, deployment, and server identifiers;
- Hermes and Runtime Boundary container roles and lifecycle states;
- CPU percentage and memory used/limit;
- fixed Agent workspace and container writable-layer size;
- host filesystem used/limit;
- operating system, architecture, Docker version, and CPU count;
- container image/version metadata, start time, and uptime.

It does not report prompts, conversations, memory bodies, files, environment
variables, API keys, connector tokens, browser fingerprints, or end-user
device contents.

## Collection Boundary

`server-agent/resource-collector.mjs` reads only `instance.json` records below
the configured Agent instances root. Container names must match the local
Supervisor naming contract. Collection uses fixed argument arrays:

```text
docker info --format {{json .}}
docker container ls --all --no-trunc --format {{json .}}
docker container inspect --size <managed names>
docker stats --no-stream --no-trunc --format {{json .}} <running managed names>
```

No platform field can become a command, path, image, or Docker argument.

## Authentication And Ownership

The daemon signs `POST /api/internal/control-plane/resources` with the server
machine credential. The platform ignores tenant/user claims from the sender
and derives ownership from:

```text
server -> control deployment -> Agent -> owner -> Runtime
```

A sample is rejected unless all identifiers belong to the authenticated
server deployment.

## Storage And Retention

PostgreSQL stores aggregate samples in `agent_resource_samples` and container
details in `agent_container_resource_samples`. Container rows cascade with the
parent sample. The organization's telemetry retention period removes both.
Samples older than `BAIRUI_RESOURCE_STALE_AFTER_MS` are rendered as offline.
CPU, memory, and host-storage pressure at or above 90 percent opens a scoped
control-plane alert; a healthy sample resolves it.

## Administrator Access

`GET /api/admin/agents` returns only the latest scoped sample. The Agent detail
endpoint `GET /api/admin/agents/:agent_id/resources` returns bounded history.

- platform administrators may view all organizations;
- organization administrators may view only their organization;
- ordinary users cannot access `/admin` or either administration API.
