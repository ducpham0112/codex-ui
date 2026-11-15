import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BrowserHub } from "../src/websocket/hub.js";

describe("BrowserHub approvals", () => {
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
