# Claude session feature validation

Branch: `feat/claude-sessions`

Reviewed and rechecked: 2026-11-16

## Feature coverage

| Behavior | Verification |
| --- | --- |
| Codex/Claude selection, model defaults, mixed session identity and isolated drafts | Service and shell tests; existing Codex state remains separate |
| Create, stream, reopen and explicitly resume app-created Claude sessions | Real child-process CLI fixtures, persisted history and restart tests |
| Retry without submitting the same prompt twice | Durable request-ID tests, ambiguous HTTP response and browser-reload tests |
| Tool approval, denial, expiry and interruption | Native control-protocol fixtures; stale generation checks; process-exit writer ownership |
| Subscription account handling | Official CLI status probes; API/helper methods rejected before inference; account responses whitelist safe fields |
| Claude usage observations | Cached limit/reset events reach visible-session polling without extra CLI probes; account changes clear old observations |
| Safe persistence failure | Actual filesystem failures reproduce creation, pre-spawn, approval and terminal write errors; repair/retry executes once and preserves last saved history |
| Project writer isolation and recovery | Codex/Claude/scheduler guard tests; accepted versus pending start requests; local termination and proxy generation reconciliation |
| Independent availability | HTTP app and Claude status remain available when Codex cannot start |

Exact numeric Claude subscription allowance is **not implemented**: no supported programmatic source was established. The app shows an explicit unavailable state, observed runtime limits when supplied, and the official usage-page link. This is the approved design fallback.

## Latest automated checks

- Full unit/integration suite: **124 web + 89 server tests passed**.
- Workspace typecheck/development compile: passed.
- Production build and CSP verification: passed.
- Codex fake app-server smoke: passed.
- Independent whole-branch review found three material issues; all were fixed with regression tests and approved in the scoped re-review.

The latest checks use Node **22.23.5**. The host's default Node 20.10 is too old for the installed Angular CLI and current test dependencies. API tests require permission to bind loopback sockets; Angular's native build worker also aborts under the restricted sandbox, so those checks were run outside it. On this macOS host, canonical `TMPDIR=/private/tmp` avoids pre-existing `/var` versus `/private/var` assertions.

Earlier automated browser contract checks passed on desktop, iPhone, Android and tablet configurations. They exercise the real browser interface with mocked Claude HTTP responses; native CLI lifecycle is covered separately by server fixtures. Manual UI testing is left to the user as requested.

## Existing browser-test failures

The broad desktop suite is not green: **20 passed, 10 failed, 4 skipped** on the feature branch. An isolated build of pre-feature HEAD `0f46db3`, with the same test environment isolation, produced **19 passed, 10 failed, 4 skipped**; the extra passing feature-branch case is the Claude browser contract test.

Matching failure families are image attachment, table overflow assertion (the viewport variant varies), restoring scroll position, ambiguous ChatGPT model-option selector, desktop Enter expectations, following streaming growth, gateway re-entry, update banner and viewport zoom expectations. These existing tests were not rewritten to hide failures. The new project-setup flow passes after the fixture was updated to support the documented `thread/read` operation used by the writer guard.

## Remaining release checks and assumptions

- No authenticated Claude subscription was available for live inference, real upstream tool approvals or authenticated resume. Fixture results do not replace that smoke test.
- Linux-container login persistence and a complete Docker runtime smoke have not been verified. The Docker daemon was unavailable during the initial attempt.
- Sessions remain separate. Automatic handoff and merging conversations are deferred.
- Subscription execution requires the official CLI's regular `claude.ai` sign-in; API and helper billing are intentionally blocked. Setup-token-only authentication must use regular CLI login for this version.
- Only Claude sessions created through this app are indexed initially; external CLI discovery is deferred.
- The feature branch was created in the existing checkout to preserve the user's current work. Unrelated branding, update, icons and chat-presenter changes are excluded from the feature commit.
