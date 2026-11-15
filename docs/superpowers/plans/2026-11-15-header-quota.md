# Header Quota Implementation Plan

> Implement inline using executing-plans, following the approved scope.

**Goal:** Show live quota in a compact header popover.

**Architecture:** A standalone Angular component uses ConnectionService and pure quota presentation helpers; the backend already permits the read RPC.

**Tech Stack:** Angular signals, native popover, TypeScript, Vitest.

**Spec:** ../specs/2026-11-15-header-quota-design.md

## Global Constraints

No billing mutations or new dependencies. Preserve unrelated working changes. Mobile trigger remains compact.

## Review Focus

Sparse notifications preserve known windows and metadata. Missing quota never becomes 100% remaining. Multiple buckets remain visible. Reconnection refreshes and disconnect marks stale. Failed refresh preserves last known data.

## Task 1: Quota display and live header component

- [x] Add behavioral tests for missing windows, multiple buckets and clamping; run them and observe failure.
- [x] Create quota.ts presentation helpers and quota.component.ts/html/css with connection fetch, live notifications, stale/error/loading display and refresh.
- [x] Import and mount the component in the root header.
- [x] Run the full test suite, type/build checks, and inspect the final diff.

## Verification

161 tests pass with TMPDIR=/private/tmp (macOS canonical path avoids unrelated project registry path mismatches). Production Angular build and CSP verification pass outside the sandbox; the sandbox build aborted. Headless Chrome checks with simulated RPC data pass at 390px and 1280px: both quota windows, credits, sparse-notification refetch, and Escape dismissal. Screenshots inspected. Review found no concrete correctness issues.
