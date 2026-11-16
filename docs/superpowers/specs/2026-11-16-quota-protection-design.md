# Remote quota protection

Protect quota for other work. Default reserve is 30% of the Codex 5-hour window, configurable in Settings. Stop only turns initiated through this server (web and its schedules), never externally initiated CLI turns. Automatically continue interrupted work in the same thread once a fresh quota snapshot reports remaining allowance above the reserve. Manual Stop cancels automatic continuation.

## Approach

Use a backend guard shared by browser RPC and scheduler, listening to quota/turn notifications and polling every 30 seconds. Browser-only enforcement cannot protect work with the browser closed. A global app-server stop would affect unrelated CLI work and is excluded.

Persist settings and paused work on the server. Record exact owned turn IDs, wait for interruption completion before continuing, and preserve turn options while supplying a continuation instruction. Never resume based on missing, expired, or failed quota reads. Show protection status, paused sessions, errors and a configurable integer reserve (1–99%) in Settings. Polling and upstream reporting mean the reserve is best effort, not an exact spending cap.
