# Idle connection recovery

The local service was READY with zero supervisor restarts, and a direct WebSocket handshake succeeded. The public endpoint requires Cloudflare Access. These checks do not establish which network hop caused the reported idle disconnect.

Reproduced client defect: an OPEN socket with no incoming traffic remains trusted indefinitely. Visibility recovery also trusts OPEN sockets, so waking a suspended tab can leave a dead connection in place. The hub sends no periodic traffic to keep idle proxies active.

The hub now broadcasts an unsequenced system.heartbeat every 25 seconds. The browser checks incoming traffic every 15 seconds, replacing sockets after more than 60 seconds of silence and immediately checking for stale sockets on foregrounding. Going online replaces the previous socket. Explicit reconnect detaches old handlers before closing and clears pending timers.

Regression coverage: silent sockets reconnect, idle sockets receiving heartbeats remain connected, and hub keepalives stop on close. Full suite: 164 tests pass using TMPDIR=/private/tmp for canonical macOS paths. Web production build, CSP verification, and server build pass.

This does not keep a sleeping Mac online or extend Cloudflare login sessions.
