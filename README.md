# Codex UI

Codex UI manages Codex and Claude Code conversations in one browser app. The production image includes pinned official CLIs. Both agents share your configured projects and keep separate conversations, credentials, and model defaults.

## Claude sessions

Choose **Codex** or **Claude** when creating a session. Both appear in the session selector with agent labels. Claude currently supports text conversations, tool activity, individual permission decisions, interruption, and reopening sessions created through this app. Cross-agent context handoff and external Claude session discovery are not included yet. Existing scheduled tasks continue to use Codex.

Settings shows Claude CLI availability, account/authentication status, login instructions, and sign-out. Authenticate using the official CLI with your Claude subscription:

```bash
docker compose exec codex-ui claude auth login
```

Follow the official browser/code flow in that terminal, then use **Check status** in Settings. The app does not collect your Claude password or subscription tokens. An API key or other configured authentication method can select different billing; Settings reports the runtime's detected method. This integration requires subscription authentication and blocks API/helper methods before sending a prompt. There is no automatic API fallback when subscription usage runs out.

The quota panel shows separate agent sections. Exact Claude subscription percentages are shown as unavailable until a supported programmatic source is established; use **Open Claude usage** to inspect your allowance. Runtime limit notices are observations, not calculated remaining quota. See [integration verification and limitations](docs/claude-integration.md).

Claude uses native permission prompts rather than Codex's OS sandbox profiles. Project hooks and MCP configuration may execute during CLI startup, so register projects whose configuration you trust. The app prevents concurrent app-managed turns in overlapping project paths; external terminals remain outside that guard.

## Mobile interface

<p align="center">
  <img src="images/mobile-chat.png" alt="Codex UI chat on a phone" width="220" />
  <img src="images/mobile-schedule.png" alt="Creating a scheduled Codex task on a phone" width="220" />
  <img src="images/mobile-settings.png" alt="Codex UI settings on a phone" width="220" />
  <img src="images/mobile-approval.png" alt="Command approval prompt on a phone" width="220" />
</p>

## Run with Docker

Create a `.env` file from the example and set the two host directories plus the public domain:

```dotenv
PROJECTS_ROOT=/absolute/path/to/projects
HOST_CODEX_HOME=/home/your-user/.codex
HOST_UID=1000
HOST_GID=1000
PUBLIC_ORIGIN=https://codex.example.com
```

If unset, `HOST_CODEX_HOME` defaults to the host user's standard `.codex` directory. It retains Codex authentication, configuration, project registry data, and optional Web Push subscriptions. `PROJECTS_ROOT` is mounted at `/workspace` and is the only project directory exposed to the container.

Claude configuration defaults to `${HOME}/.claude` (`HOST_CLAUDE_HOME`), and the app's Claude session index/history defaults to `${HOME}/.local/share/codex-ui` (`HOST_APP_DATA`). Create both directories with the same ownership as `HOST_UID`/`HOST_GID` before starting Compose. Keep both mounts to preserve Claude login and app-created history across container recreation. A host macOS keychain login may need a fresh official login inside the Linux container; mounting a directory does not transfer keychain entries.

Set `HOST_UID` and `HOST_GID` to `id -u` and `id -g` for the account that owns those directories (they are commonly both `1000`). This lets Codex UI use your mounted configuration without changing any host file ownership.

Start the service:

```bash
docker compose up -d --build
```

## Run the published image

After the Docker Hub workflow has published a version, run it without cloning the repository:

```bash
docker run -d --name codex-ui --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:3210:3210 \
  -e PUBLIC_ORIGIN=https://codex.example.com \
  -e PROJECTS_ROOT=/workspace \
  -e CODEX_HOME=/home/app/.codex \
  -e CLAUDE_CONFIG_DIR=/home/app/.claude \
  -e APP_DATA_DIR=/home/app/.local/share/codex-ui \
  -e CODEX_CWD=/workspace \
  -v /absolute/path/to/projects:/workspace \
  -v "$HOME/.codex:/home/app/.codex" \
  -v "$HOME/.claude:/home/app/.claude" \
  -v "$HOME/.local/share/codex-ui:/home/app/.local/share/codex-ui" \
  ivoglent/codex-ui:latest
```

Use a version tag such as `ivoglent/codex-ui:0.149.1` when you need a repeatable deployment. As with Compose, put the loopback port behind an authenticated TLS reverse proxy before exposing a domain.

The published port binds only to `127.0.0.1`; do not expose it directly. Codex UI has no built-in user authentication and can access the mounted projects and Codex credentials. Put it behind a TLS reverse proxy with authentication (for example, the Basic Auth configuration in `deploy/gateway/nginx.conf.example` or an identity-aware proxy) before using a public domain. For local testing, use `http://localhost:3210`. The container health endpoint is available at `/readyz`.

New turns default to a safe workspace sandbox and request approval before actions. Do not change the execution profile or project approval policy to unrestricted/auto-approve for an internet-facing deployment.

On first launch, when the mounted `.codex` directory has no saved credentials, Codex UI shows **Sign in with ChatGPT**. It opens OpenAI's device-code sign-in page and displays a one-time code; after you approve it, the session is saved in the mounted `.codex` directory for later container starts. Never use a shared deployment for credentials belonging to different people.

If a device code cannot be requested, first enable device-code login in your ChatGPT security settings (or ask the ChatGPT workspace administrator to enable it). Then verify that the container can make an outbound HTTPS connection to `auth.openai.com`; this is required before the browser can show a code. The device-code flow is intended for headless and remote hosts.

## Configuration

The image includes CLI versions declared by `CODEX_VERSION` and `CLAUDE_VERSION` in the [Dockerfile](Dockerfile). The GitHub workflow publishes Docker Hub image tags matching the Codex version at `ivoglent/codex-ui`, plus `latest`, after changes land on `master`. Add `DOCKERHUB_USERNAME` and a Docker Hub access-token `DOCKERHUB_TOKEN` as GitHub Actions secrets to enable publishing; without both secrets, CI still builds the image and skips publication.

Projects can be declared in `config/projects.container.yaml` or automatically discovered beneath `PROJECTS_ROOT`. The application only creates new project directories below the configured discovery root.

Set the optional branding variables in `.env` to name a deployment:

```dotenv
APP_TITLE=Codex UI
APP_SHORT_NAME=Codex
APP_ICON_URL=/favicon.svg
APP_THEME_COLOR=#111827
APP_BACKGROUND_COLOR=#090d16
```

Web Push is optional and delivered directly by this backend. To enable it, set `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT`. Keep the private key out of source control.

## Development

Use Node.js 22.12 or newer (validated with 22.23.5). See [Claude feature validation](docs/claude-feature-validation.md) for coverage, existing browser-test failures, and remaining live-account/container checks.

```bash
corepack pnpm install
corepack pnpm generate:protocol
corepack pnpm test
corepack pnpm check
corepack pnpm build
```

The server listens on `127.0.0.1:3210` by default. It exposes `/healthz`, `/readyz`, `/api/projects`, `/api/version`, and `/ws`.

For local Claude development, install the pinned official Claude CLI, authenticate with `claude auth login`, and optionally set `CLAUDE_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, and `APP_DATA_DIR`. The latter defaults to `~/.local/share/codex-ui`. The Claude API is under `/api/agents/claude`; browser reconnects poll snapshots and never resubmit prompts. `/readyz` reports application transport readiness with separate agent status, so missing installation/login for one agent does not take down the other. On macOS, use a canonical temporary root (`TMPDIR=/private/tmp corepack pnpm test`) if project-registry assertions encounter `/var` versus `/private/var` aliases.

## License

MIT. See [LICENSE](LICENSE).
