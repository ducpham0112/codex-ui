import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { ClaudeAccount, ClaudeModel, ClaudeSession, ClaudeSnapshot, ClaudeUsage } from '@codex-control/shared';
import type { ProjectRegistry } from '../config/projects.js';

const MAX_FRAME = 1024 * 1024;
const MAX_SESSIONS = 1000;
const MAX_ITEMS = 20_000;
const MAX_CONCURRENCY = 4;
const MAX_STORAGE_BYTES = 64 * 1024 * 1024;
const ACTIVE = new Set(['running', 'awaiting_approval']);
const MODELS = new Set(['default', 'sonnet', 'opus', 'haiku']);
const loginInstructions = 'On the server host or in the container, run claude auth login using the same user and CLAUDE_CONFIG_DIR, then Check status.';
const usageDefault = (): ClaudeUsage => ({ status: 'unavailable', source: 'claude-cli', message: 'Subscription allowance is unavailable through this integration. Runtime limit observations are shown separately.', usageUrl: 'https://claude.ai/settings/usage' });
const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const now = () => new Date().toISOString();

export class ClaudeAgentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface ClaudeAgentOptions {
  persistencePath: string;
  projects: Pick<ProjectRegistry, 'get'>;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  isProjectBusy?: (root: string) => boolean;
  /** Optional deployment storage budget, never above the index read ceiling. */
  maxStorageBytes?: number;
}
interface StoredSession extends ClaudeSession { requestIds: Record<string, string>; hasNativeHistory: boolean }
interface Run {
  generation: string;
  child: ChildProcessWithoutNullStreams;
  initializeId: string;
  prompt: string;
  buffer: string;
  initialized: boolean;
  finished: boolean;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  streamedItemId?: string;
  closed: Promise<void>;
}

/** Owns only app-created CLI processes. Native user/project settings and hooks remain trusted CLI inputs. */
export class ClaudeAgent extends EventEmitter {
  private sessions: StoredSession[] = [];
  private publishedSessions: ClaudeSession[] = [];
  private persistedState = JSON.stringify({ version: 1, sessions: [] });
  private accountIdentity?: string;
  private readonly runtimeStorageErrors = new Map<string, string>();
  private account: ClaudeAccount = { status: 'unknown', available: false, loginInstructions };
  private usage: ClaudeUsage = usageDefault();
  private runs = new Map<string, Run>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private constructor(private readonly options: ClaudeAgentOptions) { super(); }

  static async load(options: ClaudeAgentOptions): Promise<ClaudeAgent> {
    const agent = new ClaudeAgent(options);
    try {
      const raw = await readFile(options.persistencePath, 'utf8');
      if (Buffer.byteLength(raw) > MAX_STORAGE_BYTES) throw new Error('Claude session index is too large');
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS) throw new Error('Unsupported Claude session index');
      agent.sessions = data.sessions;
      for (const session of agent.sessions) {
        if (typeof session.id !== 'string' || session.agentId !== 'claude' || typeof session.nativeSessionId !== 'string' || typeof session.projectId !== 'string' || typeof session.projectRoot !== 'string' || !Array.isArray(session.items) || !Array.isArray(session.approvals) || !session.requestIds || typeof session.requestIds !== 'object') throw new Error('Invalid Claude session index');
        if (ACTIVE.has(session.status)) { session.status = 'interrupted'; session.error = 'Server restarted during a turn. Send a new message to resume explicitly.'; session.updatedAt = now(); }
        session.approvals = [];
      }
      await agent.persist(true);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return agent;
  }

  private visibleSession(session: ClaudeSession): ClaudeSession {
    const error = this.runtimeStorageErrors.get(session.id);
    return error ? { ...session, status: 'error', approvals: [], error } : session;
  }
  snapshot(): ClaudeSnapshot { return structuredClone({ account: this.account, sessions: this.publishedSessions.map(session => this.visibleSession(session)), usage: this.usage }); }
  getSession(id: string): ClaudeSession {
    const session = this.publishedSessions.find(entry => entry.id === id);
    if (!session) throw new ClaudeAgentError(404, 'SESSION_NOT_FOUND', 'Claude session not found');
    return structuredClone(this.visibleSession(session));
  }
  isProjectActive(root: string): boolean {
    const a = resolve(root);
    return this.sessions.some(session => {
      const b = resolve(session.projectRoot);
      return ACTIVE.has(session.status) && (a === b || a.startsWith(b + sep) || b.startsWith(a + sep));
    });
  }
  private find(id: string): StoredSession {
    const session = this.sessions.find((entry) => entry.id === id);
    if (!session) throw new ClaudeAgentError(404, 'SESSION_NOT_FOUND', 'Claude session not found');
    return session;
  }
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task); this.queue = result.catch(() => undefined); return result;
  }
  private async validateProject(projectId: string, expectedRoot?: string): Promise<string> {
    const project = this.options.projects.get(projectId);
    if (!project) throw new ClaudeAgentError(404, 'PROJECT_NOT_FOUND', 'Registered project not found');
    try {
      const canonical = await realpath(project.root);
      if (canonical !== project.root || (expectedRoot && expectedRoot !== canonical) || !(await stat(canonical)).isDirectory()) throw new Error('Changed root');
      return canonical;
    } catch { throw new ClaudeAgentError(409, 'PROJECT_CHANGED', 'Registered canonical project directory changed or is unavailable'); }
  }
  createSession(projectId: string, model: ClaudeModel = 'default'): Promise<ClaudeSession> {
    return this.exclusive(async () => {
      if (this.closing) throw new ClaudeAgentError(503, 'AGENT_CLOSED', 'Claude runtime is shutting down');
      if (!MODELS.has(model)) throw new ClaudeAgentError(400, 'INVALID_MODEL', 'Unsupported Claude model alias');
      if (this.sessions.length >= MAX_SESSIONS) throw new ClaudeAgentError(409, 'SESSION_LIMIT', 'Claude session index is full');
      const root = await this.validateProject(projectId); const id = randomUUID(); const timestamp = now();
      this.sessions.push({ id, agentId: 'claude', nativeSessionId: id, projectId, projectRoot: root, title: 'New Claude session', model, status: 'idle', createdAt: timestamp, updatedAt: timestamp, items: [], approvals: [], requestIds: {}, hasNativeHistory: false });
      await this.persist(); return this.getSession(id);
    });
  }
  startTurn(id: string, prompt: string, requestId: string): Promise<ClaudeSession> {
    return this.exclusive(async () => {
      const session = this.find(id);
      if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 128 * 1024 || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new ClaudeAgentError(400, 'INVALID_TURN', 'A bounded prompt and requestId are required');
      const previous = Object.hasOwn(session.requestIds, requestId) ? session.requestIds[requestId] : undefined;
      if (previous !== undefined) {
        if (previous !== prompt) throw new ClaudeAgentError(409, 'REQUEST_ID_CONFLICT', 'requestId was already used for a different prompt');
        return this.getSession(id);
      }
      if (this.closing) throw new ClaudeAgentError(503, 'AGENT_CLOSED', 'Claude runtime is shutting down');
      const root = await this.validateProject(session.projectId, session.projectRoot);
      const authentication = object(JSON.parse((await this.probe(['auth', 'status', '--json'], root)).output));
      this.updateAccountIdentity(authentication);
      if (authentication.loggedIn !== true || authentication.authMethod !== 'claude.ai') throw new ClaudeAgentError(409, 'SUBSCRIPTION_REQUIRED', 'Sign in with your Claude subscription using the official CLI. API/helper authentication is not used for subscription sessions.');
      if (this.isProjectActive(root) || this.options.isProjectBusy?.(root)) throw new ClaudeAgentError(409, 'PROJECT_BUSY', 'Another app-managed agent is working in this project');
      if (this.runs.size >= MAX_CONCURRENCY) throw new ClaudeAgentError(409, 'AGENT_BUSY', 'Claude concurrency limit reached');
      if (session.items.length > MAX_ITEMS - 100 || Object.keys(session.requestIds).length >= 2000) throw new ClaudeAgentError(409, 'SESSION_LIMIT', 'Claude session history is full');
      const env = this.environment();
      if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) throw new ClaudeAgentError(409, 'API_BILLING_CONFIGURED', 'Subscription execution requires removing host API billing configuration before starting Claude');
      Object.defineProperty(session.requestIds, requestId, { value: prompt, enumerable: true, configurable: true, writable: true });
      session.status = 'running'; session.error = undefined; session.approvals = []; session.updatedAt = now();
      if (!session.items.length) session.title = prompt.trim().slice(0, 80);
      session.items.push({ id: randomUUID(), kind: 'message', role: 'user', text: prompt, createdAt: now() });
      await this.persist();
      this.runtimeStorageErrors.delete(id);
      const args = [...(this.options.args ?? []), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', session.hasNativeHistory ? `--resume=${session.nativeSessionId}` : `--session-id=${session.nativeSessionId}`];
      if (session.model !== 'default') args.push('--model', session.model);
      const child = spawn(this.options.command ?? process.env.CLAUDE_BIN ?? 'claude', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const run: Run = { child, generation: randomUUID(), initializeId: randomUUID(), prompt, buffer: '', initialized: false, finished: false, closed: new Promise((resolve) => child.once('close', () => resolve())) };
      this.runs.set(id, run);
      run.timer = setTimeout(() => this.scheduleFailure(session, run, 'Claude protocol initialization timed out'), 60_000); run.timer.unref();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (run.finished) return;
        child.stdout.pause();
        const pendingFrames: Record<string, any>[] = [];
        run.buffer += chunk;
        let index: number;
        while ((index = run.buffer.indexOf('\n')) >= 0) {
          const line = run.buffer.slice(0, index); run.buffer = run.buffer.slice(index + 1);
          if (Buffer.byteLength(line) > MAX_FRAME) { this.scheduleFailure(session, run, 'Claude protocol frame exceeded limit'); return; }
          if (!line.trim()) continue;
          let frame: unknown; try { frame = JSON.parse(line); } catch { this.scheduleFailure(session, run, 'Malformed Claude protocol frame'); return; }
          pendingFrames.push(object(frame));
        }
        if (Buffer.byteLength(run.buffer) > MAX_FRAME) this.scheduleFailure(session, run, 'Claude protocol frame exceeded limit');
        void this.exclusive(async () => { for (const frame of pendingFrames) await this.frame(session, run, frame); })
          .catch(error => this.scheduleFailure(session, run, error instanceof ClaudeAgentError && error.code === 'STORAGE_FULL' ? 'Claude history storage capacity reached.' : 'Claude session persistence failed'))
          .finally(() => { if (!run.finished) child.stdout.resume(); });
      });
      // Never retain raw stderr: it may contain credential material or user configuration.
      child.stderr.resume();
      child.stdin.on('error', () => this.scheduleFailure(session, run, 'Claude approval transport disconnected'));
      child.on('error', () => this.scheduleFailure(session, run, 'Claude CLI could not be started'));
      child.on('close', () => {
        if (run.killTimer) clearTimeout(run.killTimer);
        if (!run.finished) this.scheduleFailure(session, run, 'Claude CLI exited before completing the turn');
      });
      this.write(run, { type: 'control_request', request_id: run.initializeId, request: { subtype: 'initialize' } });
      return this.getSession(id);
    });
  }

  private environment(): NodeJS.ProcessEnv { return { ...process.env, ...this.options.env }; }
  private write(run: Run, value: unknown): void {
    if (!run.child.stdin.writable || run.child.stdin.writableLength > MAX_FRAME) throw new ClaudeAgentError(503, 'TRANSPORT_CLOSED', 'Claude approval transport unavailable');
    run.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private async frame(session: StoredSession, run: Run, frame: Record<string, any>): Promise<void> {
    if (run.finished || this.runs.get(session.id) !== run) return;
    if (frame.session_id && frame.session_id !== session.nativeSessionId) { await this.finish(session, run, 'error', 'Claude protocol returned an unexpected session identity'); return; }
    if (frame.type === 'control_response') {
      if (frame.response?.request_id === run.initializeId && !run.initialized) {
        if (frame.response.subtype !== 'success') { await this.finish(session, run, 'error', 'Claude protocol initialization failed'); return; }
        run.initialized = true; clearTimeout(run.timer);
        this.write(run, { type: 'user', session_id: session.nativeSessionId, parent_tool_use_id: null, message: { role: 'user', content: run.prompt } });
      }
      return;
    }
    if (frame.type === 'control_request') {
      const request = object(frame.request);
      if (request.subtype !== 'can_use_tool' || typeof frame.request_id !== 'string' || typeof request.tool_name !== 'string' || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
        this.write(run, { type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Unsupported Claude control request' } }); return;
      }
      if (session.approvals.length >= 32 || session.approvals.some((item) => item.requestId === frame.request_id)) { await this.finish(session, run, 'error', 'Claude protocol approval limit exceeded'); return; }
      session.approvals.push({ requestKey: `claude:${session.id}:${run.generation}:${frame.request_id}`, requestId: frame.request_id, sessionId: session.id, generation: run.generation, toolName: request.tool_name, toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : undefined, input: request.input, reason: typeof request.decision_reason === 'string' ? request.decision_reason : undefined, createdAt: now() });
      session.status = 'awaiting_approval';
    } else if (frame.type === 'control_cancel_request') {
      session.approvals = session.approvals.filter((entry) => entry.requestId !== frame.request_id);
      session.status = session.approvals.length ? 'awaiting_approval' : 'running';
    } else if (frame.type === 'system' && frame.subtype === 'init') {
      session.hasNativeHistory = true;
    } else if (frame.type === 'stream_event') {
      const event = object(frame.event);
      if (event.type === 'message_start') run.streamedItemId = undefined;
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        let item = session.items.find((entry) => entry.id === run.streamedItemId);
        if (!item) { run.streamedItemId = randomUUID(); item = { id: run.streamedItemId, kind: 'message', role: 'assistant', text: '', createdAt: now() }; session.items.push(item); }
        if (Buffer.byteLength(item.text ?? '') + Buffer.byteLength(event.delta.text) > MAX_FRAME) { await this.finish(session, run, 'error', 'Claude protocol text exceeded limit'); return; }
        item.text = (item.text ?? '') + event.delta.text;
      } else return;
    } else if (frame.type === 'assistant' || frame.type === 'user') {
      const blocks = frame.message?.content;
      if (!Array.isArray(blocks)) return;
      const text = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
      if (frame.type === 'assistant' && text) {
        const streamed = session.items.find((entry) => entry.id === run.streamedItemId);
        if (streamed) streamed.text = text;
        else session.items.push({ id: randomUUID(), kind: 'message', role: 'assistant', text, createdAt: now() });
        run.streamedItemId = undefined;
      }
      for (const block of blocks) {
        if (block.type === 'tool_use' && typeof block.id === 'string') session.items.push({ id: block.id, kind: 'tool', toolName: block.name, input: object(block.input), createdAt: now() });
        if (block.type === 'tool_result') {
          const tool = session.items.find((entry) => entry.id === block.tool_use_id && entry.kind === 'tool');
          if (tool) { tool.output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''); tool.isError = Boolean(block.is_error); }
        }
      }
    } else if (frame.type === 'rate_limit_event') {
      const info = object(frame.rate_limit_info);
      this.usage.observedLimit = { observedAt: now(), status: typeof info.status === 'string' ? info.status.slice(0, 100) : undefined, resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined };
    } else if (frame.type === 'result') {
      session.hasNativeHistory = true;
      await this.finish(session, run, frame.is_error || frame.subtype !== 'success' ? 'error' : 'idle', frame.is_error || frame.subtype !== 'success' ? 'Claude turn failed. Check the official CLI account and configuration.' : undefined); return;
    } else return;
    if (session.items.length > MAX_ITEMS) { await this.finish(session, run, 'error', 'Claude protocol history limit exceeded'); return; }
    session.updatedAt = now(); await this.persist();
  }

  respondApproval(id: string, requestKey: string, allow: boolean): Promise<ClaudeSession> {
    return this.exclusive(async () => {
      const session = this.find(id); const run = this.runs.get(id);
      const approval = session.approvals.find((entry) => entry.requestKey === requestKey && entry.generation === run?.generation);
      if (!run || run.finished || !approval) throw new ClaudeAgentError(409, 'STALE_APPROVAL', 'Claude approval is no longer active');
      if (typeof allow !== 'boolean') throw new ClaudeAgentError(400, 'INVALID_APPROVAL', 'Approval allow must be a boolean');
      session.approvals = session.approvals.filter((entry) => entry !== approval); session.status = session.approvals.length ? 'awaiting_approval' : 'running'; session.updatedAt = now();
      try { await this.persist(); }
      catch (error) {
        await this.finish(session, run, 'error', 'Claude history storage failed; last saved history shown. Repair storage before retrying.').catch(() => undefined);
        throw error;
      }
      try { this.write(run, { type: 'control_response', response: { subtype: 'success', request_id: approval.requestId, response: allow ? { behavior: 'allow', updatedInput: approval.input } : { behavior: 'deny', message: 'Permission denied by the user' } } }); }
      catch { await this.finish(session, run, 'error', 'Claude approval transport disconnected'); throw new ClaudeAgentError(503, 'TRANSPORT_CLOSED', 'Claude approval transport disconnected'); }
      return this.getSession(id);
    });
  }
  interrupt(id: string): Promise<ClaudeSession> {
    return this.exclusive(async () => {
      const session = this.find(id); const run = this.runs.get(id);
      if (run) {
        try { this.write(run, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }); } catch { /* Owned process is still terminated below. */ }
        await this.finish(session, run, 'interrupted');
      }
      return this.getSession(id);
    });
  }
  private scheduleFailure(session: StoredSession, run: Run, message: string): void {
    void this.exclusive(async () => { if (!run.finished) await this.finish(session, run, 'error', message); }).catch(() => this.stop(run));
  }
  private async finish(session: StoredSession, run: Run, status: ClaudeSession['status'], error?: string): Promise<void> {
    run.finished = true; clearTimeout(run.timer);
    // A result/cancel frame is not proof that the owned process has stopped.
    this.stop(run);
    await run.closed;
    session.status = status; session.error = error; session.approvals = []; session.updatedAt = now();
    try { await this.persist(true); this.runtimeStorageErrors.delete(session.id); }
    catch (failure) {
      const message = 'Claude history storage failed; last saved history shown. Repair storage before retrying.';
      this.runtimeStorageErrors.set(session.id, message);
      session.status = 'error'; session.approvals = []; session.error = message;
      throw failure;
    } finally { this.runs.delete(session.id); }
  }
  private stop(run: Run): void {
    clearTimeout(run.timer); run.finished = true; run.child.stdin.end(); run.child.stdout.resume();
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.killTimer = setTimeout(() => { run.child.kill('SIGTERM'); run.killTimer = setTimeout(() => run.child.kill('SIGKILL'), 1000); run.killTimer.unref(); }, 1000);
      run.killTimer.unref();
    }
  }
  private async probe(args: string[], cwd?: string): Promise<{ output: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command ?? process.env.CLAUDE_BIN ?? 'claude', [...(this.options.args ?? []), ...args], { cwd, env: this.environment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let exceeded = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI probe timed out')); }, 10_000); timer.unref();
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 64 * 1024) { exceeded = true; child.kill('SIGKILL'); } });
      child.stderr.resume(); child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); if (exceeded) reject(new Error('CLI probe exceeded limit')); else resolve({ output, code }); });
    });
  }
  refreshAccount(): Promise<ClaudeSnapshot> {
    return this.exclusive(async () => {
      const checkedAt = now(); let version: string | undefined;
      try {
        const result = await this.probe(['--version']);
        version = result.output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
        if (result.code !== 0 || !version) throw new Error('Invalid CLI version');
      } catch {
        this.account = { status: 'unavailable', available: false, checkedAt, loginInstructions, error: 'Claude CLI is missing or could not be executed' }; this.usage = usageDefault(); this.emit('snapshot', this.snapshot()); return this.snapshot();
      }
      try {
        const { output } = await this.probe(['auth', 'status', '--json']); const info = object(JSON.parse(output));
        const env = this.environment();
        this.account = { status: info.loggedIn === true ? 'ready' : 'signed_out', available: true, loggedIn: info.loggedIn === true, version, checkedAt, loginInstructions, apiBillingConfigured: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) };
        for (const key of ['authMethod', 'email', 'subscriptionType'] as const) if (typeof info[key] === 'string') this.account[key] = info[key].slice(0, 256);
        this.updateAccountIdentity(info);
      } catch { this.account = { status: 'error', available: true, version, checkedAt, loginInstructions, error: 'Claude authentication status could not be read' }; }
      this.emit('snapshot', this.snapshot()); return this.snapshot();
    });
  }
  logout(): Promise<ClaudeSnapshot> {
    return this.exclusive(async () => {
      if (this.runs.size) throw new ClaudeAgentError(409, 'AGENT_BUSY', 'Finish or interrupt active Claude turns before signing out');
      const result = await this.probe(['auth', 'logout']);
      if (result.code !== 0) throw new ClaudeAgentError(503, 'LOGOUT_FAILED', 'Official Claude CLI sign out failed');
      this.account = { status: 'signed_out', available: true, loggedIn: false, version: this.account.version, checkedAt: now(), loginInstructions }; this.usage = usageDefault(); this.emit('snapshot', this.snapshot()); return this.snapshot();
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    const owned = [...this.runs.values()];
    await this.exclusive(async () => { for (const [id, run] of this.runs) await this.finish(this.find(id), run, 'interrupted'); });
    await Promise.all(owned.map((run) => run.closed));
  }
  private updateAccountIdentity(info: Record<string, any>): void {
    const identity = JSON.stringify([info.loggedIn === true, info.authMethod, info.email, info.subscriptionType]);
    if (identity !== this.accountIdentity) this.usage = usageDefault();
    this.accountIdentity = identity;
  }
  private restoreCommitted(): void {
    const committed: StoredSession[] = JSON.parse(this.persistedState).sessions;
    const byId = new Map(committed.map(session => [session.id, session]));
    this.sessions = this.sessions.filter(session => {
      const previous = byId.get(session.id);
      if (!previous) return false;
      for (const key of Object.keys(session)) delete (session as any)[key];
      Object.assign(session, previous);
      // A failed terminal write must not resurrect a process that has exited.
      if (this.runtimeStorageErrors.has(session.id)) {
        session.status = 'error'; session.approvals = [];
        session.error = this.runtimeStorageErrors.get(session.id);
      }
      return true;
    });
  }
  private async persist(terminal = false): Promise<void> {
    const encoded = JSON.stringify({ version: 1, sessions: this.sessions });
    const limit = Math.min(MAX_STORAGE_BYTES, Math.max(8192, this.options.maxStorageBytes ?? MAX_STORAGE_BYTES));
    if (Buffer.byteLength(encoded) > limit - (terminal ? 0 : 4096)) {
      this.restoreCommitted();
      throw new ClaudeAgentError(507, 'STORAGE_FULL', 'Claude history storage capacity reached');
    }
    const directory = dirname(this.options.persistencePath);
    const temp = `${this.options.persistencePath}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined; let closed = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(encoded); await file.sync(); await file.close(); closed = true; await rename(temp, this.options.persistencePath);
    } catch {
      if (file && !closed) await file.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      this.restoreCommitted();
      throw new ClaudeAgentError(503, 'STORAGE_FAILED', 'Claude history storage failed; repair application storage and retry.');
    }
    this.publishedSessions = structuredClone(this.sessions.map(({ requestIds, hasNativeHistory, ...session }) => session));
    this.persistedState = encoded;
    this.emit('snapshot', this.snapshot());
  }
}
