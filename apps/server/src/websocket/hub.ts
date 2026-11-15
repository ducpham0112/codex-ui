import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { BrowserInbound, ScheduleRecord } from "@codex-control/shared";
import type { AppServerSupervisor } from "../codex/supervisor.js";
import type { ProjectRegistry } from "../config/projects.js";
import { EventStream } from "./event-stream.js";
import { AttentionCoordinator } from "../notifications/attention.js";
import { Metrics } from "../observability/metrics.js";
import { NotificationDispatcher, shouldDispatchWebPush } from "../notifications/dispatcher.js";

const allowedMethods = new Set([
  "thread/start", "thread/resume", "thread/fork", "thread/read", "thread/list", "thread/turns/list", "thread/items/list", "thread/name/set", "thread/goal/set", "thread/goal/get", "thread/goal/clear", "thread/metadata/update", "thread/archive", "thread/unarchive", "thread/delete", "thread/unsubscribe", "thread/compact/start",
  "turn/start", "turn/steer", "turn/interrupt", "review/start", "model/list", "modelProvider/capabilities/read", "permissionProfile/list", "collaborationMode/list", "experimentalFeature/list", "experimentalFeature/enablement/set", "skills/list", "hooks/list", "mcpServerStatus/list", "mcpServer/oauth/login", "config/mcpServer/reload", "app/installed", "app/list", "app/read", "account/read", "account/logout", "account/login/start", "account/login/cancel", "account/rateLimits/read", "account/usage/read", "account/workspaceMessages/read", "config/read", "config/value/write", "config/batchWrite"
]);
const threadSyncMethod = "thread/items/sync";
const configKeyAllowlist = ["model", "model_reasoning_effort", "model_reasoning_summary", "personality", "approval_policy", "sandbox_mode", "features.apps", "features.plugins"];
const MAX_BROWSER_WS_PAYLOAD_BYTES = 2 * 1024 * 1024;

export class BrowserHub {
  private readonly activeThreads = new Set<string>();
  private readonly startingProjects = new Map<string, string>();
  private readonly pendingStarts = new Map<string, symbol>();
  private readyGeneration: string | null;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly wss: WebSocketServer; private readonly stream: EventStream; private readonly pending = new Map<string, { id: number | string; method: string; params: unknown }>(); private readonly attention = new AttentionCoordinator(); private readonly observedThreads = new Map<string, unknown>();
  constructor(server: Server, private readonly supervisor: AppServerSupervisor, private readonly projects: ProjectRegistry, readonly metrics = new Metrics(), origin?: string, capacity = 10_000, private readonly dispatcher?: NotificationDispatcher, private readonly otherAgentBusy?: (root: string) => boolean) {
    this.readyGeneration = supervisor.status.generationId ?? null;
    this.stream = new EventStream(capacity); this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_WS_PAYLOAD_BYTES });
    // Keep idle proxies/tunnels active even when browsers throttle background
    // timers. This is transport traffic, so it does not enter event replay.
    this.heartbeat = setInterval(() => this.broadcast({ type: "system.heartbeat" }), 25_000);
    this.heartbeat.unref();
    server.on("upgrade", (request, socket, head) => {
      const pathMatches = request.url === "/ws";
      const originMatches = !origin || request.headers.origin === origin;
      this.logConnection("upgrade", { pathMatches, originMatches });
      if (!pathMatches || !originMatches) {
        this.logConnection("upgrade_rejected", { reason: !pathMatches ? "path_mismatch" : "origin_mismatch" });
        return socket.destroy();
      }
      this.wss.handleUpgrade(request, socket, head, (client) => this.wss.emit("connection", client, request));
    });
    this.wss.on("connection", (client, request: IncomingMessage) => {
      const connectionId = randomUUID();
      const startedAt = Date.now();
      let lastMessageAt = startedAt;
      this.metrics.clients++;
      const rayHeader = request.headers["cf-ray"];
      const rayId = typeof rayHeader === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(rayHeader) ? rayHeader : null;
      this.logConnection("connected", { connectionId, clients: this.metrics.clients, rayId });
      client.on("error", (error: NodeJS.ErrnoException) => {
        this.logConnection("transport_error", { connectionId, oversized: error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" });
      });
      client.once("close", (code) => {
        this.metrics.clients--;
        this.logConnection("closed", { connectionId, code, lifetimeMs: Date.now() - startedAt, lastMessageAgeMs: Date.now() - lastMessageAt, clients: this.metrics.clients });
      });
      client.on("message", (data) => { lastMessageAt = Date.now(); void this.receive(client, data.toString()); });
    });
    supervisor.on("notification", (method, params) => {
      this.metrics.notifications++;
      if (method === "thread/started") this.rememberThread((params as any)?.thread);
      if (method === "turn/started") {
        const id = (params as any)?.threadId;
        if (typeof id === "string") {
          this.activeThreads.add(id);
          if (!this.observedThreads.has(id)) void this.supervisor.broker.request<any>("thread/read", { threadId: id }).then(result => this.rememberThread(result?.thread)).catch(() => undefined);
        }
      }
      if (method === "turn/completed") {
        const id = (params as any)?.threadId;
        this.activeThreads.delete(id); this.startingProjects.delete(id);
      }
      if (method === "serverRequest/resolved") {
        const requestId = (params as any)?.requestId;
        const resolved = [...this.pending].find(([, value]) => String(value.id) === String(requestId));
        if (resolved) {
          this.pending.delete(resolved[0]); this.attention.resolveRequest(resolved[0]);
          this.broadcast(this.stream.append("attention.changed", { requestKey: resolved[0], resolved: true, counts: this.attention.counts() }));
        }
      }
      const item = this.attention.add(method, params); this.broadcast(this.stream.append("codex.event", { method, params })); if (item && shouldDispatchWebPush(item)) this.dispatch(item);
      if (item) this.broadcast(this.stream.append("attention.changed", { item, counts: this.attention.counts() }));
    });
    supervisor.on("serverRequest", (id, method, params) => { const requestKey = randomUUID(); this.pending.set(requestKey, { id, method, params }); const item = this.attention.add(method, params, requestKey); this.broadcast(this.stream.append("codex.serverRequest", { requestKey, method, params, expiresAt: null })); if (item) { this.broadcast(this.stream.append("attention.changed", { item, counts: this.attention.counts() })); if (shouldDispatchWebPush(item)) this.dispatch(item); } });
    supervisor.on("status", (status) => {
      this.logConnection("app_server_status", { state: status.state, restartCount: status.restartCount });
      if ((status.state === "FAILED" || status.state === "STOPPED") && status.pid === null && this.supervisor.managesLocalExecution) {
        this.activeThreads.clear(); this.startingProjects.clear(); this.pendingStarts.clear();
      }
      if (status.state === "READY" && status.generationId !== this.readyGeneration) {
        this.readyGeneration = status.generationId;
        const generation = status.generationId;
        const tracked = new Set([...this.activeThreads, ...this.startingProjects.keys()]);
        this.pendingStarts.clear();
        for (const id of tracked) void this.supervisor.broker.request<any>("thread/read", { threadId: id }).then(result => {
          if (this.supervisor.status.generationId === generation) this.rememberThread(result?.thread, true);
        }).catch(() => undefined); // A disconnected external writer remains conservatively unknown.
      }
      this.broadcast(this.stream.append("system.status", { status }));
    });
  }
  private logConnection(event: string, details: Record<string, string | number | boolean | null>): void {
    console.info("[websocket]", JSON.stringify({ at: new Date().toISOString(), event, ...details }));
  }
  close(): void { this.logConnection("hub_closing", { clients: this.metrics.clients }); clearInterval(this.heartbeat); this.wss.close(); }
  isProjectActive(root: string): boolean {
    const overlaps = (cwd: string) => { const a = resolve(root), b = resolve(cwd); return a === b || a.startsWith(b + sep) || b.startsWith(a + sep); };
    return [...this.startingProjects.values()].some(overlaps) || [...this.activeThreads].some(id => {
      const cwd = (this.observedThreads.get(id) as any)?.cwd;
      // Unknown active threads are conservatively busy until resolved.
      return typeof cwd !== "string" || overlaps(cwd);
    });
  }
  projectsChanged(): void { this.broadcast(this.snapshot()); }
  broadcastScheduleChange(schedule: ScheduleRecord): void { this.broadcast(this.stream.append("schedule.changed", { schedule })); }
  /**
   * Reconcile the app-server's list with thread IDs announced while this shared
   * server has been running. `thread/list` can lag a freshly started remote CLI
   * session, while `thread/read` can already retrieve it.
   */
  async scanSessions(): Promise<{ data: unknown[] }> {
    const listed = new Map<string, any>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page: { data?: any[]; nextCursor?: string | null } = await this.supervisor.broker.request("thread/list", { ...(cursor ? { cursor } : {}), limit: 100, archived, sortKey: "updated_at", sortDirection: "desc" });
        for (const thread of page?.data ?? []) this.rememberThread(thread), listed.set(thread.id, thread);
        cursor = page?.nextCursor ?? null;
        if (cursor && cursors.has(cursor)) throw new Error("Codex returned a repeated session-list cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    for (const id of this.observedThreads.keys()) {
      if (listed.has(id)) continue;
      try {
        const result = await this.supervisor.broker.request<any>("thread/read", { threadId: id });
        const thread = result?.thread;
        if (thread?.id === id) this.rememberThread(thread), listed.set(id, thread);
      } catch {
        // A deleted or not-yet-readable thread must not prevent other sessions from appearing.
      }
    }
    return { data: [...listed.values()] };
  }
  private snapshot() { return { type: "system.snapshot", generationId: this.stream.generationId, sequence: this.stream.sequence, appServer: this.supervisor.status, projects: this.projects.projects, pendingRequests: [...this.pending].map(([requestKey, value]) => ({ type: "codex.serverRequest", requestKey, method: value.method, params: value.params, expiresAt: null })), attention: this.attention.list(), attentionCounts: this.attention.counts() }; }
  private async receive(client: WebSocket, raw: string): Promise<void> {
    let message: BrowserInbound;
    try { message = JSON.parse(raw) as BrowserInbound; } catch { return this.send(client, { type: "system.error", error: { code: "INVALID_JSON", message: "Invalid JSON message" } }); }
    if (message.type === "hello") { this.metrics.reconnects++; const replay = this.stream.replay(message.lastGenerationId, message.lastSequence); if (replay) { this.metrics.replays++; replay.forEach((event) => this.send(client, event)); } else { this.metrics.resyncs++; this.send(client, { type: "system.resyncRequired" }); } return this.send(client, this.snapshot()); }
    if (message.type === "codex.serverRequestResponse") { const pending = this.pending.get(message.requestKey); if (!pending) return this.send(client, { type: "rpc.error", requestId: message.requestKey, error: { code: "ALREADY_RESOLVED", message: "Request is stale or already resolved" } }); this.supervisor.broker.respond(pending.id, message.result, message.error); this.pending.delete(message.requestKey); this.attention.resolveRequest(message.requestKey); return this.broadcast(this.stream.append("attention.changed", { requestKey: message.requestKey, resolved: true, resolution: message.result ?? message.error, counts: this.attention.counts() })); }
    if (message.type !== "rpc.request") return;
    if (!allowedMethods.has(message.method) && message.method !== threadSyncMethod) return this.send(client, { type: "rpc.error", requestId: message.requestId, error: { code: "METHOD_NOT_ALLOWED", message: "Method is outside the PWA product boundary" } });
    if (message.method === "config/value/write" || message.method === "config/batchWrite") { const params = message.params as any; const keys = message.method === "config/value/write" ? [params?.keyPath] : (params?.edits ?? []).map((edit: any) => edit.keyPath); if (params?.filePath || keys.some((key: unknown) => typeof key !== "string" || !configKeyAllowlist.includes(key))) return this.send(client, { type: "rpc.error", requestId: message.requestId, error: { code: "CONFIG_KEY_NOT_ALLOWED", message: "Only documented Codex UI settings may be changed" } }); }
    this.metrics.rpcRequests++;
    let reservedThread: string | undefined;
    let reservation: symbol | undefined;
    try {
      if (message.method === threadSyncMethod) return this.send(client, { type: "rpc.response", requestId: message.requestId, result: await this.syncThreadItems(message.params as any) });
      if (message.method === "turn/start" || message.method === "review/start") {
        const id = (message.params as any)?.threadId;
        if (typeof id !== "string") throw new Error("threadId is required");
        const read = await this.supervisor.broker.request<any>("thread/read", { threadId: id });
        const cwd = read?.thread?.cwd;
        if (typeof cwd !== "string") throw new Error("Session project could not be resolved");
        this.rememberThread(read.thread, true);
        if (this.isProjectActive(cwd) || this.otherAgentBusy?.(cwd)) throw new Error("Another session is active in this project. Wait for it to finish before starting a turn.");
        this.startingProjects.set(id, cwd); reservedThread = id;
        reservation = Symbol(id); this.pendingStarts.set(id, reservation);
      }
      const result = await this.supervisor.broker.request(message.method, message.params ?? {});
      if (["thread/start", "thread/fork", "thread/read", "thread/resume"].includes(message.method)) this.rememberThread((result as any)?.thread, message.method === "thread/read" || message.method === "thread/resume");
      if (message.method === "thread/list") for (const thread of (result as any)?.data ?? []) this.rememberThread(thread);
      this.send(client, { type: "rpc.response", requestId: message.requestId, result });
    }
    catch (error) { if (reservedThread && this.pendingStarts.get(reservedThread) === reservation) this.startingProjects.delete(reservedThread); this.metrics.rpcErrors++; this.send(client, { type: "rpc.error", requestId: message.requestId, error: { code: "CODEX_RPC_ERROR", message: error instanceof Error ? error.message : String(error) } }); }
    finally { if (reservedThread && this.pendingStarts.get(reservedThread) === reservation) this.pendingStarts.delete(reservedThread); }
  }
  private async syncThreadItems(params: { threadId?: unknown; knownItemIds?: unknown }): Promise<{ data: any[] }> {
    if (typeof params?.threadId !== "string") throw new Error("threadId is required");
    const known = new Set(Array.isArray(params.knownItemIds) ? params.knownItemIds.filter((id): id is string => typeof id === "string") : []);
    const all: any[] = []; let cursor: string | null = null;
    do { const page: any = await this.supervisor.broker.request("thread/items/list", { threadId: params.threadId, cursor, limit: 100, sortDirection: "asc" }); all.push(...(page.data ?? [])); cursor = page.nextCursor ?? null; } while (cursor);
    return { data: all.flatMap((entry, index) => typeof entry.item?.id === "string" && !known.has(entry.item.id) ? [{ ...entry, index }] : []) };
  }
  private send(client: WebSocket, message: unknown): void { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); }
  private broadcast(message: unknown): void { for (const client of this.wss.clients) this.send(client, message); }
  private dispatch(item: import("../notifications/attention.js").AttentionItem): void { if (this.dispatcher) void this.dispatcher.dispatch(item); }
  private rememberThread(thread: any, authoritative = false): void {
    if (!thread || typeof thread.id !== "string") return;
    this.observedThreads.set(thread.id, thread);
    const status = thread.status?.type ?? thread.status;
    if (["active", "inProgress", "running"].includes(status)) this.activeThreads.add(thread.id);
    else if (status && !this.pendingStarts.has(thread.id) && (!this.startingProjects.has(thread.id) || authoritative)) {
      this.activeThreads.delete(thread.id);
      if (authoritative) this.startingProjects.delete(thread.id);
    }
  }
}
