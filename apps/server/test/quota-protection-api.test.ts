import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { QuotaProtection } from '../src/quota/protection.js';
import { handleQuotaProtectionApi } from '../src/http/quota-protection-api.js';

it('exposes persisted reserve, validates updates and rejects foreign origins', async () => {
  const source = new EventEmitter() as any;
  source.status = { state: 'STOPPED' };
  const guard = await QuotaProtection.load(source, join(await mkdtemp(join(tmpdir(), 'quota-api-')), 'state.json'));
  const call = async (method: string, body?: unknown, origin = 'https://codex.test') => {
    const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as any;
    Object.assign(request, { method, url: '/api/quota-protection', headers: { origin } });
    let data: any;
    const response = { statusCode: 200, setHeader() {}, end(text: string) { data = JSON.parse(text); } } as any;
    expect(await handleQuotaProtectionApi(request, response, guard, 'https://codex.test')).toBe(true);
    return { status: response.statusCode, data };
  };
  expect((await call('GET')).data.reservePercent).toBe(30);
  expect((await call('PATCH', { reservePercent: 45 })).data.reservePercent).toBe(45);
  expect((await call('PATCH', { reservePercent: 0 })).status).toBe(400);
  expect((await call('PATCH', { reservePercent: 10 }, 'https://evil.test')).status).toBe(403);
  expect((await call('GET')).data.reservePercent).toBe(45);
  expect((await call('DELETE')).status).toBe(405);
});
