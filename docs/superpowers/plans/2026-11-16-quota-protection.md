# Quota Protection Implementation Plan

> **For agentic workers:** Use executing-plans to implement inline with test-first verification.

**Goal:** Preserve a configurable 5-hour quota reserve and automatically continue this app's paused work.
**Architecture:** Backend guard shared by hub and scheduler; persistent state and HTTP settings API; Angular status/settings UI.
**Tech Stack:** TypeScript, Node, Angular, Vitest.
**Spec:** docs/superpowers/specs/2026-11-16-quota-protection-design.md

## Global Constraints
- Default reserve 30%; only turns started through this server are eligible.
- Fresh quota above reserve permits automatic continuation; manual Stop cancels it.

## Review Focus
- External turns must remain untouched.
- Completion racing interruption must not restart completed work.
- Missing/stale quota must not trigger continuation.
- Restart must preserve settings and paused work.
- Failed interruption/continuation must remain visible and retry safely.

### Task 1: Backend guard
- [x] Write and run failing tests for threshold, scope, auto continuation, cancellation, unavailable quota and persistence.
- [x] Implement `QuotaProtection` in `apps/server/src/quota/protection.ts` with request interception, notification handling, polling and serialized state changes.
- [x] Run server tests and TypeScript check.

### Task 2: Integrate backend and settings UI
- [x] Add HTTP API tests for settings validation and status.
- [x] Integrate guard into hub and scheduler; add `/api/quota-protection` API.
- [x] Add Angular protection service and component for settings, paused status and cancellation.
- [x] Run full tests, checks and build; inspect final diff.

## Execution notes
Implement directly in the supplied workspace; no branch operations or commits requested. Keep modifications reviewable in the working tree.

## Verification
- Full suite: 186 passing tests (74 server, 112 web), using TMPDIR=/private/tmp to normalize macOS temporary paths.
- Server TypeScript build and Angular development build pass.
- Playwright settings save/reload passes at desktop and mobile widths using installed Chrome.
- Review fixes cover stale Stop state, pending starts with lost responses, concurrent starts and ambiguous interruption timeouts.
- Working tree remains on master; no commit, push or deployment performed.
