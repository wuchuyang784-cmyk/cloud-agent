# F1 Pi Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Existing feature checkout and Grafana changes are preserved; do not commit or push without user request.

**Goal:** 固定上游源码镜像与受认证、有界、持久会话、可取消的独立 pi wrapper，通过真实 pi 离线模型协议验收。

**Architecture:** F1 新入口不接入 app/dev/E2 probe。镜像从固定 git archive 构建；wrapper 只接收绑定运行身份的受签名任务，固定网关模型配置并持久化会话/任务占位。旧 adapter 保留仅供 legacy 回归。

**Tech Stack:** Node 24、原生 node:test/HTTP/crypto/fs、固定 pi 0.85.1 源码、Docker 独立临时验收。

## Task 1：Wrapper 内部协议与进程管理

Files: `apps/platform-api/src/runtime/pi/production/{config,envelope,rpc,service,index}.mjs`; `apps/platform-api/test/pi-production*.test.mjs`; bounded fake RPC fixture under `test/helpers/`.

- [x] 先写测试：`assert.equal(unsigned.status, 401)`；错误 runGeneration 与路径签名拒绝；`assert.equal(ready.status, 503)` 在 get_state 未确认时；任务重复与忙时返回 409；无 usage 时 `assert.equal(completed.totalTokens, null)`。
- [x] Run `conda run -n cloud --no-capture-output node --test apps/platform-api/test/pi-production*.test.mjs` via explicit file paths; verify missing-feature assertion failures, not incidental fixture errors.
- [x] Implement explicit configuration loading (`readConfig(path)`), per-run request signing/verification, bounded RPC response matching, fixed persistent session startup and `createPiRuntimeService` HTTP adapter. Follow full spec above; keep one responsibility per file. Expose programmatic factory for integration tests, CLI reads only explicit config file.
- [x] Add cancellation, process failure, output budget, newline preservation, repeated prompt context and durable request occupancy tests. Preserve unknown results and never retry prompt. Verify exact tests after each behavior.
- [x] Spec review then quality review. Fix findings with reproducing tests; no commit.

## Task 2：Fixed-source build pipeline

Files: `scripts/pi-runtime-build{,-config}.mjs`, `scripts/pi-runtime-build.test.mjs`, `apps/platform-api/docker/pi/production/Dockerfile` and narrowly scoped dockerignore, `package.json` new isolated scripts.

- [x] Test `validatePiSource` rejects changed gitlink, dirty/changed upstream, version/lock mismatch; assert builder excludes business `.env` and uses committed archive; reject mutable base reference.
- [x] Run `conda run -n cloud --no-capture-output node --test scripts/pi-runtime-build.test.mjs`; see expected absent-feature failures.
- [x] Implement fixed source manifest, base digest and reviewed explicit build steps using `npm ci --ignore-scripts`; Docker source bundle output runs production index as UID 1000 without Provider env. Export artifact/provenance JSON to ignored F1 output.
- [x] Run build command and inspect actual image labels/user/entrypoint. Do not replace any existing image or run a business container. Validate source commit/lock/source clean before and after build.

## Task 3：Real pi isolated acceptance

Files: `scripts/test-pi-runtime-live.mjs`, `scripts/pi-runtime-provider-fixture.mjs`, `scripts/pi-runtime-fixture.test.mjs`.

- [x] Use local fixed protocol model fixture with no real API key, generated temporary run secret/token, random owner label and independent network/volumes. Only wrapper and fixture containers; no business DB use.
- [x] Assertions: true get_state readiness; signed NDJSON prompt; actual pi tool events and file result via read-only Docker exec; second prompt includes first conversation; wrapper restart retains context; fixture usage totals exact; cancel no false success; invalid signature/identity and direct unapproved RPC denied.
- [x] Run `conda run -n cloud --no-capture-output npm run test:pi:live`; require all assertions and exact owner cleanup before report success. Save evidence under ignored `output/pi-runtime/`.

Implementation notes: upstream missing ignored model JSON resolved through a separately SHA-512-pinned same-version data-only release, preserving `check:model-data`; immutable executable source pin unchanged. Workspace context-file poison test failed against the prior image as expected, then passed with discovery disabled. Full-suite auto-discovery exposed a fixture stdin hang; an explicit fixture-only execution guard fixed it without skipping tests. Review findings remediated with regression tests. Windows paused-client observer caused real atomic rename EPERM; metadata-first observation fixes the test interference with unchanged production/task/cancel/deadline limits (30 stressed probes passed). No branch integration/deployment authorized.

## Task 4：Review, regression and handoff

Files: `docs/50-f1-pi-runtime.md`, append current F1 boundary to `AGENTS.md` and update this plan.

- [x] Run F1 unit/build/integration, original pi tests and platform guard tests. Run backend full `npm test --prefix apps/platform-api`; report skips accurately.
- [x] Final independent spec then quality review using actual uncommitted file paths; fix all important findings and rerun affected acceptance.
- [x] Check `git diff --check`, source pin/worktree, original runtime/service IDs and private hashes; preserve previous Grafana modifications. Document fresh evidence and F2 next step; no deployment/commit/push.

Final independent verification: root `test:pi` 48/48, legacy pi/platform guard 6/6, normal backend 335 total / 326 passed / 9 skipped / 0 failed. Actual source image build `a9fbc2fa0e66252fcb35`, live report `output/pi-runtime/acceptance/2026-10-11T15-01-34-473Z.json` all 16 checks true. Production hashes still match the accepted image after test-only Windows observer changes; final spec/quality reviews have no unresolved important finding. Source pin, five preserved CA/private configuration hashes and exact temporary resource cleanup verified. Work remains uncommitted on the existing checkout.
