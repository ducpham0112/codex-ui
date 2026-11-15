# Claude Code integration and verification

## Runtime boundary

Codex keeps its existing app-server integration. Claude sessions run the official, unmodified Claude Code CLI. The UI does not exchange Claude credentials or call Anthropic inference APIs directly. Claude's native configuration, permissions, project instructions, and tool execution remain authoritative.

The application uses newline-delimited streaming JSON with stdin kept open for control responses. It initializes the connection, sends a user message, answers individual permission requests, and resumes subsequent turns by explicit session ID. It never uses permission bypass flags or `--bare` (which has different subscription authentication behavior).

Reference sources:

- [Official CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Official authentication documentation](https://code.claude.com/docs/en/authentication)
- [Official Python SDK transport implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)
- [Official Python SDK control protocol](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)

## Probe performed during implementation

On 2026-11-15, installed `@anthropic-ai/claude-code@2.1.325` into an isolated `/tmp` prefix with an empty `CLAUDE_CONFIG_DIR`. No user credentials were read or created and no inference prompt was submitted.

Observed:

- `claude --version` returned `2.1.325 (Claude Code)`.
- `claude auth status` returned JSON with `loggedIn: false` and `authMethod: none`, exiting 1 as documented.
- Starting the CLI with `--print --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default` accepted an `initialize` control request and returned `control_response` with success.
- Initialization exposed model descriptions, version, account metadata, and capabilities. These are CLI-owned values, not evidence of a paid plan or available subscription allowance.
- Official `auth status --json`, run in an isolated project with a synthetic `apiKeyHelper`, reported `api_key_helper` for both project and user settings. The adapter checks the effective project-context authentication before each new prompt and requires `claude.ai`; it refuses API/helper authentication.
- The official SDK source documents `can_use_tool` requests, `control_response` allow/deny responses and the interrupt control request used by the adapter.

## Explicit limitations

There was no authenticated Claude subscription in this environment. Real subscription inference, real tool approvals, authenticated resume and authentication persistence across Linux-container recreation require an authenticated smoke test before production rollout. Automated fixtures test their transport and persistence behavior but cannot establish upstream subscription eligibility.

No documented programmatic account-wide quota source was established. The UI therefore reports unavailable numeric Claude allowance and links to Claude's own usage page. Observed runtime limit messages are separate from quota percentages. It never derives subscription allowance from conversation tokens or estimated API cost.

First release indexes sessions created in this app. It does not promise discovery or safe control of external Claude terminal sessions. Both agents use shared project files, and the app's writer guard cannot prevent external terminals from editing them.

Native permission prompts are not equivalent to Codex's OS sandbox. Project hooks and configured MCP servers can run as part of Claude startup; only use registered projects whose configuration you trust.
