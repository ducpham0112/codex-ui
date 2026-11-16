import { Injectable, signal } from "@angular/core";
import type { Observable } from "rxjs";
import { filter } from "rxjs";
import { BUNDLE_COMMIT, BUNDLE_VERSION } from "./bundle-version.generated";

/**
 * Subset of `@angular/service-worker`'s `SwUpdate` surface this module needs.
 * Defining a local interface keeps tests free of the service-worker runtime
 * so they can run under vitest without the JIT compiler. `main.ts` wires the
 * real `SwUpdate` to this interface when the worker is registered.
 */
export interface AppUpdater {
  readonly isEnabled: boolean;
  readonly versionUpdates: Observable<{ type: string; latestVersion?: { hash: string } }>;
  activateUpdate(): Promise<boolean>;
}

export interface UpdateAvailable {
  version: string;
  commit: string | null;
}

export interface VersionInfo {
  application: string;
  commit: string | null;
  node: string;
  codex: string | null;
  generatedProtocol: string;
  compatible: boolean;
  error?: string;
}

/**
 * Surfaces service-worker update notifications and exposes the running build
 * version. Replaces the previous auto-reload behaviour: a user with unsent
 * chat input should not lose it because the deploy pipeline shipped a new
 * bundle, so we prompt and let them decide when to swap in the new worker.
 */
@Injectable({ providedIn: "root" })
export class UpdateService {
  private brandTitle = "Codex Control";
  // Persist the downloaded build hash, rather than the server release label.
  // The same release can be rebuilt and server metadata can differ from the UI.
  static readonly DISMISSED_KEY = "codex.update.dismissedVersion";
  static readonly NOTIFICATION_TAG_PREFIX = "codex-update:";

  private updater: AppUpdater | null = null;
  private readyHash: string | null = null;
  private dismissedHash: string | null = null;
  readonly available = signal<UpdateAvailable | null>(null);
  readonly running = signal<VersionInfo | null>(null);
  readonly checkedAt = signal<number | null>(null);
  readonly currentVersion = BUNDLE_VERSION;
  readonly currentCommit = BUNDLE_COMMIT;
  // Deduplicate notifications by downloaded build, including same-version rebuilds.
  private readonly notifiedVersions = new Set<string>();
  // Injected by tests so the real `new Notification(...)` path is not
  // executed under jsdom. The default delegates to fireSystemNotification,
  // which respects `document.visibilityState` and `Notification.permission`.
  readonly notifyAvailable: (update: UpdateAvailable) => void;

  constructor() {
    this.notifyAvailable = (update) => this.fireSystemNotification(update);
    void this.refresh();
    // Expose the service on window only when the URL opts in. e2e tests
    // append `?codexTest=1` to drive the banner without depending on the
    // real service-worker registration. Production traffic never carries
    // the flag, so the global is never assigned in normal use.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("codexTest") === "1") (window as unknown as { __codexUpdateService?: UpdateService }).__codexUpdateService = this;
    }
  }

  /**
   * Wires the real service-worker controller. Called once from `main.ts`
   * after Angular has finished bootstrapping so the service stays usable
   * in tests that don't have a service worker available.
   */
  bind(updater: AppUpdater | null): void {
    if (this.updater) return;
    this.updater = updater;
    if (!updater || !updater.isEnabled) return;
    updater.versionUpdates
      .pipe(filter((event) => event.type === "VERSION_READY"))
      .subscribe((event) => {
        const hash = event.latestVersion?.hash;
        if (!hash) return;
        this.readyHash = hash;
        this.surfaceReadyUpdate();
        void this.refresh();
      });
    void this.refresh();
  }

  setBrandTitle(title: string): void { this.brandTitle = title; }

  /** Refresh both the running version (Settings display) and the update signal. */
  async refresh(): Promise<void> {
    try {
      const response = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      const body = (await response.json()) as VersionInfo;
      this.running.set(body);
      this.checkedAt.set(Date.now());
      this.surfaceReadyUpdate();
    } catch {
      // Transient network failure; leave signals untouched.
    }
  }

  /** Only a downloaded worker build can establish that reloading is useful. */
  private surfaceReadyUpdate(): void {
    const hash = this.readyHash;
    if (!hash) return;
    if (this.dismissedHash === hash || this.readDismissedVersion() === hash) {
      this.available.set(null);
      return;
    }
    const metadata = this.running();
    const update = { version: metadata?.application || hash.slice(0, 8), commit: metadata?.commit ?? null };
    this.available.set(update);
    if (this.notifiedVersions.has(hash)) return;
    this.notifiedVersions.add(hash);
    try {
      this.notifyAvailable(update);
    } catch {
      // Notification failure must not prevent the in-app banner.
    }
  }

  /**
   * Default system-notification path. Only fires while the tab is hidden so
   * we never double up with the in-app banner, and only when the user has
   * already granted browser permission — we never prompt for it.
   */
  private fireSystemNotification(update: UpdateAvailable): void {
    if (typeof window === "undefined") return;
    if (window.document?.visibilityState !== "hidden") return;
    // The Notification constructor may be unavailable in jsdom or older
    // embedded webviews; treat that the same as "permission not granted".
    const notificationCtor: typeof Notification | undefined =
      (typeof window !== "undefined"
        ? (window as unknown as { Notification?: typeof Notification }).Notification
        : undefined) ??
      (typeof globalThis !== "undefined"
        ? (globalThis as unknown as { Notification?: typeof Notification }).Notification
        : undefined);
    if (!notificationCtor) return;
    if (notificationCtor.permission !== "granted") return;
    try {
      new notificationCtor(`${this.brandTitle} ${update.version} ready`, {
        body: "A new build is available. Reload to switch to the latest PWA version.",
        tag: `${UpdateService.NOTIFICATION_TAG_PREFIX}${this.readyHash ?? update.version}`,
        silent: false,
      });
    } catch {
      // Some browsers (e.g. Safari without installation) throw when fired
      // from an unfocused origin; ignore so the banner still shows.
    }
  }

  /** Apply the pending service-worker update and reload the page. */
  async applyUpdate(): Promise<void> {
    this.available.set(null);
    this.readyHash = null;
    if (!this.updater || !this.updater.isEnabled) {
      location.reload();
      return;
    }
    try {
      await this.updater.activateUpdate();
    } catch {
      // Fall through to reload — the next fetch will pick up the new files
      // because the service worker has already cached them.
    }
    location.reload();
  }

  /** Dismiss the update notification without reloading. */
  dismiss(): void {
    if (this.available() && this.readyHash) {
      this.dismissedHash = this.readyHash;
      this.writeDismissedVersion(this.readyHash);
    }
    this.available.set(null);
  }

  /** Read the last downloaded build the user dismissed. */
  private readDismissedVersion(): string | null {
    if (typeof localStorage === "undefined") return null;
    try {
      return localStorage.getItem(UpdateService.DISMISSED_KEY);
    } catch {
      return null;
    }
  }

  /** Persist the build hash so reloads do not resurface a dismissed banner. */
  private writeDismissedVersion(version: string): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(UpdateService.DISMISSED_KEY, version);
    } catch {
      // Storage may be disabled (private mode, quota, etc.); silently ignore
      // so the banner still hides for the rest of the session.
    }
  }

}
