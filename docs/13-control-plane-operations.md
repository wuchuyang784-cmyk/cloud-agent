# Bairui Control Plane Operations

The production control plane covers fleet, identity, configuration, releases,
tests, upstreams, backups, observability, incidents, integration/channel
lifecycle, and audit. It does not run Agent tasks.

## Configuration loop

Save encrypted revision -> evaluate risk -> approve -> lease `config.stage` ->
stage -> lease `config.apply` -> apply through the supported Hermes deployment
configuration surface -> restart if required -> probe -> mark applied or roll
back. Saving Provider settings alone never means they are active, and the
control plane never selects a Provider for an individual Agent run.

The former Agent-owner `config.apply-user` dispatch loop is quarantined. The UI
may continue to save an owner preference, but no canonical command may be
issued until C00-03 models the preference as DesiredState plus an allowlisted
deployment adapter and post-action Observation. Consumers must not translate
the legacy action or pass the generated configuration document through a
lease.

## Release loop

CI builds immutable GHCR images and emits digest, SBOM, provenance, and
signature. Platform gates the manifest, creates a verified backup, deploys a
canary, evaluates SLO/probe/test evidence, then expands or rolls back. Direct
`docker cp` and `docker commit` are emergency-only and not a release process.

## Test and upstream loop

Remote tests name a registered suite; commands cannot carry source or scripts.
Artifacts are immutable, redacted, retained by policy, and linked to a gate.
Upstream drift creates a candidate, runs compatibility tests, and enters the
release workflow only after approval. Production never silently tracks an
upstream branch head.

## Backup and incident loop

PostgreSQL is the authoritative BaiRui production database. Backups are
encrypted, checksummed, retained, verified, and restore-drilled against RPO/RTO.
An Agent backup restore accepts only a registered backup identifier, requires a
platform-administrator approval, validates the encrypted backup and Agent
identity, stops the fixed Runtime containers, preserves rollback history, and
restarts the same deployment. Host paths and archive locations never enter the
control command.
Retention enforcement runs automatically for every organization. It removes
expired heartbeat, telemetry, usage, sensitive-access, and audit rows according
to the stored policy. Audit hash-chain nodes remain after their event payloads
expire. Backup files are removed only through an internal `backup.expire`
command resolved against the Server Agent's fixed backup root; retention never
sends a host path.
Agent resource samples use the same telemetry retention cutoff and delete
container details by cascade.
Incidents link alerts, SLO impact, observations, actions, evidence, and audit.
Closure requires a healthy post-remediation observation.

## Delivery order

1. Protocol and PostgreSQL control model.
2. Deployment identity and long-running outbound agent.
3. Lease/event/outbox workers and replay handling.
4. Provider configuration apply/verify/rollback loop.
5. Release, test, backup, upstream, incident, and fleet workflows.
6. Administrator UI for the formal domains and approval queues.

This order is dependency-driven, not an MVP scope reduction. Every domain and
security boundary above remains part of the production target.
