# C00-02 Platform consumer status

This branch consumes the published `@bairui/contracts` `v2.3.0-rc.2` release
from the immutable codeload tag URL. The tag resolves to merge commit
`f5c14223e8f26ff00712f4b0ab65402621a1239e`; `package-lock.json` records the
downloaded archive integrity.

Canonical control delivery uses `LeaseRequestEnvelope`, `LeaseEnvelope`, and
`ReceiptEnvelope`. Every mutation carries the generated owner scope, revision,
sequence, timestamp, nonce-independent embedded signature, and is also sent
under the existing timestamp/nonce/body transport HMAC.

The embedded HMAC uses the same per-server derived machine key. Its canonical
input is recursively key-sorted JSON for the full mutation, with
`signature.algorithm`, `signature.key_id`, and `signature.signed_at` included
and only `signature.value` omitted. Platform-issued leases use the target
`server_id` as `key_id`, allowing the Server Agent to verify the response with
its existing machine credential. This rule is part of the C00-03 integration
contract and must not be silently changed by either consumer.

New canonical traffic cannot issue or lease `config.apply-user`, cannot contain
raw secret or configuration documents, and cannot report final `succeeded` in
an executor receipt. Executor completion is `completion_candidate`; final
success belongs to an Authority-derived `command.verified` event.

The rc.2 audit release also rejects `approval_id` on canonical non-approval
commands and leases and requires signature, timestamp, and nonce transport
headers on every control mutation.

The existing PostgreSQL and memory repositories still implement the legacy
delivery model. This consumer task does not modify those repositories or their
migrations. Canonical HTTP routes therefore require an injected C00-03 Control
Authority and fail closed while that service is absent.

The production HTTP entry is exactly `POST /api/internal/control-plane/leases`
for lease requests and `POST /api/internal/control-plane/receipts` for receipts.
The former `/commands/lease`, `/commands/receipts`, and command-id receipt paths
remain Contracts compatibility descriptions only; Platform does not route or
silently translate them into the Authority.

This is a cross-repository consumer candidate, not a `GATE-C00` result.
