// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Subject } from "rxjs";
import { UpdateService } from "./update.service";
import { BUNDLE_VERSION } from "./bundle-version.generated";

type UpdateEvent = { type: string; latestVersion?: { hash: string } };
const makeUpdater = (isEnabled = true) => ({
  isEnabled,
  versionUpdates: new Subject<UpdateEvent>(),
  activateUpdate: vi.fn().mockResolvedValue(true),
});
const ready = (updater: ReturnType<typeof makeUpdater>, hash = "build-a") => {
  updater.versionUpdates.next({ type: "VERSION_READY", latestVersion: { hash } });
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const versionResponse = (application = "v9.9.9") => new Response(JSON.stringify({
  application, commit: "abc1234", node: "v20.0.0", codex: "1.2.3",
  generatedProtocol: "1.2.3", compatible: true,
}), { headers: { "content-type": "application/json" } });

// Only the browser/network boundaries are stubbed; all update decisions use the real service.
describe("UpdateService", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse()));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hydrates Settings metadata without announcing a server version mismatch", async () => {
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    await settle();
    expect(service.currentVersion).toBe(BUNDLE_VERSION);
    expect(service.running()?.application).toBe("v9.9.9");
    expect(service.checkedAt()).not.toBeNull();
    expect(service.available()).toBeNull();
  });

  it.each([null, makeUpdater(false)])("does not prompt without an enabled worker: %s", async (updater) => {
    const service = new UpdateService();
    service.bind(updater);
    await settle();
    await service.refresh();
    expect(service.available()).toBeNull();
  });

  it("does not announce an older server version or an undownloaded build", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("0.0.0")));
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    updater.versionUpdates.next({ type: "VERSION_DETECTED", latestVersion: { hash: "build-a" } });
    await settle();
    expect(service.available()).toBeNull();
  });

  it("announces a downloaded build on VERSION_READY", async () => {
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    await settle();
    ready(updater);
    await settle();
    expect(service.available()).toEqual({ version: "v9.9.9", commit: "abc1234" });
  });

  it("announces a new build even when its release version matches the running bundle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse(BUNDLE_VERSION)));
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    await settle();
    ready(updater);
    await settle();
    expect(service.available()?.version).toBe(BUNDLE_VERSION);
    await service.refresh();
    expect(service.available()).not.toBeNull();
  });

  it("still announces a downloaded build when the version API is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    ready(updater);
    await settle();
    expect(service.available()).not.toBeNull();
    expect(service.running()).toBeNull();
  });

  it("ignores a ready event without build identity", async () => {
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    updater.versionUpdates.next({ type: "VERSION_READY" });
    await settle();
    expect(service.available()).toBeNull();
  });

  it("remembers a dismissed build across polling, repeated ready events, and reloads", async () => {
    const first = new UpdateService();
    const updater = makeUpdater();
    first.bind(updater);
    ready(updater);
    await settle();
    first.dismiss();
    await first.refresh();
    ready(updater);
    await settle();
    expect(first.available()).toBeNull();
    const second = new UpdateService();
    const nextUpdater = makeUpdater();
    second.bind(nextUpdater);
    await settle();
    ready(nextUpdater);
    await settle();
    expect(second.available()).toBeNull();
    // A fresh download with the same release version is a distinct update.
    ready(nextUpdater, "build-b");
    await settle();
    expect(second.available()?.version).toBe("v9.9.9");
  });

  it("keeps a dismissed build hidden when localStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    ready(updater);
    await settle();
    service.dismiss();
    ready(updater);
    await service.refresh();
    expect(service.available()).toBeNull();
  });

  it("does not prompt after reloading into the latest build without another ready event", async () => {
    const service = new UpdateService();
    service.bind(makeUpdater());
    await settle();
    await service.refresh();
    expect(service.available()).toBeNull();
  });

  it.each([
    ["hidden", "granted", 1],
    ["visible", "granted", 0],
    ["hidden", "default", 0],
  ] as const)("notifies once per downloaded build with visibility=%s permission=%s", async (visibility, permission, count) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    const notification = vi.fn();
    vi.stubGlobal("Notification", Object.assign(function (title: string, options: NotificationOptions) {
      notification(title, options);
    }, { permission }));
    const service = new UpdateService();
    const updater = makeUpdater();
    service.bind(updater);
    await settle();
    expect(notification).not.toHaveBeenCalled();
    ready(updater);
    await settle();
    ready(updater);
    await service.refresh();
    expect(notification).toHaveBeenCalledTimes(count);
    if (count) {
      expect(notification).toHaveBeenLastCalledWith("Codex Control v9.9.9 ready", expect.objectContaining({ tag: "codex-update:build-a" }));
      ready(updater, "build-b");
      await settle();
      expect(notification).toHaveBeenCalledTimes(2);
    }
  });

  it("activates the worker and reloads only when the user applies the update", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    const updater = makeUpdater();
    const service = new UpdateService();
    service.bind(updater);
    ready(updater);
    await settle();
    expect(reload).not.toHaveBeenCalled();
    service.dismiss();
    expect(reload).not.toHaveBeenCalled();
    ready(updater, "build-b");
    await service.applyUpdate();
    expect(updater.activateUpdate).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    expect(service.available()).toBeNull();
  });
});
