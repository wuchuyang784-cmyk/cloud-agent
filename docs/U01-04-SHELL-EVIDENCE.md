# U01-04 Single UI Shell Evidence

## Claim boundary

This document records evidence for **U01-04 only**: convergence on one
BaiLongma-based ordinary-user Shell.

It does not complete U01-05, does not validate every BaiLongma live-panel
backend contract, and does not claim that Gate U01 passes. It does not change
the Agent or Contracts repositories.

## Fixed inputs

- Platform baseline: `a6c70bb43163dc2b7489a6eb1bfa71d76a5acb6d`
- Work branch: `codex/u01-04-shell`
- BaiLongma repository: `xiaoyuanda666-ship-it/BaiLongma`
- BaiLongma commit: `34d939eabe226c561550079cb810090015b49817`
- BaiLongma version: `2.1.515`
- Contracts dependency used by the tests: `@bairui/contracts@2.2.1`

The BaiLongma gitlink is unchanged. All BaiRui modifications are replayed by
the registered build transform and private extension assets.

## Delivered Shell

### One ordinary-user frontend

- `/app` continues to render the verified BaiLongma Brain UI artifact.
- The old handcrafted user script remains absent.
- The dead `.brain-*`, feature-workspace, duplicate conversation, and old
  user navigation styles were removed from `apps/web/public/styles.css`.
- The administrator application remains a separate route and build. Its CSS
  section was preserved unchanged.
- Ordinary-user assets contain no administrator link, control-plane menu,
  Fleet view, or server inventory.

### Native BaiLongma frame

The source transform now composes the native graph, left and right panels,
native theme switcher, native panel tabs, BaiRui extension host, and native
console in one markup tree. It also:

- removes the unused local `createSettingsModal()` instance from the rendered
  tree;
- reuses BaiLongma `settings-overlay`, `settings-modal`, `settings-nav`, and
  `settings-content` components for the BaiRui workspace;
- restores the upstream-defined theme switcher that BaiLongma `2.1.515`
  defines but omits from `createBrainUiMarkup()`;
- scopes BaiRui CSS through `body[data-bairui-shell]`;
- keeps the semantic graph visible without modifying the upstream checkout.

### Independent panels and responsive drawers

- Left and right panel controls retain independent persisted collapse state.
- Controls expose `aria-controls`, `aria-expanded`, panel `aria-hidden`, and
  `inert` state.
- At `390x844`, both panels start closed and open as mutually exclusive,
  bounded drawers over a scrim.
- Escape and scrim actions close the mobile drawer.
- Returning from mobile to desktop restores the prior desktop panel state.

### Extension boundary

`bairui-workspace.js` now owns only registry, lifecycle, navigation, error,
dialog, and host-command utilities. It contains no centralized `renderX`
views and does not assign workspace page `innerHTML`.

The following views are independent Agent-scoped extensions:

| View | Asset |
| --- | --- |
| Conversations | `bairui-workspace-conversations.js` |
| My Agents and character cards | `bairui-workspace-agents.js` |
| Obsidian/Hermes memory | `bairui-workspace-memory.js` |
| Skills and toolsets | `bairui-workspace-skills.js` |
| Channels | `bairui-workspace-channels.js` |
| Hotspots | `bairui-workspace-hotspots.js` |
| Runs and approvals | `bairui-workspace-runs.js` |
| Hermes Jobs | `bairui-workspace-jobs.js` |
| Usage | `bairui-workspace-usage.js` |
| Hermes capability center | `bairui-workspace-hermes.js` |
| Agent settings and personal connections | `bairui-workspace-settings.js` |

All assets are injected by the deterministic BaiLongma build and served as
private authenticated Platform assets. None replaces `window.fetch` or
`window.EventSource`.

### One visual component system

- Workspace navigation, fields, selects, toggles, action buttons, and focused
  dialogs reuse BaiLongma `settings-*` components.
- The old `.bw-dialog`, `.bw-form`, and `.bairui-card-dialog` systems are gone.
- BaiRui overlay CSS contains no `!important` and no unscoped selector.
- Workspace and dialog dimensions compensate for BaiLongma's native browser
  zoom, so they remain inside the visual viewport.
- Closing the workspace restores focus to the control that opened it.

## Verification

Executed from the U01-04 worktree after deleting and rebuilding the BaiLongma
artifact:

```text
node scripts/build-bailongma-ui.mjs
  PASS - built BaiLongma 2.1.515 from the pinned commit

node --test "tests/*.test.mjs"
  PASS - 142 tests, 138 passed, 4 environment-dependent skips, 0 failed

node scripts/check-platform.mjs
  PASS - Platform check passed

node tests/browser/remote-acceptance.mjs
  PASS - wide 1920x1080, desktop 1440x1000,
         tablet 1024x768, mobile 390x844

node --check <all changed JavaScript files>
  PASS

git diff --check
  PASS
```

Browser acceptance covers independent panels, the mobile drawer, the single
workspace host, all eleven registered views, native Hermes chat streaming,
approval, stop, Jobs editing, encrypted personal-connection handling,
administrator isolation, viewport bounds, focus restoration, horizontal
overflow, and uncaught browser errors.

Screenshots are generated under
`test-results/remote-browser-acceptance/`. They are test artifacts rather than
source assets.

## Remaining risk

- A future BaiLongma update can move source anchors. The build intentionally
  fails closed until the patch queue is reviewed against the new commit.
- The browser suite uses the authenticated Platform fixture. It proves the
  U01-04 Shell and BFF interactions, not a production Hermes deployment.
- Four full-suite tests remain skipped because they require external
  PostgreSQL or packaging environment support; no skipped test is counted as
  U01-04 evidence.
- U01-05 remains responsible for the complete native live-panel transport and
  backend-contract freeze. Gate U01 must remain unclaimed.
