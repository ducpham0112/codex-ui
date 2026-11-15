# Codex and Claude session management

Date: 2026-11-15
Status: Approved for implementation by user on 2026-11-15. See implementation plan and docs/claude-integration.md for validation limitations.

## Intent

The user has ChatGPT and Claude subscriptions. When one reaches its usage limit, they want to keep working on the same project with the other, using this app to manage both. Separate conversations are acceptable. Account management and quota visibility for Claude are required alongside session support.

The first release manages both agents. Context handoff is a later release, so changing agents initially means starting a separate conversation and supplying context manually.

## Goals and boundaries

- Create, list, reopen, message, and interrupt Codex and Claude sessions in the existing browser interface.
- Share the configured project registry and workspace files across both agents.
- Select an agent before selecting its model. Identify the agent everywhere a session is shown.
- Manage each agent's connection/account status in Settings.
- Show both agents' subscription usage when obtainable, and honest unavailable/stale states otherwise.
- Preserve existing Codex behavior and saved sessions.

Excluded from the first release: a merged cross-agent transcript, automatic switching, automatic context transfer, multiple accounts per agent, billing/plan changes, Claude scheduling, and comprehensive management of Claude plugins/MCP/hooks. Existing Codex schedules remain supported. No requirement for identical models, tools, permissions, or reasoning controls across agents.

Avoid silently using paid API billing, treating unknown quota as unused quota, replaying a submitted prompt after a disconnect, or presenting Codex sandbox controls as equivalent Claude guarantees.

## Existing architecture

The Node server's `AppServerSupervisor` owns a Codex app-server process. `BrowserHub` forwards an allowlisted set of Codex RPC methods, broadcasts Codex events and approval requests, and supports replay/snapshots. The Angular client, timeline, account controls, model picker, and quota widget consume these Codex-specific shapes. `/api/sessions/scan` discovers additional Codex threads. Shared browser messages currently have no agent routing field. Docker installs a pinned Codex CLI and persists its configuration separately from projects.

This is more than adding Claude to the current model list. A Codex model provider remains a Codex configuration concept; `agentId` identifies a distinct execution engine.

The working tree already contains unrelated changes, including quota and connection work. Implementation must preserve them and establish its baseline before editing overlapping files.

## Approaches

1. **Separate adapters behind a shared UI — selected direction.** Preserve the Codex protocol internally and add a Claude runtime adapter. Normalize the common session experience and expose capability-specific controls. More integration work than a terminal, but directly supports unified settings and usage.
2. **Embedded Claude terminal.** Retains native Claude interaction, but produces two different chat experiences and weak integration with session listing, approvals, and quota. Useful only as a fallback if structured transport is infeasible; not an automatic scope substitution.
3. **Single cross-agent conversation.** Requires translating tool history and context and resolving conflicting execution semantics. Deferred because separate sessions meet the initial requirement.

The user requested this spec following the adapter recommendation. Approval of this draft confirms the detailed design and builder decisions below.

## User experience

### Starting and finding sessions

```text
New session
Project    my-app
Agent      Codex | Claude
Model      [models for selected agent]
           [agent-specific options]
           Create session

Sessions   All agents | Codex | Claude
[Codex]    Account settings         12:40
[Claude]   Fix account validation   12:15
```

Default new sessions to Codex for existing users; remember an explicitly selected agent for subsequent new sessions. Keep model defaults separately per agent. Changing the agent clears incompatible model/options but preserves the unsent prompt. An existing session's agent is immutable. Cross-agent selection creates a new session; it never sends that session's transcript automatically.

Search, project grouping, archive filters, and pagination remain available. Each list entry and chat header includes the agent label. A missing Claude installation or sign-in explains how to enable it; Codex remains usable. One agent failing must not disable the other.

Only show controls supported by the selected agent. Retain Codex model/provider continuation behavior. Hide unsupported Claude images, steering, effort, archive, or other actions until the runtime capability is verified; text chat, history, interrupt, and permission decisions are release requirements.

### Settings

```text
Accounts and agents
Codex    Ready · account details when available
         Connection / account actions / usage
Claude   Ready · Subscription · account details when available
         Check status / Sign in or Reconnect / Sign out / usage

Session defaults
Default agent
Codex defaults ...
Claude defaults ...
```

Distinguish browser/server connectivity, CLI availability, authentication, and ability to run a turn. Include each CLI version in About and separate redacted diagnostics. Account fields are optional and originate from the official runtime, never inferred from credential files.

Sign-in must complete through each vendor's official mechanism. For Claude, delegate to the unmodified CLI; do not build a Claude OAuth client or read/export subscription tokens. A successful probe of remote/headless login is required before promising browser-assisted sign-in. The required fallback is explicit host/container CLI login instructions in Settings, followed by Check status. Show sign-out only through the supported CLI command, warn that it affects sessions sharing that configuration, and require no active app-managed Claude turn before proceeding. Do not kill another agent's work.

### Quota

Keep the compact header trigger and expand its panel to contain distinct Codex and Claude sections. Settings exposes the same underlying usage snapshots. Show each available window independently: remaining percentage, reset time/countdown, optional scope/model label, source, and last successful update.

Represent `available`, `unavailable`, `stale`, and `error` distinctly. An exhausted window shows zero; absent data shows an em dash and explanation. Failed refresh keeps the previous snapshot marked stale. Refresh on account change, manual request, applicable runtime events, and throttled refresh while the panel is visible; do not run inference merely to retrieve usage. Clear cached snapshots on sign-out/account change.

Claude subscription quota is a feasibility gate, not an assumed API. First investigate officially exposed CLI data/events. Never query undocumented OAuth usage endpoints with extracted credentials. If supported programmatic data is unavailable, the release shows account status, known limit/reset information from runtime events when provided, and an Open Claude usage link (`https://claude.ai/settings/usage`). Label a rate-limit event as an observed limit, not a calculated account-wide remaining percentage. Tokens/cost for a conversation are not subscription allowance and must not be converted to a percentage.

The user must approve this explicit quota fallback with the rest of the design. Exact numeric Claude quota is not a first-release acceptance requirement without a supported source.

## Backend architecture

Introduce an agent registry with stable identifiers `codex` and `claude`. Each adapter exposes availability, capabilities, model options, account status/actions, usage, session operations, and runtime events. Keep provider-native payloads inside adapters except for explicitly tagged diagnostic/extension data.

Use a discriminated common contract for:

- Session reference `{ agentId, nativeSessionId }`, project/root, title, timestamps, model, and normalized status.
- Turns/messages/tool activity and permission requests, with agent-scoped native IDs.
- Account status and auth method; usage snapshots with optional windows/reset/source.
- Capability flags and structured unsupported-operation errors.

Session keys, routes, browser persistence, drafts, notification links, pending approvals, and replay deduplication must include both agent and native ID. Treat legacy untagged references as Codex and migrate caches without deleting history. Do not confuse identical native IDs across agents.

Add agent-aware browser requests/events/snapshots while retaining the legacy Codex RPC route during migration. Requests missing an agent field remain Codex; new Claude operations use the common contract and explicit allowlists. Normalize Codex events incrementally rather than rewriting the generated Codex protocol. Separate transport connectivity from per-agent runtime health. Snapshot/replay includes both agents and pending approvals; it never resubmits a turn.

### Claude runtime

Prefer the official CLI structured streaming interface, pinned to a tested version. Resume by explicit session ID, never the most recent session in a directory. The CLI owns authentication, session storage, and native tool execution. The application owns a durable metadata/event index for app-created Claude sessions, titles, project mapping, and normalized history needed for browser reconnects. Store it in a separate writable application-data volume, not inside a project or Codex configuration.

Before implementation of the full adapter, verify on the chosen CLI version: subscription authentication, streaming text/tool results, session IDs and resume, interrupt behavior, approval request/response transport, history recovery, auth status/logout, and usage availability. Document exact supported flags and sample event schemas. Do not assume Codex's RPC protocol exists in Claude or use an SDK authentication path that requires API billing for this subscription workflow.

If structured interactive approvals cannot be implemented through a supported transport, report that blocker and revise the design before proceeding. Never solve it by skipping permissions or silently replacing the requested UI with a terminal.

First release must list and reopen Claude sessions created through this app across restarts. Discovering all sessions created by external Claude clients is deferred unless the pinned CLI provides a supported discovery/history interface. The existing scan action must disclose its agent coverage. Sessions detected as externally controlled are read-only until ownership is safely available.

Allow at most one active writer per native session. Browser disconnect does not interrupt a server-owned turn. Persist events before broadcasting; server restart reconciles native history where supported, marks an interrupted/unknown run explicitly otherwise, and requires a deliberate next user action. Do not automatically restart inference. Bound concurrency and child-process resources, and terminate only owned processes during cancellation/shutdown.

## Permissions and workspace behavior

Both adapters validate project paths against the existing registry/root boundary before starting/resuming work. Keep native permission descriptions visible and route decisions by agent, session, process generation, and request ID. Expired approvals cannot affect a new process. On lost approval transport, pause/fail closed rather than grant permission.

Claude options use explicit native mappings verified by the feasibility work. Unsupported safe/sandbox modes must be shown as unsupported; do not inherit Codex's `safe`, `normal`, or `unrestricted` labels without equivalent semantics. Preserve existing Codex defaults. Project hook/config execution at startup must be considered when mapping Claude trust/permission modes.

Both agents can edit the same filesystem. Show a warning if another app-managed session has an active turn in the same project and block a second writer until it finishes in the first release. This app-level guard does not lock external CLI processes or constitute a filesystem sandbox. No automatic commits, resets, stashes, or branches on agent selection.

## Deployment and credential handling

Keep the single-user/self-hosted deployment model and existing authenticated reverse-proxy requirement. Add a pinned, unmodified Claude Code installation and report its version. Persist Claude's official configuration using `CLAUDE_CONFIG_DIR` in a separate volume; verify all required official state is retained on Linux containers and document host/keychain differences. Add an application-data volume for Claude metadata/events. Keep existing Codex volume paths compatible.

Missing optional Claude configuration must not prevent Codex startup/readiness. Agent health appears separately. Preserve non-root operation and host UID/GID compatibility.

Pass process arguments without shell interpolation. Do not expose credential files/tokens in APIs, logs, browser caches, or metadata. Delegate credential refresh/storage to the vendor CLI. Report the detected authentication method and make API-key billing conspicuous if the host is configured that way; never automatically fall back to API billing or modify the user's external account spending settings.

## Delivery and validation

1. **Feasibility and fixtures:** prove Claude subscription execution, approvals, resume/history, container authentication persistence, and usage capabilities. Resolve blockers before product integration.
2. **Contracts and compatibility:** agent registry, scoped identities, capabilities, isolated health, cache migration, and preserved Codex RPC behavior.
3. **Claude sessions:** durable app-session index/history, lifecycle, messages/tools, approvals, cancellation, and reconnect behavior.
4. **UI/settings/quota:** agent/model selection, mixed lists, per-agent defaults/accounts, both usage sections and explicit fallbacks, deployment documentation.

Verification should use adapter fixtures and focused integration tests for ID collisions, wrong-agent routing, pending/stale approvals, duplicate sends, reconnect/restart, invalid project paths, limit events, sign-out/account changes, failed usage refresh, and absent Claude installation. Run existing Codex tests and applicable workspace type/build checks. Manually smoke-test an authenticated Claude session in the target Docker environment without printing credentials; account login is performed by the user through the official flow.

Acceptance requires: existing Codex workflows still work; app-created Claude text sessions survive restart and resume; tools require the chosen native permissions; cancellation works; mixed sessions and drafts remain isolated; Settings accurately reports both agents; quota never invents numbers; and a Claude failure leaves Codex available. Exact model choices and CLI version are determined by verified runtime support, not hard-coded guesses in this spec.

## Later handoff

Reserve an optional source-session reference for future Continue with Claude/Codex actions. That release will create a distinct session with a reviewable context draft assembled from persisted history and repository state, without requiring another successful call to an exhausted source agent. It is not implemented in this release.

## Builder decisions and remaining gates

Builder decisions proposed here: keep Codex as the migration default; use a common session contract with incremental Codex migration; require only app-created Claude history initially; retain Codex-only scheduling; guard simultaneous app-managed writers in one project; allow official CLI login instructions and unavailable quota as explicit fallbacks.

No additional product decisions are required before planning once this draft is approved. Technical gates remain structured approvals, subscription-compatible CLI transport, durable resume/history, container login persistence, and supported usage data. A failed gate changes the plan and must be reported rather than hidden with a weaker behavior.

## Sources

Official documentation reviewed 2026-11-15; implementation must verify behavior against the pinned installed version:

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): login/status/logout, resume, CLI flags.
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless): structured output/streaming and continuation; bare mode has different authentication behavior.
- [Claude authentication](https://code.claude.com/docs/en/authentication): official login and configuration directories.
- [Claude legal and credential guidance](https://code.claude.com/docs/en/legal-and-compliance): unmodified hosted CLI and vendor-owned subscription sign-in boundaries.
- [Claude subscription usage](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan): subscription usage and authentication/billing distinctions.
