# Platform Route Boundaries

The Platform HTTP process is one deployment boundary, but its request domains
must not be implemented as one route monolith. apps/web/app.mjs owns request
orchestration, shared business helpers, principal resolution, and the final
error boundary. Route modules own URL matching and response completion for one
domain.

## Handler contract

Every route module is created once with explicit dependencies and receives a
request context containing method, url, request, response, and principal.

- return true only after the module has completed the response;
- return false when the URL does not belong to the module;
- throw authorization, validation, repository, and Runtime failures so the
  application error boundary applies the common response policy;
- never call another route module or silently convert an upstream failure into
  a successful response.

## Current ownership

| Module | Owned routes | Authority |
| --- | --- | --- |
| routes/auth.mjs | login, registration, logout, current principal | session identity and login throttling |
| routes/user-runtime.mjs | Hermes discovery, sessions, chat streams, Runs, Jobs | authenticated Agent-scoped Runtime data plane |
| routes/admin-control.mjs | control commands, approvals, immutable release manifests | RBAC-governed control and release decisions |
| routes/internal-control.mjs | canonical command lease and receipt envelopes | machine transport authentication plus C00-03 Control Authority |
| http.mjs | bounded JSON parsing, responses, origin comparison, security headers | shared transport policy |
| app.mjs | composition and domains not migrated yet | temporary orchestration and compatibility boundary |

The remaining user Agent, memory, channel, integration, administrator fleet,
provider, retention, license, server, and internal machine routes must follow
the same contract. Moving a route must preserve its existing permission,
organization scope, audit write, transaction, status code, and error code.

## Prohibited regressions

- authentication, Runtime session, Run, Job, control approval, or release
  manifest routes must not be reintroduced into app.mjs;
- route modules must not parse cookies or invent independent error envelopes;
- internal control routes must verify timestamp/nonce/body transport HMAC and
  the embedded mutation signature before calling the Control Authority;
- internal control routes must never fall back to legacy repository lease or
  receipt transitions when the Control Authority is unavailable;
- canonical control delivery has one HTTP entry per operation: `/leases` and
  `/receipts`; legacy command-prefixed paths must not alias the Authority;
- administrator routes must not gain access to conversation, prompt, or memory
  bodies;
- Runtime routes must resolve the Agent through the authenticated owner before
  calling the Runtime client;
- module extraction is not permission relaxation and does not create a second
  public API.
