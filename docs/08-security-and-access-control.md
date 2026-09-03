# Security And Access Control

The platform enforces authorization on the server. Hiding navigation is only a
user-experience detail and is never accepted as an access-control decision.

## Roles

| Role | Scope | Administration |
| --- | --- | --- |
| `user` | own organization and own conversations | none |
| `org_admin` | one organization | members, agents, organization audit |
| `platform_admin` | platform | organizations, users, licenses, servers, releases, control plane |

## Surface Separation

- `/app` and `/api/user/*` are the user product surface.
- `/admin` and `/api/admin/*` are the administrator surface.
- `/api/internal/*` uses machine credentials and never accepts a user session
  as sufficient authority.
- Ordinary users receive `404` for the administrator page and `403` for
  administrator APIs.
- Organization administrators are constrained by `organizationId` on every
  resource lookup.

## Required Production Configuration

- `BAIRUI_SESSION_SECRET`: random value of at least 32 characters.
- `BAIRUI_BOOTSTRAP_ADMIN_EMAIL`: initial platform administrator identity.
- `BAIRUI_BOOTSTRAP_ADMIN_PASSWORD`: initial password; rotate after bootstrap.
- `BAIRUI_AGENT_INGEST_TOKEN`: separate machine credential for control-plane
  ingestion.
- `BAIRUI_PLATFORM_ORIGIN`: canonical HTTPS origin used for origin checks.
- `DATABASE_URL`: protected PostgreSQL connection string.

The repository must not contain real values for any of these settings.
