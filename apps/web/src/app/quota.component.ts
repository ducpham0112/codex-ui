import { Component, DestroyRef, computed, effect, inject, signal, untracked } from "@angular/core";
import { DatePipe } from "@angular/common";
import { ConnectionService } from "./connection.service";
import { quotaBuckets, quotaHeaderWindows, quotaResetDuration, quotaWindowLabel, windowRemaining, type QuotaBucket } from "./quota";

@Component({
  selector: "codex-quota", standalone: true, imports: [DatePipe],
  templateUrl: "./quota.component.html", styleUrl: "./quota.component.css"
})
export class QuotaComponent {
  readonly connection = inject(ConnectionService);
  readonly buckets = signal<QuotaBucket[]>([]);
  readonly loading = signal(false);
  readonly error = signal("");
  readonly updatedAt = signal<Date | null>(null);
  readonly headerWindows = computed(() => quotaHeaderWindows(this.buckets()));
  readonly now = signal(Date.now());
  readonly resetDuration = quotaResetDuration;
  readonly headerLabel = computed(() => 'View Codex quota' + (this.headerWindows().length ? ': ' + this.headerWindows().map(window => `${window.label} ${window.remaining ?? 'unavailable'}${window.remaining === null ? '' : '% remaining'}`).join(', ') : ''));
  readonly windowRemaining = windowRemaining;
  readonly windowLabel = quotaWindowLabel;
  private revision = 0;
  private request = 0;
  private lastEvent: unknown;

  constructor() {
    const clock = window.setInterval(() => this.now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
    effect(() => {
      const connected = this.connection.state() === "connected";
      untracked(() => {
        this.request++;
        this.loading.set(false);
        if (connected) void this.refresh();
      });
    });
    effect(() => {
      const event = [...this.connection.events()].reverse().find(item =>
        item.method === "account/rateLimits/updated" || item.method === "account/updated" || item.method === "account/login/completed");
      if (!event || event === this.lastEvent) return;
      this.lastEvent = event;
      // Notifications are sparse: refetch the complete snapshot rather than
      // treating absent windows or account metadata as cleared values.
      untracked(() => {
        this.revision++;
        if (event.method === "account/updated" || event.method === "account/login/completed") {
          this.buckets.set([]);
          this.updatedAt.set(null);
        }
        void this.refresh();
      });
    });
  }

  async refresh(): Promise<void> {
    if (this.loading() || this.connection.state() !== "connected") return;
    const request = ++this.request;
    const revision = this.revision;
    this.loading.set(true);
    this.error.set("");
    try {
      const result = await this.connection.rpc("account/rateLimits/read");
      if (request !== this.request) return;
      // An account change during a request invalidates its snapshot.
      if (revision !== this.revision) return;
      this.buckets.set(quotaBuckets(result));
      this.updatedAt.set(new Date());
    } catch {
      if (request === this.request) this.error.set("Quota could not be loaded. It may be unavailable for this account or server version.");
    } finally {
      if (request === this.request) {
        this.loading.set(false);
        if (revision !== this.revision) void this.refresh();
      }
    }
  }
}
