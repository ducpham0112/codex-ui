import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); vi.stubGlobal("indexedDB", new IDBFactory()); });

describe("shared browser database", () => {
  it("lets draft and history consumers open together on a new browser", async () => {
    const { openBrowserDatabase } = await import("./browser-database");
    const draftConnection = openBrowserDatabase();
    const historyConnection = openBrowserDatabase();
    expect(draftConnection).toBe(historyConnection);
    const db = await historyConnection;
    expect([...db.objectStoreNames]).toEqual(["drafts", "thread-history"]);
    db.close();
  });

  it("upgrades a draft-only database without losing the saved draft", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("codex-control", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("drafts");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put("unsent message", "session");
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    });
    const { openBrowserDatabase } = await import("./browser-database");
    const db = await openBrowserDatabase();
    const draft = await new Promise((resolve, reject) => {
      const request = db.transaction("drafts").objectStore("drafts").get("session");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(draft).toBe("unsent message");
    expect(db.objectStoreNames.contains("thread-history")).toBe(true);
    db.close();
  });
});
