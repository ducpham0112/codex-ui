# Claude sessions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Manage Claude Code subscription sessions, account state, and usage alongside Codex.
**Architecture:** Preserve the existing Codex RPC path. Add a Claude runtime with a bounded same-origin HTTP API and durable session snapshots, consumed by a capability-specific Angular view inside the existing shell. Poll snapshots without replaying inference. Agent identity remains explicit in every new operation.
**Tech Stack:** Node/TypeScript, child_process streaming JSON, Angular, Vitest.
**Spec:** docs/superpowers/specs/2026-11-15-multi-agent-sessions-design.md

## Global Constraints

- Separate conversations; no automatic handoff, switching, or paid API fallback.
- Official CLI owns credentials. No token extraction or custom OAuth flow.
- Missing Claude must leave Codex operational. Preserve unrelated dirty changes.
- Native permissions stay enabled. Unsupported control requests fail closed.
- Legacy untagged browser sessions remain Codex. Claude session identities are scoped.
- Numeric quota uses supported data only; otherwise expose unavailable and official usage link.
- User approved implementation and requested no intermediate questions; choose reasonable defaults and summarize assumptions at the end.

## Review Focus

- Duplicate HTTP requests must not duplicate submitted turns (idempotent request IDs).
- A stale approval must not reach another turn/process.
- Symlinked or removed projects must not escape the configured project scope.
- Login/sign-out and usage failures must not expose credentials or erase conversation history.
- Server/browser restart must never automatically restart inference.

### Task 1: Claude runtime, persistence, and API

**Files:** Create `apps/server/src/agents/claude.ts`, `apps/server/src/http/agents-api.ts`, `apps/server/test/claude.test.ts`, fixture CLI, and shared types in `packages/shared/src/agents.ts`.
**Interfaces:** `ClaudeAgent` handles app-created sessions with durable snapshots; `handleAgentsApi(request,response,agent,projects,publicOrigin)` owns `/api/agents/claude/*` routes. Export shared `ClaudeAccount`, `ClaudeSession`, `ClaudeSnapshot`, `ClaudeItem`, `ClaudeApproval` types. Snapshot: `{account,sessions,usage}`; session full details via GET `/sessions/:id`. GET `/status`, GET `/sessions`, POST `/sessions` `{projectId,model?}`, POST `/sessions/:id/turn` `{prompt,requestId}`, POST `/sessions/:id/interrupt`, POST `/sessions/:id/approvals/:requestKey` `{allow:boolean}`, POST `/logout`. Models: CLI default, sonnet, opus, haiku aliases, no hard-coded model versions. Account status probes CLI version/auth status only; login through official host instructions. Usage unavailable by default, runtime limit events separately observed.

- [x] Write failing tests using a real fixture child process for streaming, approvals, deny/allow, resume, persistence, idempotency, cancellation, malformed frames, missing CLI, wrong project, stale approvals, account redaction, and restart marking active sessions interrupted.
- [x] Run targeted Vitest and observe expected failures.
- [x] Implement bounded stream-json CLI transport based on Anthropic's official SDK wire shapes, default native permissions and stdio approval responses; no SDK login substitution. Keep stdin open; initialize before prompt. Persist messages/tools/approvals and statuses before publishing snapshots. On result close owned child; resume explicitly on the next turn. Default config reads user/project sources as CLI ordinarily does; document trust implications.
- [x] Implement bounded API and origin checks; validate registered canonical project root on create and every turn; refuse account mutations during active work; one active Claude session per project. Expose active-project callback hooks for cross-agent writer guard in integration task.
- [x] Run targeted tests and server typecheck, commit only owned files if permission allows; otherwise leave changes and report.

### Task 2: Shared shell and Claude UI

**Files:** Create `apps/web/src/app/claude.service.ts`, `claude-chat.component.*`, `agent-settings.component.*`, focused tests; modify existing `app.component.ts/html` and quota files incrementally.
**Interfaces:** Consume Task 1 shared DTOs and HTTP routes. Service owns status/session refresh, selected Claude ID, drafts under scoped localStorage keys, action errors, bounded polling only while visible; never resubmit turns automatically. Existing Codex timeline/persistence remains untouched. Shared session selector merges Claude summaries tagged with `agentId:'claude'`, scoped UI `id:'claude:'+nativeId`; chooses appropriate chat body. New-session dialog has Agent then agent-specific models. Quota panel adds Claude usage; Settings adds account controls and per-agent defaults.

- [x] Add failing tests for mixed identity/filtering, drafts, account/usage fallbacks, and turn retry IDs; run them RED.
- [x] Implement service/components and shell integration; keep Codex labels/defaults and legacy links working. Avoid blocking Claude on Codex runtime/auth errors. Explain unsupported Claude controls; no images/steering/effort unless verified. Display pending tool input and one-time allow/deny with stale response error handling. Official CLI login instructions, status refresh and logout in Settings; no pasted tokens.
- [x] Run web tests and development build, fix integration issues and commit owned changes.

### Task 3: Runtime integration, deployment, and final verification

**Files:** Modify `apps/server/src/main.ts`, `apps/server/src/websocket/hub.ts` as needed for cross-agent guard, Dockerfile, compose.yml, .env.example, README; add integration tests and feasibility report.
**Interfaces:** Instantiate optional Claude agent using `CLAUDE_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, `APP_DATA_DIR`; mount durable metadata and vendor config separately. Route API before static fallback. Health separates transport from runtime; don't exit server when Codex fails. Guard active writers by canonical project root across Codex hub and Claude adapter, preserve scheduler semantics and disclose external-process boundary.

- [x] Write failing integration tests for absent Codex/Claude independence, cross-agent writer guard and legacy route behavior; observe RED.
- [x] Wire lifecycle, startup, shutdown, same-origin API, redacted diagnostics, pinned Claude CLI 2.1.325 and persistent volumes; maintain UID/GID support. Document no exact numeric quota source and CLI login fallback.
- [x] Run `TMPDIR=/private/tmp corepack pnpm test`, `corepack pnpm check`, `corepack pnpm build`, fake smoke and applicable browser checks. Real subscription invocation requires existing authenticated CLI; do not create credentials or consume user inference without needed validation context. Record any unavailable live/container verification explicitly.
- [x] Request independent review against spec and diff; fix important findings with regression tests, repeat full verification and leave feature branch for user review without merge/push.

## Execution ledger

- Branch: `feat/claude-sessions`.
- Baseline test run found four pre-existing macOS temporary-path canonicalization failures in project-registry tests. Retry with canonical `TMPDIR=/private/tmp` before attributing failures to this feature.
- Ruling: work in the requested new branch in-place, preserving the current dirty tree; no extra worktree or questions, per user's instruction.
- Live Claude CLI initially absent; install pinned probe only under `/tmp` and do not sign in on user's behalf.

## Final validation

Implementation and scoped review fixes completed. Fresh Node 22.23.5 checks: 124 web tests, 89 server tests, workspace check, production build/CSP and fake Codex smoke pass. Claude browser contract passed four device configurations before the user deferred further UI testing. Broad desktop E2E retains 10 failure families reproduced against pre-feature HEAD; see `docs/claude-feature-validation.md`. Real authenticated Claude inference and Docker runtime smoke remain unverified.
