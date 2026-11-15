import { expect, test } from '@playwright/test';
test.use({ serviceWorkers: 'block' });

// Browser contract test; native CLI lifecycle is exercised by server fixture tests.
test('manages Claude chat, approval, interruption, settings and quota in the shared shell', async ({ page }) => {
  let session: any = null;
  let turnPosts = 0;
  const account = { status: 'ready', available: true, loggedIn: true, version: '2.1.325', authMethod: 'claude.ai', email: 'browser@example.com', loginInstructions: 'Run claude auth login on the server.' };
  const usage = { status: 'unavailable', source: 'claude-cli', message: 'Subscription allowance is unavailable through this integration.', usageUrl: 'https://claude.ai/settings/usage' };
  await page.route('**/api/agents/claude/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let result: any;
    if (path.endsWith('/status')) result = { account, usage };
    else if (path.endsWith('/sessions') && request.method() === 'GET') result = { sessions: session ? [session] : [] };
    else if (path.endsWith('/sessions')) {
      const input = request.postDataJSON();
      session = { id: 'browser-session', nativeSessionId: 'browser-session', agentId: 'claude', projectId: input.projectId, projectRoot: '/workspace/demo', title: 'New Claude session', model: input.model, status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [], approvals: [] };
      result = { session };
    } else if (path.endsWith('/turn')) {
      turnPosts++;
      const { prompt } = request.postDataJSON();
      session.items.push({ id: `u${turnPosts}`, kind: 'message', role: 'user', text: prompt });
      session.status = prompt === 'approval' ? 'awaiting_approval' : 'running';
      if (prompt === 'approval') session.approvals = [{ requestKey: 'claude:approval', toolName: 'Bash', input: { command: 'echo hello' }, reason: 'Requires permission' }];
      session.updatedAt = new Date().toISOString(); result = { session };
    } else if (path.includes('/approvals/')) {
      session.approvals = []; session.status = 'idle'; session.updatedAt = new Date().toISOString();
      session.items.push({ id: 'reply', kind: 'message', role: 'assistant', text: 'Approved command finished' }); result = { session };
    } else if (path.endsWith('/interrupt')) {
      session.status = 'interrupted'; session.updatedAt = new Date().toISOString(); result = { session };
    } else result = { session };
    await route.fulfill({ json: result });
  });
  await page.goto('/');
  await page.locator('#project-value').click();
  await page.getByRole('option', { name: /Codex Control PWA/ }).click();
  await page.getByRole('button', { name: 'Create session or project' }).click();
  await page.getByRole('menuitem', { name: /New session/ }).click();
  await page.locator('#new-session-agent').selectOption('claude');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message Claude' });
  await expect(composer).toBeVisible();
  await composer.fill('approval');
  await page.getByRole('button', { name: 'Send to Claude' }).click();
  await expect(page.getByRole('heading', { name: 'Claude requests Bash' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByText('Approved command finished')).toBeVisible();
  await composer.fill('hold');
  await page.getByRole('button', { name: 'Send to Claude' }).click();
  await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect(page.locator('claude-chat .session-heading')).toContainText('interrupted');
  expect(turnPosts).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/codex-ui-claude-chat-${test.info().project.name}.png`, fullPage: true });
  await page.reload();
  await expect(composer).toBeVisible();
  expect(turnPosts).toBe(2);
  await page.getByRole('button', { name: /View agent quota/ }).click();
  await expect(page.locator('#codex-quota-panel')).toContainText('Subscription allowance is unavailable');
  await page.getByRole('button', { name: 'Close quota' }).click();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('browser@example.com', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Claude usage' }).first()).toHaveAttribute('href', 'https://claude.ai/settings/usage');
  await page.screenshot({ path: `/tmp/codex-ui-claude-settings-${test.info().project.name}.png`, fullPage: true });
});
