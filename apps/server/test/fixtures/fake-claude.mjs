import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes('--version')) { console.log('2.1.325 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') {
  if (args[1] === 'logout') { console.log('Logged out'); process.exit(0); }
  console.log(JSON.stringify({ loggedIn: true, authMethod: process.env.CLAUDE_FIXTURE_AUTH_METHOD ?? 'claude.ai', email: process.env.CLAUDE_FIXTURE_EMAIL ?? 'user@example.com', subscriptionType: 'pro', accessToken: 'secret-token', nested: { refreshToken: 'secret-refresh' } }));
  process.exit(0);
}
if (!args.includes('--permission-prompt-tool') || !args.includes('stdio') || args.includes('--dangerously-skip-permissions')) process.exit(9);
let initialized = false;
let prompt;
const native = args.find((arg) => arg.startsWith('--resume='))?.slice(9) ?? args.find((arg) => arg.startsWith('--session-id='))?.slice(13);
const result = (text) => {
  emit({ type: 'assistant', uuid: 'a1', session_id: native, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: native, result: text });
};
const lines = createInterface({ input: process.stdin });
lines.on('close', () => {
  if (process.env.CLAUDE_FIXTURE_SLOW_EXIT) setTimeout(() => {
    if (process.env.CLAUDE_FIXTURE_LOG) appendFileSync(process.env.CLAUDE_FIXTURE_LOG, JSON.stringify({ exited: true }) + '\n');
  }, 350);
});
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (process.env.CLAUDE_FIXTURE_LOG) appendFileSync(process.env.CLAUDE_FIXTURE_LOG, `${JSON.stringify({ args, frame })}\n`);
  if (frame.type === 'control_request' && frame.request.subtype === 'initialize') {
    initialized = true;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  } else if (frame.type === 'control_request' && frame.request.subtype === 'interrupt') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  } else if (frame.type === 'user') {
    if (!initialized) process.exit(10);
    prompt = frame.message.content;
    emit({ type: 'system', subtype: 'init', session_id: native });
    if (prompt === 'malformed') { process.stdout.write('{bad json}\n'); return; }
    if (prompt === 'oversized') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); return; }
    if (prompt === 'hold') return;
    if (prompt === 'fill') {
      for (let i = 0; i < 12; i++) emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(8192) }] } });
      result('Finished filling'); return;
    }
    if (prompt === 'limit') { emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000 } }); result('Limited'); return; }
    if (prompt === 'approval') {
      emit({ type: 'assistant', uuid: 't1', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'echo hello' } }] } });
      emit({ type: 'control_request', request_id: 'permission1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool1', input: { command: 'echo hello' }, decision_reason: 'Requires permission' } });
      return;
    }
    emit({ type: 'stream_event', uuid: 'delta1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } });
    emit({ type: 'stream_event', uuid: 'delta2', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } } });
    result(args.some((arg) => arg.startsWith('--resume=')) ? 'Resumed' : 'Hello world');
  } else if (frame.type === 'control_response') {
    const decision = frame.response.response;
    if (frame.response.request_id !== 'permission1') process.exit(11);
    if (decision.behavior === 'allow' && decision.updatedInput?.command !== 'echo hello') process.exit(12);
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: decision.behavior === 'allow' ? 'hello' : 'Denied', is_error: decision.behavior !== 'allow' }] } });
    result(decision.behavior === 'allow' ? 'Allowed' : 'Denied');
  }
});
