# BaiLongma Live Panel Matrix

This is the reviewed U01-05 inventory for BaiLongma `2.1.515` at commit
`34d939eabe226c561550079cb810090015b49817`. The machine source is
`BAILONGMA-LIVE-PANEL-MATRIX.json`.

The matrix inventories native UI transport; it does not authorize BaiLongma's
backend Agent core. BaiRui keeps the Brain UI and maps supported actions through
typed, Agent-scoped ports. A panel without a complete backend loop is visibly
unavailable.

The executable P0 contract is `bairui.panel-manifest.v1`, implemented by
`packages/bailongma-ui/panel-contracts.mjs` and exposed only through
`/api/user/agents/:agent_id/ui/panels`. It records the dynamic
`available`, `needs_configuration`, `temporarily_unavailable` or `unsupported`
state for snapshot, command and event transports. The static matrix and live
manifest are checked together by `tests/u01-05-panel-contract-golden.test.mjs`.

## Treatment

- `native-equivalent`: preserve the upstream component and behavior directly.
- `bairui-equivalent`: preserve the experience while replacing the backend with
  BaiRui contracts, Runtime Boundary, adapters and PostgreSQL ownership.
- `unsupported`: retain an explicit unavailable state; never return fixture or
  empty `ok` data in production.

## Panel Matrix

| Panel | Priority | Native transport | Five-layer owner | Truth source | Treatment / state | Remaining gate |
| --- | --- | --- | --- | --- | --- | --- |
| `shell-layout` | P0 | browser-local tabs, collapse and drawers | UI exposure | pinned BaiLongma source/build manifest | native-equivalent / implemented | visual regression remains part of Gate U01 |
| `memory-graph` | P0 | `/agent-profile`, `/memories`, `/audit/stats`, `/events` | Runtime + storage + channel + UI | PostgreSQL Obsidian notes and Hermes projection | bairui-equivalent / partial | complete projection event support in a later gate |
| `chat` | P0 | `/conversations`, `/message`, `/events` | all five layers | Hermes execution plus PostgreSQL tenant metadata | bairui-equivalent / partial | complete approval, attachment and reconnect acceptance |
| `scene-shell` | P0 | WebSocket `/scene` upstream; Agent-scoped HTTP/SSE in BaiRui | Runtime projection + storage + channel + UI | BaiRui Agent-scoped Scene store | bairui-equivalent / implemented | production PostgreSQL and browser acceptance |
| `settings` | P0 | `/settings/*`, `/admin/restart`, `/map-service/config` | Runtime + integration + storage + channel + UI | Platform authority and Hermes management state | bairui-equivalent / needs_configuration | U02/U03 management and initialization gates |
| `voice-tts` | P1 | `/settings/voice`, `/settings/tts`, `/tts/*`, WS `/voice/cloud`, SSE `/events` | all five layers | Hermes capability plus governed STT/TTS adapters | bairui-equivalent / needs_configuration | U08 multimodal gate |
| `social-channels` | P0 | `/social/*`, `/settings/social` | Runtime + storage + channel + UI | durable Channel Bridge and vendor handshake | bairui-equivalent / dynamic | real binding and delivery evidence |
| `hotspots` | P0 | `/hotspots`, `/hotspot-state` | Runtime + integration + storage + channel + UI | normalized TrendRadar output | bairui-equivalent / implemented | production source acceptance |
| `docs` | P1 | `/docs*`, `/doc-panel-state`, voice/TTS settings | all five layers | BaiRui files/artifacts and MinerU adapter | bairui-equivalent / needs_configuration | U05/U08 file and parsing gates |
| `person-card` | P0 | external lookup, `/person-card*` | Runtime + integration + storage + channel + UI | validated BaiRui character-card adapter | bairui-equivalent / dynamic | profile revision/rollback acceptance |
| `map-environment` | deferred | `/map-service/config`, `/environment-panel`, `/_AMapService/*` | future integration adapter | none today | unsupported | no direct browser proxy credentials |
| `typhoon` | deferred | `/typhoons`, `/typhoon-state`, iframe messages | future integration adapter | none today | unsupported | approved weather product module required |
| `worldcup` | deferred | `/worldcup`, `/worldcup-state`, iframe messages | future integration adapter | none today | unsupported | approved sports product module required |
| `media-video` | P1 | `/media/history`, `/aivideo/*`, oEmbed, iframe messages | all five layers | async provider jobs and artifact service | bairui-equivalent / needs_configuration | U04/U08 artifact and provider gates |

## Transport Baseline

The machine matrix records every source file under `src/ui/brain-ui` and
`src/ui/scene-shell` containing `fetch`, `EventSource`, `new WebSocket` or
`postMessage`, together with the exact count by transport kind. GitHub CI scans
the pinned submodule and compares the result with that baseline. Any upstream
transport addition, deletion or source movement fails the check and requires a
reviewed matrix update.

The scan intentionally includes browser-local AudioWorklet and iframe messages.
Those calls are not automatically allowed host APIs: the matrix classifies them
as browser-local, typed BaiRui replacements, or unsupported.

## Boundary Rules

1. UI code calls only an Agent-scoped host adapter or Platform BFF.
2. Compatibility routes cannot forward arbitrary paths to Hermes or BaiLongma.
3. PostgreSQL owns tenant metadata, durable projections, revisions and outboxes.
4. Hermes owns Agent execution semantics; the control plane never reads chat,
   memory or task bodies.
5. Direct external fetches, wildcard iframe messaging, raw local paths and raw
   provider keys are unsupported until replaced by typed ports.
6. `implemented` in this matrix describes the panel slice only. Gate U01 remains
   pending until visual, interaction, deterministic build and complete live-loop
   acceptance all pass.
