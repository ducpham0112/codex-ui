import { DestroyRef, Injectable, inject, signal } from '@angular/core';

export interface QuotaProtectionStatus {
  reservePercent: number;
  remainingPercent: number | null;
  checkedAt: string | null;
  error: string | null;
  paused: { threadId: string; turnId: string; state: string }[];
}
@Injectable({ providedIn: 'root' })
export class QuotaProtectionService {
  readonly status = signal<QuotaProtectionStatus | null>(null);
  readonly error = signal('');
  readonly saving = signal(false);
  private revision = 0;
  private refreshing = false;
  constructor() {
    void this.refresh();
    const timer = window.setInterval(() => void this.refresh(), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  async refresh(): Promise<void> {
    if (this.refreshing || this.saving()) return;
    this.refreshing = true;
    const revision = this.revision;
    try {
      const status = await this.read();
      if (revision === this.revision) { this.status.set(status); this.error.set(''); }
    } catch (error) { if (revision === this.revision) this.error.set(String(error instanceof Error ? error.message : error)); }
    finally { this.refreshing = false; }
  }
  async save(reservePercent: number): Promise<boolean> { return this.mutate('PATCH', { reservePercent }); }
  async cancel(threadId: string): Promise<boolean> { return this.mutate('POST', { cancelThreadId: threadId }); }
  private async mutate(method: string, body: unknown): Promise<boolean> {
    if (this.saving()) return false;
    this.revision++;
    this.saving.set(true); this.error.set('');
    try { this.status.set(await this.read(method, body)); return true; }
    catch (error) { this.error.set(error instanceof Error ? error.message : String(error)); return false; }
    finally { this.saving.set(false); }
  }
  private async read(method = 'GET', body?: unknown): Promise<QuotaProtectionStatus> {
    const response = await fetch('/api/quota-protection', { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Quota protection settings could not be loaded.');
    return data;
  }
}
