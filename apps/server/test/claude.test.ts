import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rename, symlink, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgent } from '../src/agents/claude.js';
import { handleAgentsApi } from '../src/http/agents-api.js';

const fixtureCli = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const agents: ClaudeAgent[] = [];
const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive:true, force:true })));
});

async function fixture(options: Record<string, unknown> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-test-'))); directories.push(dir);
  const root = join(dir, 'project'); await mkdir(root);
  const persistencePath = join(dir, 'state', 'claude.json');
  const log = join(dir, 'cli.log');
  const project = { id: 'demo', name: 'Demo', root };
  const projects = { get: (id: string) => id === 'demo' ? project : undefined };
  const settings = { persistencePath, projects, command: process.execPath, args: [fixtureCli], env: { ...process.env, CLAUDE_FIXTURE_LOG: log } as NodeJS.ProcessEnv, ...options };
  const agent = await ClaudeAgent.load(settings); agents.push(agent);
  return { agent, settings, root, dir, projects, log, persistencePath };
}

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

describe('Claude CLI runtime', () => {
  it('rolls back failed creation when the state directory cannot be created', async () => {
    const { agent, persistencePath } = await fixture();
    const parent = join(persistencePath, '..');
    await writeFile(parent, 'blocked');
    await expect(agent.createSession('demo')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(agent.snapshot().sessions).toEqual([]);
    await rm(parent); await mkdir(parent);
    await agent.createSession('demo');
    expect(agent.snapshot().sessions).toHaveLength(1);
  });
  it('retries a failed pre-spawn persistence exactly once after filesystem repair', async () => {
    const { agent, persistencePath, log } = await fixture();
    const session = await agent.createSession('demo');
    const saved = persistencePath + '.saved';
    await rename(persistencePath, saved); await mkdir(persistencePath);
    await expect(agent.startTurn(session.id, 'hello', 'retry-storage')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(agent.isProjectActive(session.projectRoot)).toBe(false);
    expect(agent.getSession(session.id)).toMatchObject({ status: 'idle', items: [] });
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(persistencePath, { recursive: true }); await rename(saved, persistencePath);
    await agent.startTurn(session.id, 'hello', 'retry-storage');
    await until(() => agent.getSession(session.id).status === 'idle');
    await agent.startTurn(session.id, 'hello', 'retry-storage');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.frame.type === 'user')).toHaveLength(1);
    expect(agent.getSession(session.id).items.filter(item => item.role === 'user')).toHaveLength(1);
  });
  it('fails closed without sending approval if its commit fails', async () => {
    const { agent, persistencePath, log } = await fixture();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'approval', 'approval-storage');
    await until(() => agent.getSession(session.id).status === 'awaiting_approval');
    const approval = agent.getSession(session.id).approvals[0];
    const saved = persistencePath + '.saved';
    await rename(persistencePath, saved); await mkdir(persistencePath);
    await expect(agent.respondApproval(session.id, approval.requestKey, true)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await until(() => !agent.isProjectActive(session.projectRoot));
    expect(agent.getSession(session.id)).toMatchObject({ status: 'error', approvals: [] });
    expect(agent.getSession(session.id).error).toMatch(/storage|persist/i);
    expect((await readFile(log, 'utf8'))).not.toContain('"type":"control_response"');
    expect(JSON.parse(await readFile(saved, 'utf8')).sessions[0].items[0].text).toBe('approval');
    await rm(persistencePath, { recursive: true }); await rename(saved, persistencePath);
    await expect(agent.respondApproval(session.id, approval.requestKey, true)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
  });
  it('releases the writer after terminal persistence fails and preserves durable history', async () => {
    const { agent, persistencePath } = await fixture();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'hold', 'finish-storage');
    const saved = persistencePath + '.saved';
    await rename(persistencePath, saved); await mkdir(persistencePath);
    await expect(agent.interrupt(session.id)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(agent.isProjectActive(session.projectRoot)).toBe(false);
    expect(agent.getSession(session.id)).toMatchObject({ status: 'error', approvals: [] });
    expect(agent.getSession(session.id).error).toMatch(/storage|persist/i);
    expect(JSON.parse(await readFile(saved, 'utf8')).sessions[0].items[0].text).toBe('hold');
    await rm(persistencePath, { recursive: true }); await rename(saved, persistencePath);
    await agent.startTurn(session.id, 'hello', 'after-storage');
    await until(() => agent.getSession(session.id).status === 'idle');
    expect(agent.getSession(session.id).error).toBeUndefined();
  });
  it('clears another account runtime limits during the pre-turn official auth probe', async () => {
    const { agent, settings } = await fixture();
    await agent.refreshAccount();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'limit', 'old-identity');
    await until(() => agent.getSession(session.id).status === 'idle');
    settings.env.CLAUDE_FIXTURE_EMAIL = 'new@example.com';
    await agent.startTurn(session.id, 'hold', 'new-identity');
    expect(agent.snapshot().usage.observedLimit).toBeUndefined();
    await agent.interrupt(session.id);
  });

  it('deduplicates prototype-like request ids after a completed turn', async () => {
    const { agent } = await fixture();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'hello', '__proto__');
    await until(() => agent.getSession(session.id).status === 'idle');
    await agent.startTurn(session.id, 'hello', '__proto__');
    expect(agent.getSession(session.id).items.filter(item => item.role === 'user')).toHaveLength(1);
  });
  it('holds the writer guard until the interrupted CLI actually exits', async () => {
    const { agent, settings, log } = await fixture();
    settings.env.CLAUDE_FIXTURE_SLOW_EXIT = '1';
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'hold', 'slow');
    await until(() => agent.getSession(session.id).status === 'running');
    // Wait for CLI initialization, so its delayed-exit handler is installed.
    await until(() => agent.getSession(session.id).items.length === 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    const interrupt = agent.interrupt(session.id);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(agent.isProjectActive(session.projectRoot)).toBe(true);
    await interrupt;
    expect((await readFile(log, 'utf8'))).toContain('"exited":true');
    expect(agent.isProjectActive(session.projectRoot)).toBe(false);
  });

  it('refuses API/helper authentication before sending a subscription prompt', async () => {
    const { agent, settings } = await fixture();
    settings.env.CLAUDE_FIXTURE_AUTH_METHOD = 'api_key_helper';
    const session = await agent.createSession('demo');
    await expect(agent.startTurn(session.id, 'hello', 'billing')).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
    expect(agent.getSession(session.id).items).toHaveLength(0);
  });

  it('keeps a full storage index readable and fails the turn explicitly', async () => {
    const { agent, settings } = await fixture({ maxStorageBytes: 32 * 1024 });
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'fill', 'capacity');
    await until(() => agent.getSession(session.id).status === 'error');
    expect(agent.getSession(session.id).error).toMatch(/storage|history|capacity/i);
    const restarted = await ClaudeAgent.load(settings); agents.push(restarted);
    expect(restarted.getSession(session.id).status).toBe('error');
  });

  it('clears observed limits when the official CLI reports a different account', async () => {
    const { agent, settings } = await fixture();
    await agent.refreshAccount();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'limit', 'account-limit');
    await until(() => agent.getSession(session.id).status === 'idle');
    expect(agent.snapshot().usage.observedLimit).toBeDefined();
    settings.env.CLAUDE_FIXTURE_EMAIL = 'other@example.com';
    await agent.refreshAccount();
    expect(agent.snapshot().usage.observedLimit).toBeUndefined();
  });
  it('initializes before streaming, persists final text without delta duplication, and explicitly resumes', async () => {
    const { agent, settings, persistencePath, log } = await fixture();
    const session = await agent.createSession('demo', 'sonnet');
    const observed: string[] = [];
    agent.on('snapshot', (snapshot) => observed.push(snapshot.sessions[0]?.status));
    await agent.startTurn(session.id, 'hello', 'request1');
    await until(() => agent.getSession(session.id).status === 'idle');
    expect(agent.getSession(session.id).items.filter((item) => item.kind === 'message' && item.role === 'assistant').map((item) => item.text)).toEqual(['Hello world']);
    expect(JSON.parse(await readFile(persistencePath, 'utf8')).sessions[0].status).toBe('idle');
    expect(observed).toContain('running');
    const restarted = await ClaudeAgent.load(settings); agents.push(restarted);
    await restarted.startTurn(session.id, 'again', 'request2');
    await until(() => restarted.getSession(session.id).status === 'idle');
    expect(restarted.getSession(session.id).items.at(-1)?.text).toBe('Resumed');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.some((call) => call.args.includes(`--resume=${session.nativeSessionId}`))).toBe(true);
    expect(calls[0].frame.request.subtype).toBe('initialize');
  });

  it.each([true, false])('durably routes native permission decisions (allow=%s) and rejects stale approvals', async (allow) => {
    const { agent, persistencePath } = await fixture();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'approval', 'approve');
    await until(() => agent.getSession(session.id).status === 'awaiting_approval');
    const approval = agent.getSession(session.id).approvals[0];
    expect(JSON.parse(await readFile(persistencePath, 'utf8')).sessions[0].approvals[0].requestKey).toBe(approval.requestKey);
    await agent.respondApproval(session.id, approval.requestKey, allow);
    await until(() => agent.getSession(session.id).status === 'idle');
    expect(agent.getSession(session.id).items.some((item) => item.kind === 'tool' && item.output === (allow ? 'hello' : 'Denied'))).toBe(true);
    expect(agent.getSession(session.id).items.at(-1)?.text).toBe(allow ? 'Allowed' : 'Denied');
    await expect(agent.respondApproval(session.id, approval.requestKey, true)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
  });

  it('deduplicates durable request ids, blocks same-project writers and cancels only owned work', async () => {
    const { agent, settings } = await fixture();
    const one = await agent.createSession('demo'); const two = await agent.createSession('demo');
    await agent.startTurn(one.id, 'hold', 'same');
    expect(agent.isProjectActive(join(one.projectRoot, 'subdirectory'))).toBe(true);
    await agent.startTurn(one.id, 'hold', 'same');
    expect(agent.getSession(one.id).items.filter((item) => item.role === 'user')).toHaveLength(1);
    await expect(agent.startTurn(two.id, 'second', 'other')).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    await expect(agent.logout()).rejects.toMatchObject({ code: 'AGENT_BUSY' });
    await agent.interrupt(one.id);
    expect(agent.getSession(one.id).status).toBe('interrupted');
    const restart = await ClaudeAgent.load(settings); agents.push(restart);
    await restart.startTurn(one.id, 'hold', 'same');
    expect(restart.getSession(one.id).status).toBe('interrupted');
    expect(restart.isProjectActive(settings.projects.get('demo')!.root)).toBe(false);
  });

  it('marks crashed active sessions interrupted on load and expires persisted approval keys', async () => {
    const { agent, settings } = await fixture(); const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'approval', 'crash');
    await until(() => agent.getSession(session.id).approvals.length === 1);
    const key = agent.getSession(session.id).approvals[0].requestKey;
    const restart = await ClaudeAgent.load(settings); agents.push(restart);
    expect(restart.getSession(session.id).status).toBe('interrupted');
    expect(restart.getSession(session.id).approvals).toEqual([]);
    await expect(restart.respondApproval(session.id, key, true)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
  });

  it.each(['malformed', 'oversized'])('fails closed on %s stream frames', async (prompt) => {
    const { agent } = await fixture(); const session = await agent.createSession('demo');
    await agent.startTurn(session.id, prompt, prompt);
    await until(() => agent.getSession(session.id).status === 'error');
    expect(agent.isProjectActive(session.projectRoot)).toBe(false);
    expect(agent.getSession(session.id).error).toMatch(/protocol|frame/i);
  });

  it('redacts account probes, reports missing CLI independently, and keeps quota unavailable beside observed limits', async () => {
    const { agent } = await fixture();
    await agent.refreshAccount();
    expect(agent.snapshot().account).toMatchObject({ available: true, loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com' });
    expect(JSON.stringify(agent.snapshot())).not.toContain('secret');
    expect(agent.snapshot().usage.status).toBe('unavailable');
    const session = await agent.createSession('demo'); await agent.startTurn(session.id, 'limit', 'limit');
    await until(() => agent.getSession(session.id).status === 'idle');
    expect(agent.snapshot().usage.observedLimit).toMatchObject({ status: 'rejected' });
    expect(agent.snapshot().usage.status).toBe('unavailable');
    const missing = await fixture({ command: '/private/tmp/no-such-claude-command', args: [] });
    await missing.agent.refreshAccount();
    expect(missing.agent.snapshot().account).toMatchObject({ available: false, status: 'unavailable' });
  });

  it('revalidates registered canonical roots before creating or resuming and consults external writer hook', async () => {
    const { agent, root, dir } = await fixture();
    await expect(agent.createSession('missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const session = await agent.createSession('demo');
    await rename(root, join(dir, 'old')); await symlink(join(dir, 'old'), root);
    await expect(agent.startTurn(session.id, 'unsafe', 'unsafe')).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    const busy = await fixture({ isProjectBusy: () => true }); const other = await busy.agent.createSession('demo');
    await expect(busy.agent.startTurn(other.id, 'hello', 'busy')).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
  });
});

describe('Claude HTTP API', () => {
  async function api() {
    const f = await fixture();
    const server = createServer((request, response) => void handleAgentsApi(request, response, f.agent, f.projects, 'https://ui.example'));
    servers.push(server); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/agents/claude`;
    const post = (path: string, body: unknown, origin = 'https://ui.example') => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    return { ...f, url, post };
  }
  it('exposes create/detail/turn/status without replaying requests', async () => {
    const { post, url, agent } = await api();
    const create = await post('/sessions', { projectId: 'demo', model: 'haiku' }); expect(create.status).toBe(201);
    const { session } = await create.json();
    expect((await (await fetch(`${url}/sessions/${session.id}`)).json()).session.model).toBe('haiku');
    expect((await post(`/sessions/${session.id}/turn`, { prompt: 'hello', requestId: 'web1' })).status).toBe(202);
    await until(() => agent.getSession(session.id).status === 'idle');
    expect((await (await fetch(`${url}/sessions`)).json()).sessions).toHaveLength(1);
    expect((await (await fetch(`${url}/status`)).json()).usage.status).toBe('unavailable');
  });

  it('delivers cached runtime usage with session polling without another CLI auth probe', async () => {
    const { agent, settings, post, url } = await api();
    const session = await agent.createSession('demo');
    await agent.startTurn(session.id, 'limit', 'polled-limit');
    await until(() => agent.getSession(session.id).status === 'idle');
    settings.command = '/private/tmp/missing-auth-cli';
    const result = await (await fetch(url + '/sessions')).json();
    expect(result.usage?.observedLimit).toMatchObject({ status: 'rejected', resetsAt: 1900000000 });
    expect(result.sessions).toHaveLength(1);
    const manual = await (await fetch(url + '/status')).json();
    expect(manual.account.status).toBe('unavailable');
  });
  it('bounds and validates request bodies, origins, methods, models and project bindings', async () => {
    const { post, url } = await api();
    expect((await post('/sessions', { projectId: 'demo' }, 'https://evil.example')).status).toBe(403);
    expect((await post('/sessions', { projectId: 'demo', root: '/' })).status).toBe(400);
    expect((await post('/sessions', { projectId: 'missing' })).status).toBe(404);
    expect((await post('/sessions', { projectId: 'demo', model: '--bad' })).status).toBe(400);
    expect((await post('/sessions', { projectId: 'demo', extra: 'x'.repeat(300_000) })).status).toBe(413);
    expect((await fetch(url + '/sessions', { method: 'DELETE' })).status).toBe(405);
    expect((await fetch(url + '/logout', { method: 'POST', body: '{}' })).status).toBe(415);
  });
});
