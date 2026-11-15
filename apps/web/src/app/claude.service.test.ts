// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClaudeService, mergedAgentSessions, claudeUsageMessage } from './claude.service';
const session = (id = 'same', projectId = 'p') => ({ id, agentId: 'claude', projectId, title: 'Claude work', model: 'sonnet', status: 'idle', updatedAt: '2026-11-15T00:00:00Z', items: [], approvals: [] } as any);
let service: ClaudeService;
beforeEach(() => { localStorage.clear(); service = new ClaudeService(); });
afterEach(() => { service.ngOnDestroy(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('namespaces mixed identities and filters each agent within the project', () => {
  const entries = mergedAgentSessions([{ id: 'same', name: 'Codex work' }], [session(), session('other', 'q')], 'p', 'all');
  expect(entries.map(x => [x.id, x.agentId, x.nativeId])).toEqual([['claude:same', 'claude', 'same'], ['same', 'codex', 'same']]);
  expect(mergedAgentSessions([], [session()], 'p', 'codex')).toEqual([]);
});
it('isolates persisted Claude drafts from Codex and from other sessions', () => {
  localStorage.setItem('codex.draft.same', 'codex text');
  service.updateDraft('same', 'Claude text'); service.updateDraft('other', 'another');
  expect(service.draftFor('same')).toBe('Claude text');
  expect(new ClaudeService().draftFor('other')).toBe('another');
  expect(localStorage.getItem('codex.draft.same')).toBe('codex text');
});
it('preserves request ID after ambiguous transport failure and never retries automatically', async () => {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); if (bodies.length === 1) throw Error('connection lost'); return new Response(JSON.stringify({ session: session() })); });
  service.updateDraft('same', 'hello');
  await service.sendTurn('same', 'hello');
  expect(bodies).toHaveLength(1); expect(service.draftFor('same')).toBe('hello');
  await service.sendTurn('same', 'hello');
  expect(bodies[1].requestId).toBe(bodies[0].requestId);
  expect(service.draftFor('same')).toBe('');
});
it('keeps a retry ID across reloads and rejects changing an unresolved prompt', async () => {
  vi.stubGlobal('fetch', async () => { throw Error('lost'); });
  await service.sendTurn('same', 'first');
  const pending = service.pendingTurn('same'); const reloaded = new ClaudeService();
  expect(reloaded.pendingTurn('same')).toEqual(pending);
  await reloaded.sendTurn('same', 'different');
  expect(reloaded.error()).toContain('original'); reloaded.ngOnDestroy();
});
it('shows honest account usage fallback instead of guessed percentages', () => {
  expect(claudeUsageMessage(null)).toContain('unavailable');
  expect(claudeUsageMessage({ message: 'Use the official usage page.' } as any)).toBe('Use the official usage page.');
});
it('persists the default agent independently of the selected project or session', () => {
  expect(service.defaultAgent()).toBe('codex');
  service.setDefaultAgent('claude');
  const reloaded = new ClaudeService();
  expect(reloaded.defaultAgent()).toBe('claude'); reloaded.ngOnDestroy();
});
it('does not let an older session refresh overwrite an accepted turn', async () => {
  let deliver: (response: Response) => void = () => {};
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if(init.method === 'GET') return new Promise<Response>(resolve => { deliver = resolve; });
    return new Response(JSON.stringify({ session: { ...session(), status:'running' } }));
  });
  const refresh = service.refreshSessions();
  await service.sendTurn('same', 'hello');
  deliver(new Response(JSON.stringify({sessions:[session()]}))); await refresh;
  expect(service.sessions()[0].status).toBe('running');
});
it('reports stale approvals and refreshes without resubmitting the decision', async () => {
  let posts = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { if(init.method === 'POST') { posts++; return new Response(JSON.stringify({error:{message:'Approval is stale'}}), {status:409}); } return new Response(JSON.stringify({sessions:[session()]})); });
  await service.approve('same', 'stale-key', true);
  expect(posts).toBe(1); expect(service.error()).toContain('stale');
});
it('does not poll while hidden and cleans scheduled polling on destruction', async () => {
  vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable:true, value:'hidden' });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); service.start();
  await vi.advanceTimersByTimeAsync(30000); expect(fetcher).not.toHaveBeenCalled();
  service.ngOnDestroy(); expect(vi.getTimerCount()).toBe(0);
  Object.defineProperty(document, 'visibilityState', { configurable:true, value:'visible' });
});

it('updates runtime usage during visible polling without repeated status probes', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const calls: string[] = [];
  let polled = false;
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const usage = { status: 'unavailable', source: 'claude-cli', message: 'Unknown allowance', usageUrl: 'https://claude.ai/settings/usage', ...(polled ? { observedLimit: { status: 'rejected', resetsAt: 1900000000, observedAt: '2026-11-15T00:00:00Z' } } : {}) };
    return new Response(JSON.stringify(url.endsWith('/status') ? { account: { status: 'ready' }, usage } : { sessions: [{ ...session(), status: 'running' }], usage }));
  });
  service.select('same'); service.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(service.usage()?.observedLimit).toBeUndefined();
  polled = true;
  await vi.advanceTimersByTimeAsync(2000);
  expect(service.usage()?.observedLimit).toMatchObject({ status: 'rejected', resetsAt: 1900000000 });
  expect(calls.filter(url => url.endsWith('/status'))).toHaveLength(1);
  expect(calls.filter(url => url.endsWith('/sessions'))).toHaveLength(2);
});
