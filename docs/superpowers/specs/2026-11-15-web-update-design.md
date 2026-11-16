# Web update notifications

Approved in conversation: only announce a web update once the service worker has downloaded it; remember dismissed builds; never reload automatically.

Use VERSION_READY and latestVersion.hash as the authority and identity. Keep /api/version for Settings and notification labels only. Comparing server versions cannot establish that a new web bundle is available, and slowing polling would only mask that problem. Persist dismissal by hash, with an in-memory fallback when storage fails. No worker means no update-ready notification.
