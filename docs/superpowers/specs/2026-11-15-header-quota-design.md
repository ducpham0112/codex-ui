# Header quota

Approved in conversation: a compact header quota indicator opens a popover with usage bars for each quota window, remaining percentages, reset times, credits when available, refresh, loading and error states. Mobile keeps the trigger compact. Fetch on connection and follow live quota notifications.

## Approach

Use a standalone Angular component beside the connection status, with component styles and the existing ConnectionService RPC transport. This keeps account display separate from the large root component. A separate usage page adds navigation beyond the requested scope; adding state directly to the root needlessly expands it.

## Constraints

Display server-reported quota only; token totals are not quota. Do not change billing, spend limits, or consume reset credits. Missing data means unavailable, never zero usage. Retain data during transient refresh failures with an explicit stale message. Disconnected data must be labeled stale. Use native popover behavior for keyboard dismissal and outside clicks.

## Follow-up UI revision

Show both primary and secondary Codex window percentages in the header, labeled by duration (for example 5h and 7d). Use separate cards with large remaining percentages in the popover. Show reset duration from now, refreshed every 15 seconds; retain the absolute date in a tooltip. Expired timestamps display Reset pending instead of implying the quota has refreshed.
