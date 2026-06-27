import { expect, test } from '@playwright/test';

test('renders the wallet shell without module crashes', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto('/', { waitUntil: 'networkidle' });

  await expect(
    page.getByRole('heading', { name: 'stINKy Multichain Policy Wallet' }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
