import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BrowserHub } from "../src/websocket/hub.js";

describe("BrowserHub approvals", () => {
  it("releases terminated local execution but keeps disconnected remote writers unknown", async () => {
    for (const local of [true, false]) {
      const supervisor = new EventEmitter() as any;
      supervisor.status = { state: "READY", generationId: "one" };
      supervisor.managesLocalExecution = local;
      const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
      try {
        supervisor.emit("notification", "thread/started", { thread: { id: "t", cwd: "/work/project" } });
        supervisor.emit("notification", "turn/started", { threadId: "t" });
        supervisor.status = { state: "FAILED", generationId: "one", pid: null };
        supervisor.emit("status", supervisor.status);
        expect(hub.isProjectActive("/work/project")).toBe(!local);
      } finally { hub.close(); }
    }
  });
  it("releases accepted start reservations on an authoritative idle read", async () => {
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY", generationId: "one" };
    supervisor.broker = { request: async (method: string) => method === "thread/read" ? { thread: { id: "t", cwd: "/work/project", status: { type: "idle" } } } : {} };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
    const client = { readyState: 1, send() {} };
    try {
      await (hub as any).receive(client, JSON.stringify({ type: "rpc.request", requestId: "start", method: "turn/start", params: { threadId: "t" } }));
      expect(hub.isProjectActive("/work/project")).toBe(true);
      await (hub as any).receive(client, JSON.stringify({ type: "rpc.request", requestId: "read", method: "thread/read", params: { threadId: "t" } }));
      expect(hub.isProjectActive("/work/project")).toBe(false);
    } finally { hub.close(); }
  });
  it("preserves an in-flight start reservation across idle reads", async () => {
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY", generationId: "one" };
    let accept!: (result: unknown) => void;
    supervisor.broker = { request: async (method: string) => method === "thread/read" ? { thread: { id: "t", cwd: "/work/project", status: { type: "idle" } } } : new Promise(resolve => { accept = resolve; }) };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
    const client = { readyState: 1, send() {} };
    try {
      const pending = (hub as any).receive(client, JSON.stringify({ type: "rpc.request", requestId: "start", method: "turn/start", params: { threadId: "t" } }));
      await new Promise(resolve => setImmediate(resolve));
      await (hub as any).receive(client, JSON.stringify({ type: "rpc.request", requestId: "read", method: "thread/read", params: { threadId: "t" } }));
      expect(hub.isProjectActive("/work/project")).toBe(true);
      accept({}); await pending;
    } finally { hub.close(); }
  });
  it("reconciles interrupted accepted turns on a new READY generation without replay", async () => {
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY", generationId: "one" };
    const calls: string[] = [];
    supervisor.broker = { request: async (method: string) => { calls.push(method); return { thread: { id: "t", cwd: "/work/project", status: { type: "idle" } } }; } };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
    try {
      await (hub as any).receive({ readyState: 1, send() {} }, JSON.stringify({ type: "rpc.request", requestId: "start", method: "turn/start", params: { threadId: "t" } }));
      supervisor.emit("notification", "turn/started", { threadId: "t" });
      supervisor.status = { state: "RESTARTING", generationId: "one" }; supervisor.emit("status", supervisor.status);
      expect(hub.isProjectActive("/work/project")).toBe(true);
      supervisor.status = { state: "READY", generationId: "two" }; supervisor.emit("status", supervisor.status);
      await new Promise(resolve => setImmediate(resolve));
      expect(hub.isProjectActive("/work/project")).toBe(false);
      expect(calls.filter(method => method === "turn/start")).toHaveLength(1);
      expect(calls.filter(method => method === "thread/read")).toHaveLength(2);
    } finally { hub.close(); }
  });

  it("routes the official Codex sign-out operation from account settings", async () => {
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY" };
    const calls: string[] = [];
    supervisor.broker = { request: async (method: string) => { calls.push(method); return {}; } };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
    try {
      await (hub as any).receive({ readyState: 1, send() {} }, JSON.stringify({ type: "rpc.request", requestId: "logout", method: "account/logout" }));
      expect(calls).toEqual(["account/logout"]);
    } finally { hub.close(); }
  });
  it("blocks a Codex turn when Claude is writing the same project", async () => {
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY" };
    const calls: string[] = [];
    supervisor.broker = { request: async (method: string) => { calls.push(method); return { thread: { id: "t", cwd: "/work/project" } }; } };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any, undefined, undefined, undefined, undefined, () => true);
    const sent: any[] = [];
    try {
      await (hub as any).receive({ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }, JSON.stringify({ type: "rpc.request", requestId: "r", method: "turn/start", params: { threadId: "t" } }));
      expect(calls).not.toContain("turn/start");
      expect(sent.at(-1)?.error?.message).toMatch(/project.*active|active.*project/i);
    } finally { hub.close(); }
  });

  it("tracks Codex project writers from runtime notifications", () => {
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY" };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
    try {
      supervisor.emit("notification", "thread/started", { thread: { id: "t", cwd: "/work/project/sub" } });
      supervisor.emit("notification", "turn/started", { threadId: "t", turn: { id: "turn" } });
      expect(hub.isProjectActive("/work/project")).toBe(true);
      expect(hub.isProjectActive("/work/other")).toBe(false);
      supervisor.emit("notification", "turn/completed", { threadId: "t", turn: { id: "turn" } });
      expect(hub.isProjectActive("/work/project")).toBe(false);
    } finally { hub.close(); }
  });
  it("sends idle keepalives and stops them when the hub closes", () => {
    vi.useFakeTimers();
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY" };
    const hub = new BrowserHub(createServer(), supervisor, { projects: [] } as any);
    const sent: string[] = [];
    const client = { readyState: 1, send: (message: string) => sent.push(message) };
    (hub as any).wss.clients.add(client);
    try {
      vi.advanceTimersByTime(25_000);
      expect(sent.map(message => JSON.parse(message))).toEqual([{ type: "system.heartbeat" }]);
      (hub as any).wss.clients.delete(client);
      hub.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      (hub as any).wss.clients.delete(client);
      hub.close();
      vi.useRealTimers();
    }
  });
  it("removes a pending request resolved by another app-server client", () => {
    const server = createServer();
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY" };
    supervisor.broker = { respond() {} };
    const hub = new BrowserHub(server, supervisor, { projects: [] } as any);

    supervisor.emit("serverRequest", "daemon-request-1", "item/commandExecution/requestApproval", { threadId: "thread-1" });
    expect((hub as any).pending.size).toBe(1);
    supervisor.emit("notification", "serverRequest/resolved", { requestId: "daemon-request-1", threadId: "thread-1" });
    expect((hub as any).pending.size).toBe(0);
    hub.close();
  });

  it("scans a thread announced by another app-server client even before it reaches thread/list", async () => {
    const server = createServer();
    const supervisor = new EventEmitter() as any;
    supervisor.status = { state: "READY" };
    supervisor.broker = { request: async (method: string, params: any) => {
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "thread/read" && params.threadId === "remote-thread") return { thread: { id: "remote-thread", cwd: "/work/remote" } };
      throw new Error(`Unexpected ${method}`);
    } };
    const hub = new BrowserHub(server, supervisor, { projects: [] } as any);

    supervisor.emit("notification", "thread/started", { thread: { id: "remote-thread", cwd: "/work/remote" } });
    await expect(hub.scanSessions()).resolves.toEqual({ data: [{ id: "remote-thread", cwd: "/work/remote" }] });
    hub.close();
  });
});
