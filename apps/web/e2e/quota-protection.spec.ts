import { expect, test } from '@playwright/test';

test('quota reserve can be saved and survives reload on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'Settings' }).click();
    const input = page.getByRole('spinbutton', { name: '5-hour quota reserve (%)' });
    await expect(input).toBeVisible();
    await input.fill(width === 1280 ? '45' : '30');
    await page.getByRole('button', { name: 'Save quota reserve' }).click();
    await expect(page.getByText('Quota reserve saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('spinbutton', { name: '5-hour quota reserve (%)' })).toHaveValue(width === 1280 ? '45' : '30');
  }
});
