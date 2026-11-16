import { createServer } from 'node:http';
import { BrowserHub } from '../src/websocket/hub.js';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { RpcError } from '../src/codex/rpc-broker.js';
import { QuotaProtection } from '../src/quota/protection.js';

async function setup() {
  const source = new EventEmitter() as any;
  source.status = { state: 'READY' };
  source.lastStatus = 'interrupted';
  let remaining: number | null = 80;
  let counter = 0;
  const calls: { method: string; params: any }[] = [];
  source.broker = { request: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', primary: remaining === null ? null : { usedPercent: 100 - remaining, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000) + 1000 }, secondary: { usedPercent: 99, windowDurationMins: 10080 } } };
    if (method === 'turn/start') return { turn: { id: `turn-${++counter}`, status: 'inProgress' } };
    if (method === 'thread/read') return { thread: { turns: [{ id: 'turn-1', status: source.lastStatus }] } };
    if (method === 'turn/interrupt' || method === 'thread/resume') return {};
    throw new Error(`Unexpected ${method}`);
  } };
  const file = join(await mkdtemp(join(tmpdir(), 'quota-')), 'state.json');
  const guard = await QuotaProtection.load(source, file);
  return { source, guard, calls, file, quota: (value: number | null) => { remaining = value; } };
}
const input = { threadId: 'web', input: [{ type: 'text', text: 'Do work' }], effort: 'high' };

describe('quota protection', () => {
  it('rejects a second start without losing protection of the active turn', async () => {
    const { guard, quota, source, calls } = await setup();
    source.lastStatus = 'inProgress';
    await guard.request('turn/start', input);
    await expect(guard.request('turn/start', input)).rejects.toThrow(/active/i);
    quota(20); await guard.check();
    expect(calls.filter(c => c.method === 'turn/interrupt').at(-1)?.params).toEqual({ threadId: 'web', turnId: 'turn-1' });
  });
  it('continues work when the interrupt response was lost but completion arrived', async () => {
    const { guard, quota, source, calls } = await setup();
    await guard.request('turn/start', input);
    const original = source.broker.request;
    source.broker.request = async (method: string, params: any) => {
      if (method === 'turn/interrupt') throw new RpcError(-32000, 'Timeout', undefined, false);
      return original(method, params);
    };
    quota(20); await guard.check();
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    source.broker.request = original;
    quota(80); await guard.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
  });

  it('recovers a continuation accepted before its response was lost', async () => {
    const { guard, quota, source, calls } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    const original = source.broker.request;
    let accepted: any;
    source.broker.request = async (method: string, params: any) => {
      if (method === 'turn/start') { accepted = params; throw new RpcError(-32000, 'Timeout', undefined, false); }
      if (method === 'thread/read' && accepted) return { thread: { turns: [{ id: 'continued-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: accepted.clientUserMessageId }] }] } };
      return original(method, params);
    };
    quota(80); await guard.check();
    expect(guard.snapshot().paused[0].state).toBe('starting');
    quota(20); await guard.check();
    expect(calls.filter(c => c.method === 'turn/interrupt').at(-1)?.params).toEqual({ threadId: 'web', turnId: 'continued-turn' });
  });

  it('cancels an already resumed turn even when the browser still thinks it is paused', async () => {
    const { guard, quota, calls } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    quota(80); await guard.check();
    await guard.cancel('web');
    expect(calls.filter(c => c.method === 'turn/interrupt').at(-1)?.params).toEqual({ threadId: 'web', turnId: 'turn-2' });
  });
  it('retries an interruption acknowledged before restart when the turn is still running', async () => {
    const { guard, quota, source, file, calls } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    source.lastStatus = 'inProgress';
    const restored = await QuotaProtection.load(source, file);
    await restored.check();
    expect(calls.filter(c => c.method === 'turn/interrupt')).toHaveLength(2);
  });
  it('recovers an accepted start after its response was lost without claiming an external turn', async () => {
    const { guard, quota, source, file, calls } = await setup();
    const original = source.broker.request;
    let accepted: any;
    let matching = false;
    source.broker.request = async (method: string, params: any) => {
      if (method === 'turn/start') { accepted = params; throw new RpcError(-32000, 'Response lost', undefined, false); }
      if (method === 'thread/read') return { thread: { turns: [{ id: 'accepted-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: matching ? accepted?.clientUserMessageId : 'external-client', content: params.input }] }] } };
      return original(method, params);
    };
    await expect(guard.request('turn/start', input)).rejects.toThrow('Response lost');
    const restored = await QuotaProtection.load(source, file);
    quota(20); await restored.check();
    expect(calls.filter(c => c.method === 'turn/interrupt')).toEqual([]);
    matching = true; await restored.check();
    expect(calls.filter(c => c.method === 'turn/interrupt').at(-1)?.params).toEqual({ threadId: 'web', turnId: 'accepted-turn' });
  });

  it('enforces the reserve at the browser RPC boundary', async () => {
    const { source, guard, quota } = await setup();
    const hub = new BrowserHub(createServer(), source, { projects: [] } as any, undefined, undefined, undefined, undefined, guard);
    const responses: any[] = [];
    const client = { readyState: 1, send: (raw: string) => responses.push(JSON.parse(raw)) };
    try {
      quota(30);
      await (hub as any).receive(client, JSON.stringify({ type: 'rpc.request', requestId: 'low', method: 'turn/start', params: input }));
      expect(responses[0]).toMatchObject({ type: 'rpc.error', requestId: 'low', error: { message: expect.stringContaining('Quota protection') } });
      quota(80);
      await (hub as any).receive(client, JSON.stringify({ type: 'rpc.request', requestId: 'ok', method: 'turn/start', params: input }));
      expect(responses[1]).toMatchObject({ type: 'rpc.response', result: { turn: { id: 'turn-1' } } });
    } finally { hub.close(); }
  });

  it('reconciles a missed interrupt notification and reloads the thread before continuing', async () => {
    const { guard, source, quota, calls } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    // No turn/completed notification reaches this server.
    quota(80); await guard.check();
    expect(guard.snapshot().paused).toEqual([]);
    expect(calls.filter(c => c.method === 'thread/resume')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
  });
  it('never continues on an expired snapshot or a failed read', async () => {
    const { guard, source, quota, calls } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    const original = source.broker.request;
    source.broker.request = async (method: string, params: any) => method === 'account/rateLimits/read'
      ? { rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1 } } }
      : original(method, params);
    await guard.check();
    expect(guard.snapshot().paused).toHaveLength(1);
    source.broker.request = async () => { throw new Error('offline'); };
    await guard.check();
    expect(guard.snapshot().error).toContain('offline');
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
  });
  it('retries failed interruptions without losing ownership', async () => {
    const { guard, source, quota } = await setup();
    await guard.request('turn/start', input);
    const original = source.broker.request;
    source.broker.request = async (method: string, params: any) => {
      if (method === 'turn/interrupt') throw new Error('interrupt failed');
      return original(method, params);
    };
    quota(20); await guard.check();
    expect(guard.snapshot().error).toContain('interrupt failed');
    source.broker.request = original;
    await guard.check();
    expect(guard.snapshot().paused).toHaveLength(1);
  });

  it('stops at the default 30% boundary, only owned turns, then continues once above reserve', async () => {
    const { guard, source, calls, quota } = await setup();
    await guard.request('turn/start', input);
    await guard.notification('turn/started', { threadId: 'cli', turn: { id: 'cli-turn' } });
    quota(30); await guard.check();
    expect(calls.filter(c => c.method === 'turn/interrupt')).toEqual([{ method: 'turn/interrupt', params: { threadId: 'web', turnId: 'turn-1' } }]);
    expect(guard.snapshot().paused[0].threadId).toBe('web');
    source.lastStatus = 'inProgress';
    quota(80); await guard.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    source.lastStatus = 'interrupted';
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    await guard.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
    expect(calls.filter(c => c.method === 'turn/start')[1].params).toMatchObject({ threadId: 'web', effort: 'high', input: [{ type: 'text', text: expect.stringContaining('quota') }] });
    expect(guard.snapshot().paused).toEqual([]);
  });
  it('blocks new work at configured reserve and persists settings', async () => {
    const { guard, quota, file } = await setup();
    await guard.setReserve(40);
    quota(40);
    await expect(guard.request('turn/start', input)).rejects.toThrow(/quota/i);
    expect(JSON.parse(await readFile(file, 'utf8')).reservePercent).toBe(40);
    await expect(guard.setReserve(100)).rejects.toThrow();
    await expect(guard.setReserve(NaN)).rejects.toThrow();
  });
  it('does not resume manually stopped or naturally completed work', async () => {
    const { guard, quota, calls } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    await guard.request('turn/interrupt', { threadId: 'web', turnId: 'turn-1' });
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    quota(80); await guard.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-2', status: 'completed' } });
    quota(80); await guard.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
  });
  it('keeps paused work through restart and never resumes on missing quota', async () => {
    const { guard, quota, calls, source, file } = await setup();
    await guard.request('turn/start', input);
    quota(20); await guard.check();
    await guard.notification('turn/completed', { threadId: 'web', turn: { id: 'turn-1', status: 'interrupted' } });
    const restored = await QuotaProtection.load(source, file);
    expect(restored.snapshot().paused).toHaveLength(1);
    quota(null); await restored.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(1);
    quota(80); await restored.check();
    expect(calls.filter(c => c.method === 'turn/start')).toHaveLength(2);
  });
  it('does not interrupt an external turn that replaced an owned turn', async () => {
    const { guard, quota, calls } = await setup();
    await guard.request('turn/start', input);
    await guard.notification('turn/started', { threadId: 'web', turn: { id: 'external' } });
    quota(20); await guard.check();
    expect(calls.filter(c => c.method === 'turn/interrupt')).toEqual([]);
  });
});
