import { describe, expect, it, vi } from "vitest";
import { loadSessionRuntime } from "./session-runtime";

describe("session runtime", () => {
  it("loads history read-only when the desktop app owns the writer", async () => {
    const rpc = vi.fn().mockRejectedValueOnce(new Error("thread session already has an active writer"))
      .mockResolvedValueOnce({ thread: { id: "session", turns: [{ id: "turn", items: [] }] } });
    const result = await loadSessionRuntime(rpc, "session");
    expect(rpc).toHaveBeenLastCalledWith("thread/read", { threadId: "session", includeTurns: true });
    expect(result.thread.externalWriter).toBe(true);
    expect(result.thread.turns).toHaveLength(1);
  });
  it("preserves other resume errors instead of hiding them", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("connection lost"));
    await expect(loadSessionRuntime(rpc, "session")).rejects.toThrow("connection lost");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("clears read-only state when a session can be resumed", async () => {
    const result = await loadSessionRuntime(vi.fn().mockResolvedValue({ thread: { id: "session" }, model: "example" }), "session");
    expect(result.thread.externalWriter).toBe(false);
    expect(result.model).toBe("example");
  });
});
