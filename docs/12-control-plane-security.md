# Bairui Control Plane Security

## Identity and transport

- one asymmetric identity per deployment;
- short-lived one-time enrollment bound to organization and server;
- signed envelopes with nonce, event sequence, issue time, and expiry;
- key rotation and revocation independent of Hermes credentials;
- outbound server-agent connection with TLS; no public management port.

## Authorization

Ordinary users cannot access control administration. Organization administrators
see only their organization and cannot access raw provider secrets. Platform
administrators manage fleet and releases. High-risk apply, rollback, restore,
and restart actions require explicit approval; policy can require a different
approver from the requester. Authorization is rechecked when leasing and when
executing, not only when creating a command.

## Data boundary

Control storage and telemetry exclude prompts, replies, conversations, files,
Obsidian note bodies, Hermes memory, model keys, connector tokens, database
passwords, private keys, and unrestricted logs. Operational records contain
identifiers, versions, hashes, redacted errors, and artifact references.
Resource telemetry is limited to registered Agent containers and fixed
workspace/host filesystem metadata. It excludes environment values, end-user
device fingerprints, user files, and business content.

Secrets use envelope encryption for the intended server identity. Plaintext is
unwrapped only in target memory, never returned by an API, snapshot, command
event, log, or test artifact.

## Execution and supply chain

- strict action and argument schemas; no shell/script/SQL payload;
- least-privilege local adapters with time and resource bounds;
- immutable release digests, signatures, SBOM, and provenance;
- migration, backup, compatibility, contract, and smoke gates;
- append-only audit plus a hash chain for tamper evidence;
- emergency access remains allow-listed, time-limited, approved, and audited.
