# Web Update Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show update prompts only for downloaded web builds.
**Architecture:** VERSION_READY supplies build identity; API metadata supplies display information. Dismissal and notification deduplication use the build hash.
**Tech Stack:** Angular, RxJS, Vitest.
**Spec:** docs/superpowers/specs/2026-11-15-web-update-design.md

## Global Constraints

No automatic reload. Preserve unrelated workspace edits. Execute inline as requested by the user.

## Review Focus

API version mismatch without a downloaded build; same release version with a new hash; repeated ready events; dismissal after reload or storage failure; API failures while a build is ready.

### Task 1: Correct readiness and identity

**Files:** apps/web/src/app/update.service.ts and update.service.test.ts.
**Interfaces:** AppUpdater.versionUpdates includes latestVersion.hash for VERSION_READY. UpdateAvailable retains version and commit for existing UI consumers.

- [ ] Replace API-driven expectations with tests for readiness, hash identity, persistence, and notification behavior. Run the focused test and observe failures.
- [ ] Make worker readiness authoritative; keep API metadata independent; persist dismissal by build hash with a memory fallback.
- [ ] Run focused tests, workspace tests, and web build; inspect the final diff.
