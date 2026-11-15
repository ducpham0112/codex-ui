# Connection diagnostics

The browser records connection attempts, handshake duration, close code and clean flag, retry delay, heartbeat timeouts, online/offline and visibility changes, and gateway auth probe results. Entries include UTC timestamps, browser network state and page visibility.

The latest 150 entries survive reload in localStorage under `codex.connectionLog`. Inspect them in DevTools Console:

```js
JSON.parse(localStorage.getItem('codex.connectionLog') || '[]')
```

Console entries use the `[codex-connection]` prefix. Storage failures do not affect reconnection. Close reason strings, request headers, URLs, chat payloads, cookies and tokens are not recorded.

Server `[websocket]` entries include upgrade acceptance/rejection (path/origin match flags), generated connection IDs, validated Cloudflare Ray IDs when present, connection durations, close codes, transport errors, app-server status and shutdown. Local launchd stdout goes to `.local/server.log`; stderr remains in `.local/server.error.log`.

Requests rejected by Cloudflare before reaching the origin will have no server upgrade entry. Compare browser timestamps with Cloudflare Access logs. Heartbeats are intentionally not logged every 25 seconds to avoid idle log noise.

Deploy the rebuilt backend and reload the browser to activate both sides. This instrumentation does not change Access policies or fix CONNECTING handshake timeouts.
