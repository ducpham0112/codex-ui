import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RpcError } from '../codex/rpc-broker.js';
import { dirname } from 'node:path';
import type { AppServerSupervisor } from '../codex/supervisor.js';

type Source = Pick<AppServerSupervisor, 'status' | 'broker' | 'on' | 'off'>;
type Work = { threadId: string; turnId: string; params: Record<string, any>; state: 'starting' | 'active' | 'interrupting' | 'paused'; recover?: boolean };
type Window = { usedPercent?: number; windowDurationMins?: number; resetsAt?: number };

/** Only requests routed through this guard establish ownership; daemon events never do. */
export class QuotaProtection {
  private reservePercent = 30;
  private readonly work = new Map<string, Work>();
  private remainingPercent: number | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private readonly onNotification = (method: string, params: unknown) => { void this.notification(method, params).catch(error => this.report(error)); };
  private readonly onStatus = () => {
    this.remainingPercent = null;
    for (const work of this.work.values()) work.recover = true;
    void this.check().catch(error => this.report(error));
  };

  private constructor(private readonly source: Source, private readonly file: string) {}
  static async load(source: Source, file: string): Promise<QuotaProtection> {
    const guard = new QuotaProtection(source, file);
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      validateReserve(data.reservePercent);
      guard.reservePercent = data.reservePercent;
      if (!Array.isArray(data.work)) throw new Error('Invalid quota protection state');
      for (const work of data.work) {
        if (typeof work.threadId !== 'string' || typeof work.turnId !== 'string' || !work.params || !['starting', 'active', 'interrupting', 'paused'].includes(work.state)) throw new Error('Invalid quota protection work');
        guard.work.set(work.threadId, { ...work, recover: true });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return guard;
  }
  start(): void {
    if (this.timer) return;
    this.source.on('notification', this.onNotification);
    this.source.on('status', this.onStatus);
    this.timer = setInterval(() => { void this.check().catch(error => this.report(error)); }, 30_000);
    this.timer.unref();
    void this.check().catch(error => this.report(error));
  }
  async close(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    this.source.off('notification', this.onNotification);
    this.source.off('status', this.onStatus);
    await this.queue;
  }
  snapshot() {
    return { reservePercent: this.reservePercent, remainingPercent: this.remainingPercent, checkedAt: this.checkedAt, error: this.error,
      paused: [...this.work.values()].filter(work => work.state !== 'active').map(({ threadId, turnId, state }) => ({ threadId, turnId, state })) };
  }
  setReserve(value: unknown): Promise<void> {
    return this.serial(async () => { validateReserve(value); this.reservePercent = value as number; await this.persist(); await this.checkExclusive(); });
  }
  cancel(threadId: string): Promise<void> {
    return this.serial(async () => {
      let work = this.work.get(threadId);
      if (work?.state === 'starting') { await this.recoverStart(work); work = this.work.get(threadId); }
      // A browser may still display paused state after the server resumed it.
      if (work?.state === 'active') await this.source.broker.request('turn/interrupt', { threadId, turnId: work.turnId });
      this.work.delete(threadId); await this.persist();
    });
  }
  async request<T = unknown>(method: string, params: any = {}): Promise<T> {
    if (!['turn/start', 'turn/steer', 'turn/interrupt', 'review/start', 'thread/archive', 'thread/delete'].includes(method)) return this.source.broker.request<T>(method, params);
    return this.serial(async () => {
      if (['turn/interrupt', 'thread/archive', 'thread/delete'].includes(method)) {
        this.work.delete(params.threadId); await this.persist();
        return this.source.broker.request<T>(method, params);
      }
      await this.readQuota();
      if (this.remainingPercent !== null && this.remainingPercent <= this.reservePercent) throw new Error(`Quota protection: 5-hour quota has ${this.remainingPercent}% remaining (reserve ${this.reservePercent}%). Wait for quota to recover.`);
      if (this.work.get(params.threadId)?.state && this.work.get(params.threadId)!.state !== 'active') throw new Error('This session is paused for quota and will continue automatically. Cancel its automatic continuation before sending new work.');
      if ((method === 'turn/start' || method === 'review/start') && this.work.get(params.threadId)?.state === 'active') {
        const existing = this.work.get(params.threadId)!;
        const last = await this.lastTurn(existing.threadId);
        if (last?.id === existing.turnId && last.status !== 'inProgress') { this.work.delete(existing.threadId); await this.persist(); }
        else throw new Error('This session already has an active turn. Steer or stop it before starting another.');
      }
      if (method === 'turn/start') return this.beginTurn(params);
      const result: any = await this.source.broker.request<T>(method, params);
      if (method === 'review/start') {
        const threadId = result?.reviewThreadId ?? params.threadId;
        const turnId = result?.turn?.id;
        if (typeof threadId === 'string' && typeof turnId === 'string') {
          this.work.set(threadId, { threadId, turnId, params: { threadId }, state: 'active' });
          await this.persist();
        }
      }
      return result;
    });
  }
  notification(method: string, params: any): Promise<void> {
    return this.serial(async () => {
      if (method === 'account/rateLimits/updated' || method === 'account/updated' || method === 'account/login/completed') {
        await this.checkExclusive(); return;
      }
      const work = this.work.get(params?.threadId);
      if (!work) return;
      if (work.state === 'starting') {
        if (['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) await this.recoverStart(work);
        return;
      }
      if (method === 'turn/started' && params.turn?.id !== work.turnId) {
        // Another client took over this thread. Never interrupt or continue it.
        this.work.delete(work.threadId); await this.persist();
      }
      if (method === 'turn/completed' && params.turn?.id === work.turnId) {
        if (work.state !== 'active' && params.turn.status === 'interrupted') work.state = 'paused';
        else this.work.delete(work.threadId);
        await this.persist();
      }
    });
  }
  check(): Promise<void> { return this.serial(() => this.checkExclusive()); }
  private async checkExclusive(): Promise<void> {
    if (this.source.status.state !== 'READY') { this.remainingPercent = null; return; }
    await this.readQuota();
    for (const work of [...this.work.values()]) {
      try {
        if (work.state === 'starting' && !await this.recoverStart(work)) continue;
        if (work.recover || work.state === 'interrupting') {
          const last = await this.lastTurn(work.threadId);
          if (!last || last.id !== work.turnId) { this.work.delete(work.threadId); await this.persist(); continue; }
          if (last.status !== 'inProgress') {
            if (last.status === 'interrupted' && work.state !== 'active') work.state = 'paused';
            else { this.work.delete(work.threadId); await this.persist(); continue; }
          }
          work.recover = false; await this.persist();
        }
        if (this.remainingPercent === null) continue;
        if (this.remainingPercent <= this.reservePercent && (work.state === 'active' || work.state === 'interrupting')) {
          work.state = 'interrupting'; await this.persist();
          try { await this.source.broker.request('turn/interrupt', { threadId: work.threadId, turnId: work.turnId }); }
          catch (error) {
            if (error instanceof RpcError && error.responseReceived) work.state = 'active';
            else work.recover = true;
            await this.persist(); throw error;
          }
        } else if (this.remainingPercent > this.reservePercent && work.state === 'paused') {
          const last = await this.lastTurn(work.threadId);
          if (!last || last.id !== work.turnId || last.status !== 'interrupted') {
            this.work.delete(work.threadId); await this.persist(); continue;
          }
          // Only retry after reconciling the latest turn: an ambiguous RPC failure
          // may have started a turn even if its response was lost.
          await this.source.broker.request('thread/resume', { threadId: work.threadId });
          const options = work.params;
          const params = { ...options, clientUserMessageId: randomUUID(), threadId: work.threadId, input: [{ type: 'text', text: 'Continue the previous task from where it was interrupted by quota protection. Check existing progress before repeating any actions.' }] };
          await this.beginTurn(params, work);
        }
      } catch (error) { this.report(error); }
    }
  }
  private async beginTurn(params: Record<string, any>, previous?: Work): Promise<any> {
    const options = { ...params, clientUserMessageId: params.clientUserMessageId ?? randomUUID() };
    // Persist intent before sending, so a lost response cannot orphan an accepted turn.
    const pending: Work = { threadId: params.threadId, turnId: '', params: options, state: 'starting' };
    this.work.set(pending.threadId, pending); await this.persist();
    try {
      const result: any = await this.source.broker.request('turn/start', options);
      if (!result?.turn?.id) throw new Error('Start did not return a turn ID; awaiting confirmation');
      pending.turnId = result.turn.id; pending.state = 'active'; await this.persist();
      return result;
    } catch (error) {
      // A daemon error response confirms rejection. Transport errors are ambiguous.
      if (error instanceof RpcError && error.responseReceived) {
        if (previous) this.work.set(previous.threadId, previous);
        else this.work.delete(pending.threadId);
        await this.persist();
      }
      throw error;
    }
  }
  private async recoverStart(work: Work): Promise<boolean> {
    const last = await this.lastTurn(work.threadId);
    const clientId = work.params.clientUserMessageId;
    if (!clientId || !last?.items?.some((item: any) => item.type === 'userMessage' && item.clientId === clientId)) {
      this.error = 'A turn start is awaiting confirmation. Automatic continuation is paused; cancel it in Settings to send new work.';
      return false;
    }
    if (last.status === 'inProgress') {
      work.turnId = last.id; work.state = 'active'; work.recover = false;
      await this.persist(); return true;
    }
    this.work.delete(work.threadId); await this.persist(); return false;
  }
  private async lastTurn(threadId: string): Promise<any> {
    const result: any = await this.source.broker.request('thread/read', { threadId, includeTurns: true });
    return result?.thread?.turns?.at(-1);
  }
  private async readQuota(): Promise<void> {
    this.remainingPercent = null;
    this.error = null;
    try {
      const response: any = await this.source.broker.request('account/rateLimits/read', {});
      const buckets: any[] = Object.entries(response?.rateLimitsByLimitId ?? {}).map(([id, bucket]: any) => ({ ...bucket, limitId: bucket?.limitId ?? id }));
      if (!buckets.length && response?.rateLimits) buckets.push(response.rateLimits);
      const bucket = buckets.find(bucket => bucket.limitId === 'codex') ?? buckets.find(bucket => !bucket.limitId);
      const window: Window | undefined = [bucket?.primary, bucket?.secondary].find(window => window?.windowDurationMins === 300);
      if (window && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && (window.resetsAt == null || window.resetsAt * 1000 > Date.now())) {
        this.remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
      }
      this.checkedAt = new Date().toISOString();
      if (this.remainingPercent === null) this.error = '5-hour quota is unavailable. Automatic continuation is waiting for a fresh quota reading.';
    } catch (error) { this.report(error); }
  }
  private report(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify({ reservePercent: this.reservePercent, work: [...this.work.values()] }), { encoding: 'utf8', mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
}
function validateReserve(value: unknown): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 99) throw new Error('Quota reserve must be an integer between 1 and 99 percent');
}
