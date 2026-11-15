import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

describe("independent agent startup", () => {
  it("serves the app and Claude status when Codex cannot start", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agent-startup-"));
    await mkdir(join(temporary, "projects"));
    await writeFile(join(temporary, "projects.yaml"), "projects: []\n");
    const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/main.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CODEX_EXECUTABLE: join(temporary, "missing-codex"), CLAUDE_EXECUTABLE: join(temporary, "missing-claude"), CODEX_HOME: join(temporary, "codex"), CLAUDE_CONFIG_DIR: join(temporary, "claude"), APP_DATA_DIR: join(temporary, "data"), PROJECTS_ROOT: join(temporary, "projects"), PROJECTS_CONFIG: join(temporary, "projects.yaml"), CODEX_UI_PROJECTS_FILE: join(temporary, "registry.json"), WEB_PUSH_SUBSCRIPTIONS_PATH: join(temporary, "push.json") }
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; if (ready) break; } catch { /* startup */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready, stderr).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).ok).toBe(true);
      const response = await fetch(`http://127.0.0.1:${port}/api/agents/claude/status`);
      expect(response.ok).toBe(true);
      expect((await response.json()).account).toBeDefined();
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) await Promise.race([exited, new Promise<void>(resolve => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1500))]);
      await rm(temporary, { recursive: true, force: true });
    }
  }, 10_000);
});
