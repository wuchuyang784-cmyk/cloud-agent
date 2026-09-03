# Remote Browser Acceptance

The BaiRui user surface is accepted through GitHub Actions with a real Chromium
browser. The test starts the real platform HTTP server, serves the pinned
BaiLongma Brain UI, uses the real user and administrator scripts, and exercises
the real session, RBAC, memory, and admin routes. Only the Hermes Runtime is a
deterministic fixture.

The acceptance gate covers:

- the BaiLongma memory graph rendering PostgreSQL-backed Obsidian notes;
- all user workspace modules and the Hermes memory capacity summary;
- a streamed Hermes session response over the native SSE contract;
- the immutable BairuiHostAdapter without global fetch or EventSource
  replacement;
- main-chat approval.request decisions reaching runs.approve;
- a stop clicked before run.started being queued and reaching runs.stop;
- ordinary-user denial for `/admin` and `/api/admin/*`;
- the platform administrator Agent fleet across multiple owners;
- desktop and 390 x 844 mobile layouts without horizontal overflow;
- retained screenshots for user memory, chat, desktop/mobile approval, and the
  administrator fleet.

The fixture never connects to production, never reads production credentials,
and cannot mutate a deployed Agent. Passing this check validates the browser
adapter and platform boundary; production deployment remains a separate,
explicit release action.

Run in an isolated environment with:

```text
npm run test:browser:remote
```
