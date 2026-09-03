# U01-05 Live Panel Evidence

Status: `IN_PROGRESS`

`GATE-U01` remains `PENDING`. This document records the evidence collected for
U01-05; it does not promote the gate and it does not claim production
readiness.

## Baseline

| Item | Commit/tree or version | Role |
| --- | --- | --- |
| Platform U01-04 source | `765e11ac059a0e213cdfcedea3001ccc002e3304` / tree `8a357beb5bbd3128238ee3e7f5da387a9be1afb0` | requested implementation baseline |
| Platform PR #62 head | `99b2f8303cfa89312a814ab1626d55695c17c84b` / same tree | merged PR source |
| Platform PR #62 merge | `3366c6b1c86606bbd0e3ef0613b2e324761c15f1` / same tree | remote merge fact |
| Platform PR #63 merge | `3811c9c0450d5bd68e0c7f4c3cb499aed18310e6` / tree `90607557699c9fb5674902edc78ba96a3487ea15` | browser layout convergence fix consumed as-is |
| Platform PR #65 merge | `1b65bbb6cd762c9f1822e396fc610d12b3118aa5` / tree `8ecd8bb6c44c007a194f7225d198b19579f44b76` | Contracts `2.3.0-rc.2` consumer baseline |
| Platform PR #66 merge | `4d4b934b1c69e90cdfaca44bfd7f4b3a6b0218aa` / tree `68797476f60662d5be5d9f4c2aa5ddc88e8f92a3` | previous U01-05 base; external-proxy release changes retained |
| Platform PR #67 merge / final replay base | `0b3c38080fe2e099b4993362d429ed0cbfce25c9` / tree `00c017400951f17f260ffb51cc0e0def0cb85450` | latest main; Agent ownership and provider setup fixes retained |
| Published Contracts | `@bairui/contracts` `2.3.0-rc.2` | canonical control and validation dependency loaded by the final verification tree |
| BaiLongma upstream | `xiaoyuanda666-ship-it/BaiLongma` `2.1.515` at `34d939eabe226c561550079cb810090015b49817` | pinned visual source |

U01-05 changes are limited to the Platform BaiLongma host adapter, Scene
projection/transport, panel contracts, fixtures, browser acceptance and this
evidence. The `user-runtime` semantic changes from the earlier U01-05
candidate are already present in PR #67's latest tree and were preserved;
the final replay does not overwrite them. Runtime/Hermes core, Contracts C00
and PostgreSQL Control Authority were not changed by this delivery.

The U01-04 browser stability change from PR #63 is consumed as-is. U01-05
does not reintroduce a fixed sleep or duplicate that fix; its acceptance keeps
the upstream `requestAnimationFrame` convergence wait and adds only panel
coverage assertions.

## Scene Layering Fix

The failed server run at the `fd352e4` worktree exposed a stacking contract
error: the BaiRui overlay raised `#stage` to `z-index: 180`, while the pinned
BaiLongma native panel tabs remained at `10` and the native panels/chat were
below that level. A full-screen Scene surface could therefore receive the tab
click before the native control.

The fix keeps the Scene projection below the native shell in
`apps/web/public/bairui-bailongma.css`:

| Layer | Desktop/tablet level | Mobile level | Ownership |
| --- | ---: | ---: | --- |
| Scene `#stage` | `2` | `2` | BaiRui Scene projection |
| native panels | `20` | `120` | BaiLongma shell |
| native chat | upstream mode-specific level (baseline `4`) | upstream mode-specific level | BaiLongma shell |
| native panel tabs | `40` | `122` | BaiLongma shell |
| BaiRui toolbar | `190` | `190` | BaiRui overlay |
| BaiRui workspace | `200` | `200` | BaiRui extension host |
| onboarding/modal | `210` | `210` | BaiRui overlay |

The overlay does not rewrite the native chat stacking rule; this preserves
BaiLongma mode-specific behavior. `tests/browser/remote-acceptance.mjs` now
checks the real `elementFromPoint` target for both native panel tabs and checks
that chat controls are never hit through a Scene surface. It also asserts the
computed Scene/native layer ordering at wide and tablet shell viewports. The
mobile drawer/tab checks remain covered by the existing `120/122` media-query
contract.

## Native Interface Coverage

The matrix scanner reads the pinned upstream source roots
`src/ui/brain-ui` and `src/ui/scene-shell`. It currently covers:

- 15 source files;
- 22 source/transport buckets;
- 77 transport call sites: 65 `fetch`, 6 `postMessage`, 3 SSE and 3 WebSocket.

Every scanned source is assigned to a panel in
`docs/BAILONGMA-LIVE-PANEL-MATRIX.json`. The matrix records the original
interfaces, the five-layer owner, truth source, persistence, revision,
recovery and ownership. The executable check is
`tests/bailongma-live-panel-matrix.test.mjs`.

The original BaiLongma module contract is preserved: `app.js` still imports
and calls `bootstrapScene()`. BaiRui replaces only the transport behind that
function. No global `fetch`, `EventSource` or `WebSocket` is replaced, and the
build applies an explicit patch queue against the pinned source commit.

## P0 Contract

The executable contract is `bairui.panel-manifest.v1`, served only under the
owner-scoped route
`/api/user/agents/:agent_id/ui/panels`. The eight P0 panels are:

`shell-layout`, `memory-graph`, `chat`, `scene-shell`, `settings`,
`social-channels`, `hotspots`, `person-card`.

For every P0 panel the manifest explicitly carries `snapshot`, `command`,
`events`, `persistence`, `revision`, `recovery` and `ownership`. Dynamic
states are restricted to `available`, `needs_configuration`,
`temporarily_unavailable` and `unsupported`. A capability without a backend
loop is returned as a visible unsupported/configuration state; it is not an
empty success response or static fake data.

## Verified Five-Layer Loop

The verified live slice is the `hotspots` panel:

1. BaiLongma hotspot UI invokes the explicit host adapter.
2. The Agent-scoped Platform Panel BFF validates the owner and revision.
3. `RuntimeClient.invokeIntegration` forwards the typed operation.
4. The `trendradar.list_hotspots` integration returns normalized items.
5. The repository persists the integration result and Agent Scene revision;
   Scene SSE emits the snapshot/patch back to the UI.

The acceptance fixture proves revision `0 -> 1`, stale revision rejection with
HTTP `409`, `Last-Event-ID`/full resync behavior, durable-compatible snapshot
readback, and a peer's cross-owner access rejection with HTTP `404`. Legacy
`/audit/stats` and unscoped panel state routes no longer return fabricated
`ok` responses.

The browser fixture uses an in-memory repository for deterministic acceptance.
It is evidence of the complete route and ownership behavior, not evidence of a
live PostgreSQL or production Hermes deployment.

## Deterministic Build

Two builds were generated from empty dedicated output directories after the
final source changes:

| Check | Result |
| --- | --- |
| Files in build A/B | `63 / 63` |
| Build A tree SHA-256 | `95ad7d2259932b7882e9e1c2de6ee968b75291e284fae7d7d7149341514a6544` |
| Build B tree SHA-256 | `95ad7d2259932b7882e9e1c2de6ee968b75291e284fae7d7d7149341514a6544` |
| Per-file diff | `0` |
| Source version/commit | `2.1.515` / `34d939eabe226c561550079cb810090015b49817` |
| Patch manifest SHA-256 | `903583ef3e0f54a4ca47131d9370bb9627deed7bb28720310930705dcf0e3803` |
| `brain-ui.html` hash | `196ce553375e2302f7cd6aa2dec7fd27a842002bc06a8238a02395362b12945c` |
| transformed `app.js` hash | `2ea3713e34182b83e69b32ec67efbfabd0286cfb122221c4d96832948b90f789` |
| transformed `hotspot.js` hash | `f667d79491d4a625794e01ec6ca8b09db73264ef59533e5e98864655b0329ec1` |

Reproduction command:

```text
node scripts/build-bailongma-ui.mjs --out <dedicated-output-a>
node scripts/build-bailongma-ui.mjs --out <dedicated-output-b>
```

## Four-Viewport Browser Evidence

Command:

```text
node tests/browser/remote-acceptance.mjs
```

The post-fix run completed with no browser page errors and passed the live
panel, initialization, approval, ownership, overflow, modal-layer and native
hit-target assertions. It was run once through the local fixture and once in
the isolated server validation tree
`/opt/bairui-validation/platform-u01-05-layer-c319007`; the server run served
the same two source files whose SHA-256 values are recorded below. The server
run output ended with `Remote browser acceptance passed`.

The server screenshot artifacts were generated under
`/opt/bairui-validation/platform-u01-05-pr66-final/test-results/remote-browser-acceptance/`:

| View | Artifact | Size | SHA-256 |
| --- | --- | --- | --- |
| Wide workspace | `user-wide-workspace.png` | `1920x1080` | `50d37e155a2adb72af49a0dfb4a69fcd8ce046f7dd7a07321bd54ba009bc3353` |
| Desktop live hotspot | `user-desktop-hotspots-live-panel.png` | `1440x1000` | `7392d67bf1ab9e02bb1bd9cb94229a6742f3e94a2e378e219f8a7eba69169cd1` |
| Tablet workspace | `user-tablet-workspace.png` | `1024x768` | `e0c694fd7b145983f2c0d7cce04f215d26b86005fd1ad7785370978d73cff2f4` |
| Mobile memory | `user-mobile-memory.png` | `390x844` | `4c3182c6814c788195b205c209cec58c3df3a05a89bdb52396a440eec79f120c` |

The mobile Hermes initialization artifact was also captured at
`390x844` with SHA-256
`8dd796c1662da256393c220d90a142385bd588ab94e7ff3897691fe94fc3ad3d`.
The workspace and initialization layers are above the Scene projection, so a
Scene status surface cannot occlude user controls.

## Test Results

The final verification set includes:

- full Node suite: `166` tests, `160` passed, `6` skipped, `0` failed;
- Platform structural check: passed;
- deterministic two-build comparison: passed, zero file differences;
- local Playwright fixture acceptance: `4/4` viewport scenarios passed, `0`
  failed (`1920x1080`, `1440x1000`, `1024x768`, `390x844`);
- server Playwright acceptance: `4/4` viewport scenarios passed, `0` failed;
  the raw terminal line was `Remote browser acceptance passed`.
- server source-file hashes matched the submitted patch: CSS
  `7c13e4dbef92f9e111b03355715beed4c2cd23ccba068e406ef3f693228fdd0f` and
  acceptance script
  `6dd67b0f495371cf94ef8df3b864855fdca11e0c64f837e2a8a78ffe9a4ed2c4`.

Both the local verification tree and the isolated server install resolved the
published Contracts dependency at exactly `2.3.0-rc.2`; `package.json` and
`package-lock.json` pin the same release URL and version.

## Remaining Evidence and Gate Boundary

U01-05 stays `IN_PROGRESS` because this delivery has not yet supplied all of
the following production evidence:

- GitHub CI verification for the final commit;
- real PostgreSQL persistence and migration evidence;
- a real Hermes Runtime and configured TrendRadar source in the deployed
  environment.

The server four-viewport run is browser evidence from an isolated validation
copy using the deterministic acceptance Runtime fixture. It is not evidence
that the production Hermes/TrendRadar or PostgreSQL data plane is configured.

Until those checks are attached, do not mark `U01-05` `DONE` and do not mark
`GATE-U01` `PASS`.
