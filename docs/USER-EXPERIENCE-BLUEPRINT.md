# BaiRui User Experience Blueprint

This is the source-of-truth UX blueprint for the single user-facing shell.
The shell is the BaiLongma Brain UI built from the pinned upstream commit and
adapted through explicit BaiRui build transforms. It is not a second custom
dashboard.

## Source baseline

- Upstream: `xiaoyuanda666-ship-it/BaiLongma`
- Commit: `34d939eabe226c561550079cb810090015b49817`
- Version: `2.1.515`
- Reference artifact: `test-results/bailongma-design-baseline`
- Capture viewports: desktop `1440x1000`, wide `1920x1080`, tablet `1024x768`,
  mobile `390x844`

GitHub CI captures the unmodified upstream Brain UI from the read-only
submodule. The screenshots are evidence of the source experience, not a
replacement for interaction tests.

## Spatial model

```text
full-screen semantic graph (#graph)
  + left context panel (#panel-l1)
  + right context panel (#panel-l2)
  + native panel tabs / console / secondary panel
  + central chat surface (#chat-area)
      - chat history (#chat-history)
      - messages (#chat-messages)
      - composer (#msg-input, #send-btn)
  + transient native overlays and dialogs
```

The graph remains the visual field. The panels are context, not permanent
administrative navigation. The chat composer is the primary action surface.
On narrow viewports the panels become bounded drawers and the central surface
must remain usable without horizontal scrolling.

## Interaction inventory

| Area | Upstream behavior to preserve | BaiRui responsibility |
| --- | --- | --- |
| Graph | semantic nodes, links, zoom and focus | map projected Agent memory and Scene state; never expose another owner's data |
| Left panel | identity, stats, activity and context | map Agent-scoped profile, sessions and memory views |
| Right panel | stream, actions and current context | map tools, artifacts, approvals and current run state |
| Native panel controls | independent panel tabs and console | keep native collapse/drawer behavior; inject only stable host commands |
| Chat | history, composer, streaming response and attachments | route through Platform BFF -> Runtime Boundary -> Hermes native SSE |
| Theme | upstream token system and theme switching | apply BaiRui brand/icon as an explicit overlay, not a replacement component library |
| Mobile | drawer/scrim interaction and bounded dialogs | test at `390x844` and preserve touch targets and focus recovery |

## Capability mapping

| User capability | BaiLongma surface to reuse | BaiRui connection | Presentation rule |
| --- | --- | --- | --- |
| Initialization | native scene shell plus a focused onboarding dialog | Platform initialization BFF -> provision command -> Hermes setup | progressive steps; never put raw secrets in the graph |
| Chat | `#chat-area`, `#chat-history`, `#chat-messages`, `#msg-input`, `#send-btn` | Agent-scoped session BFF -> Runtime stream -> Hermes SSE | the center remains the primary work surface |
| Memory | `#graph`, node/link focus and context panel | PostgreSQL Obsidian notes -> memory projection -> Scene view | graph first; Markdown is an auxiliary inspector |
| Skills and tools | native activity/console panel and right context surface | Hermes discovery/management operations through Platform BFF | show capability and state, not configuration keys |
| Cron and background work | right context surface and workspace drawer | Agent-scoped jobs BFF -> Hermes Jobs operations | present as timelines and actions, not a database table |
| Channels | context workspace and connection status surface | Channel Bridge inventory, pairing, delivery and receipt | show connection proof and recovery state |
| Character cards | focused import/preview dialog using the existing Tavern adapter | Platform preview/import -> Agent identity and notes | untrusted prompts require explicit confirmation |
| Settings | management workspace / Drawer | Platform settings, Hermes management allowlist and encrypted references | advanced terms are progressive disclosure |

## User vocabulary

| Technical object | Default user wording | Advanced diagnostic wording |
| --- | --- | --- |
| Agent | My Agent | Agent |
| Runtime | Running engine | Runtime Boundary / Runtime |
| Provider | Model service | Provider |
| Authorization | Personal connection | Authorization reference |
| Run | Task execution | Run |
| Skill | Capability | Skill |
| Artifact | Result or file | Artifact |
| Scene | Current workspace view | Scene snapshot / patch |
| Control Plane | Admin operations center | Bairui Control Plane |

The default user shell does not expose database table names, raw operation IDs,
server paths, keys or control-plane commands. Those names remain available in
diagnostics and administrator tooling where they are needed for evidence.

## Three experience levels

1. **Core scene**: graph, active Agent, current conversation, current run and
   result remain visible together.
2. **Context sidebars**: sessions, memory, identity, tools, artifacts and
   approvals follow the current Agent and can be collapsed independently.
3. **Management workspace**: initialization, Provider/model, Skills, MCP,
   channels, Cron, character cards and advanced settings open only on explicit
   user action. They are not permanent database-like navigation.

## Adapter rules

- `packages/bailongma-ui/build.mjs` owns staging, source copying, explicit
  transforms and integrity manifest generation.
- `bairui-bailongma.js` and `bairui-workspace.js` are host adapters while the
  corresponding behavior is being moved into the native `data-bairui-extension-host`
  slot; they must not replace global `window.fetch` or `EventSource` or append a
  second root page directly to `document.body`.
- Workspace views are registered through `BairuiWorkspaceRegistry`; a new view
  must provide an Agent-scoped renderer and an explicit navigation order. The
  registry is the migration boundary for moving built-in views out of the host
  adapter one at a time.
- The `memory` view is the first migrated module: it owns no storage or
  projection logic, and calls only the Agent-scoped `/memory-notes` and
  `/memory-sync` bridge commands while showing real Obsidian/Hermes states.
- UI code emits Scene intents and host commands. It never calls Hermes,
  PostgreSQL, a Provider or an external service directly.
- A panel without a real snapshot, command, event, persistence, revision,
  recovery and ownership contract is shown as unavailable, not as fake ready.

## Visual acceptance

Every UI task must compare the modified product with the source screenshot set
and run the remote browser acceptance at desktop, wide, tablet and mobile
viewports. Review density, spacing, motion, focus, drawer behavior, empty and
error states, and the continuity of the central chat scene. A green screenshot
capture does not prove the backend loop; the U00-03 vertical-slice evidence is
required for that.
