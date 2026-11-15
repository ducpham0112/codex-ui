import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import type { AgentId, ClaudeAccount, ClaudeModel, ClaudeSession, ClaudeUsage } from '../../../../packages/shared/src/agents';
import { ALL_SESSIONS_ID } from './session-scope';
import { createId } from './id';
export const CLAUDE_MODELS: ClaudeModel[] = ['default', 'sonnet', 'opus', 'haiku'];
export type AgentFilter = AgentId | 'all';
export function mergedAgentSessions(codex: any[], claude: ClaudeSession[], projectId: string, filter: AgentFilter): any[] {
  return [
    ...(filter === 'claude' ? [] : codex.map(thread => ({ ...thread, agentId: 'codex', nativeId: thread.id }))),
    ...(filter === 'codex' ? [] : claude.filter(session => projectId === ALL_SESSIONS_ID || session.projectId === projectId).map(session => ({ ...session, id: `claude:${session.id}`, nativeId: session.id, name: session.title, cwd: session.projectRoot, status: session.status === 'awaiting_approval' ? 'approval' : session.status })))
  ].sort((a, b) => activityTime(b.updatedAt) - activityTime(a.updatedAt));
}
function activityTime(value: any): number { return typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value ?? '') || 0; }
export function claudeUsageMessage(usage: ClaudeUsage | null): string { return usage?.message || 'Claude usage percentages are unavailable from the official CLI. Check the official usage page.'; }
interface PendingTurn { prompt: string; requestId: string; }
class ClaudeHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
@Injectable({providedIn:'root'})
export class ClaudeService implements OnDestroy {
  readonly sessions = signal<ClaudeSession[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(() => this.sessions().find(session => session.id === this.selectedId()) ?? null);
  readonly account = signal<ClaudeAccount | null>(null);
  readonly usage = signal<ClaudeUsage | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly refreshing = signal(false);
  readonly drafts = signal<Record<string,string>>({});
  readonly pendingRevision = signal(0);
  readonly defaultModel = signal<ClaudeModel>(this.storedModel());
  readonly defaultAgent = signal<AgentId>(localStorage.getItem('agents.default') === 'claude' ? 'claude' : 'codex');
  readonly active = computed(() => this.sessions().some(session => ['running','awaiting_approval'].includes(session.status)));
  readonly subscriptionReady = computed(() => this.account()?.status === 'ready' && this.account()?.authMethod === 'claude.ai' && !this.account()?.apiBillingConfigured);
  readonly usageMessage = computed(() => claudeUsageMessage(this.usage()));
  readonly usageUrl = computed(() => this.usage()?.usageUrl || 'https://claude.ai/settings/usage');
  private poll?: ReturnType<typeof setTimeout>;
  private started = false;
  private destroyed = false;
  private refreshingSessions = false;
  private sessionRevision = 0;
  private controllers = new Set<AbortController>();
  private storedModel(): ClaudeModel { const value = localStorage.getItem('claude.defaultModel') as ClaudeModel; return CLAUDE_MODELS.includes(value) ? value : 'default'; }
  setDefaultModel(model: ClaudeModel): void { if (CLAUDE_MODELS.includes(model)) { this.defaultModel.set(model); localStorage.setItem('claude.defaultModel', model); } }
  setDefaultAgent(agent: AgentId): void { if(agent === 'claude' || agent === 'codex') { this.defaultAgent.set(agent); localStorage.setItem('agents.default',agent); } }
  draftFor(id: string): string { return this.drafts()[id] ?? localStorage.getItem(`claude.draft.${id}`) ?? ''; }
  updateDraft(id: string, value: string): void { this.drafts.update(drafts => ({...drafts,[id]:value})); localStorage.setItem(`claude.draft.${id}`, value); }
  pendingTurn(id: string): PendingTurn | null { this.pendingRevision(); try { const value = JSON.parse(localStorage.getItem(`claude.pending.${id}`) || 'null'); return typeof value?.requestId === 'string' && typeof value?.prompt === 'string' ? value : null; } catch { return null; } }
  start(): void { if(this.started || this.destroyed) return; this.started = true; document.addEventListener('visibilitychange', this.onVisibility); void this.tick(true); }
  private readonly onVisibility = () => { if(this.poll) clearTimeout(this.poll); if(document.visibilityState === 'visible') void this.tick(true); };
  private async tick(status = false): Promise<void> {
    if(this.destroyed) return;
    if(document.visibilityState === 'visible') await Promise.allSettled([this.refreshSessions(), ...(status ? [this.refreshStatus()] : [])]);
    if(this.destroyed) return;
    if(this.poll) clearTimeout(this.poll);
    this.poll = setTimeout(() => void this.tick(false), this.selected()?.status === 'running' || this.selected()?.status === 'awaiting_approval' ? 2000 : 15000);
  }
  async refreshStatus(): Promise<void> {
    if(this.refreshing() || this.destroyed) return; this.refreshing.set(true);
    try { const result = await this.request('/status'); this.account.set(result.account); this.usage.set(result.usage); }
    catch(error) { this.error.set(this.message(error)); }
    finally { this.refreshing.set(false); }
  }
  async refreshSessions(): Promise<void> {
    if(this.refreshingSessions || this.destroyed) return; this.refreshingSessions = true;
    const revision = this.sessionRevision;
    try { const result = await this.request('/sessions'); if(revision === this.sessionRevision) { this.sessions.set(result.sessions); if(result.usage) this.usage.set(result.usage); } }
    catch(error) { this.error.set(this.message(error)); }
    finally { this.refreshingSessions = false; }
  }
  select(id: string): void { this.selectedId.set(id); }
  async createSession(projectId: string, model: ClaudeModel): Promise<ClaudeSession | null> {
    return this.action(async () => { const result = await this.request('/sessions', {projectId,model}); this.accept(result.session); this.select(result.session.id); return result.session; });
  }
  async sendTurn(id: string, prompt: string): Promise<void> {
    if(!prompt.trim() || this.busy() || this.destroyed) return;
    const previous = this.pendingTurn(id);
    if(previous && previous.prompt !== prompt) { this.error.set('Retry the original prompt first to resolve its delivery status.'); return; }
    const pending = previous ?? {prompt, requestId:createId()};
    // Persist before posting: an interrupted response must never become a new turn on retry.
    localStorage.setItem(`claude.pending.${id}`, JSON.stringify(pending)); this.pendingRevision.update(x=>x+1);
    await this.action(async () => {
      try {
        const result = await this.request(`/sessions/${encodeURIComponent(id)}/turn`, pending); this.accept(result.session);
        localStorage.removeItem(`claude.pending.${id}`); this.pendingRevision.update(x=>x+1); this.updateDraft(id, '');
      } catch(error) {
        if(error instanceof ClaudeHttpError && error.status < 500) { localStorage.removeItem(`claude.pending.${id}`); this.pendingRevision.update(x=>x+1); }
        throw error;
      }
    });
  }
  async interrupt(id: string): Promise<void> { await this.action(async () => this.accept((await this.request(`/sessions/${encodeURIComponent(id)}/interrupt`, {})).session)); }
  async approve(id: string, key: string, allow: boolean): Promise<void> {
    await this.action(async () => { try { this.accept((await this.request(`/sessions/${encodeURIComponent(id)}/approvals/${encodeURIComponent(key)}`, {allow})).session); } catch(error) { await this.refreshSessions(); throw error; } });
  }
  async logout(): Promise<void> { await this.action(async () => { const result = await this.request('/logout', {}); this.account.set(result.account); this.usage.set(result.usage); }); }
  private accept(session: ClaudeSession): void { this.sessionRevision++; this.sessions.update(sessions => [session,...sessions.filter(item=>item.id!==session.id)]); }
  private async action<T>(run:()=>Promise<T>): Promise<T | null> { if(this.busy() || this.destroyed) return null; this.busy.set(true); this.error.set(''); try { return await run(); } catch(error) { this.error.set(this.message(error)); return null; } finally { this.busy.set(false); } }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'Claude request failed'; }
  private async request(route: string, body?: unknown): Promise<any> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/agents/claude${route}`, {method:body === undefined?'GET':'POST', credentials:'same-origin', cache:'no-store', signal:controller.signal, ...(body === undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      const result = await response.json();
      if(!response.ok) throw new ClaudeHttpError(result.error?.message || `Claude request failed (${response.status})`, response.status);
      return result;
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  ngOnDestroy(): void { this.destroyed = true; if(this.poll) clearTimeout(this.poll); document.removeEventListener('visibilitychange', this.onVisibility); for(const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
