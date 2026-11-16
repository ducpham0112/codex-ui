import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QuotaProtection } from '../quota/protection.js';

export async function handleQuotaProtectionApi(request: IncomingMessage, response: ServerResponse, guard: QuotaProtection, publicOrigin?: string): Promise<boolean> {
  if (request.url?.split('?', 1)[0] !== '/api/quota-protection') return false;
  response.setHeader('cache-control', 'no-store');
  const send = (status: number, data: unknown) => { response.statusCode = status; response.end(JSON.stringify(data)); };
  if (!['GET', 'PATCH', 'POST'].includes(request.method ?? '')) {
    response.setHeader('allow', 'GET, PATCH, POST'); send(405, { error: 'Method not allowed' }); return true;
  }
  if (request.method !== 'GET' && publicOrigin && request.headers.origin && request.headers.origin !== publicOrigin) {
    send(403, { error: 'Request origin is not allowed' }); return true;
  }
  try {
    if (request.method !== 'GET') {
      let raw = '';
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw new Error('Request too large'); }
      const body = JSON.parse(raw);
      if (request.method === 'PATCH') {
        if (!body || Object.keys(body).some(key => key !== 'reservePercent')) throw new Error('Only reservePercent may be updated');
        await guard.setReserve(body.reservePercent);
      } else {
        if (typeof body?.cancelThreadId !== 'string' || Object.keys(body).some(key => key !== 'cancelThreadId')) throw new Error('cancelThreadId is required');
        await guard.cancel(body.cancelThreadId);
      }
    }
    send(200, guard.snapshot());
  } catch (error) { send(400, { error: error instanceof Error ? error.message : 'Invalid request' }); }
  return true;
}
