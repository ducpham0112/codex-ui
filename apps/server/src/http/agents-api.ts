import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClaudeModel } from '@codex-control/shared';
import { ClaudeAgent, ClaudeAgentError } from '../agents/claude.js';
import type { ProjectRegistry } from '../config/projects.js';

const PREFIX = '/api/agents/claude';
function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status; response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store'); response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage, keys: string[]): Promise<Record<string, any>> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ClaudeAgentError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 256 * 1024) throw new ClaudeAgentError(413, 'REQUEST_TOO_LARGE', 'Claude request is too large'); chunks.push(buffer); }
  let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ClaudeAgentError(400, 'INVALID_JSON', 'Request body must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new ClaudeAgentError(400, 'INVALID_REQUEST', 'Unexpected Claude request fields');
  return value as Record<string, any>;
}
export async function handleAgentsApi(request: IncomingMessage, response: ServerResponse, agent: ClaudeAgent, projects: Pick<ProjectRegistry, 'get'>, publicOrigin?: string): Promise<boolean> {
  const path = request.url?.split('?', 1)[0] ?? '';
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  try {
    if (publicOrigin && request.headers.origin && request.headers.origin !== publicOrigin) throw new ClaudeAgentError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
    const route = path.slice(PREFIX.length);
    if (request.method === 'GET') {
      if (route === '/status') { const { account, usage } = await agent.refreshAccount(); json(response, 200, { account, usage }); return true; }
      if (route === '/sessions') { const { sessions, usage } = agent.snapshot(); json(response, 200, { sessions, usage }); return true; }
      const detail = /^\/sessions\/([^/]+)$/.exec(route);
      if (detail) { json(response, 200, { session: agent.getSession(decodeURIComponent(detail[1])) }); return true; }
    } else if (request.method === 'POST') {
      if (route === '/sessions') {
        const value = await body(request, ['projectId', 'model']);
        if (typeof value.projectId !== 'string' || (value.model !== undefined && typeof value.model !== 'string')) throw new ClaudeAgentError(400, 'INVALID_REQUEST', 'A projectId and optional model alias are required');
        if (!projects.get(value.projectId)) throw new ClaudeAgentError(404, 'PROJECT_NOT_FOUND', 'Registered project not found');
        json(response, 201, { session: await agent.createSession(value.projectId, value.model as ClaudeModel | undefined) }); return true;
      }
      if (route === '/logout') { await body(request, []); const { account, usage } = await agent.logout(); json(response, 200, { account, usage }); return true; }
      const match = /^\/sessions\/([^/]+)\/(turn|interrupt|approvals\/([^/]+))$/.exec(route);
      if (match) {
        const id = decodeURIComponent(match[1]); let session;
        if (match[2] === 'turn') { const value = await body(request, ['prompt', 'requestId']); session = await agent.startTurn(id, value.prompt, value.requestId); }
        else if (match[2] === 'interrupt') { await body(request, []); session = await agent.interrupt(id); }
        else { const value = await body(request, ['allow']); if (typeof value.allow !== 'boolean') throw new ClaudeAgentError(400, 'INVALID_APPROVAL', 'Approval allow must be a boolean'); session = await agent.respondApproval(id, decodeURIComponent(match[3]), value.allow); }
        json(response, match[2] === 'turn' ? 202 : 200, { session }); return true;
      }
    }
    if (route === '/sessions' || route === '/status' || route === '/logout' || /^\/sessions\/[^/]+(?:\/(?:turn|interrupt|approvals\/[^/]+))?$/.test(route)) throw new ClaudeAgentError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    throw new ClaudeAgentError(404, 'NOT_FOUND', 'Claude API route not found');
  } catch (error) {
    const known = error instanceof ClaudeAgentError;
    json(response, known ? error.status : 500, { error: { code: known ? error.code : 'CLAUDE_REQUEST_FAILED', message: known ? error.message : 'Claude request failed' } });
  }
  return true;
}
