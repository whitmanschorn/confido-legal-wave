import { expect, test } from '@playwright/test';

const MOCK = 'http://127.0.0.1:7002';

test.describe('harness smoke', () => {
  test('the mock server answers /healthz', async ({ request }) => {
    const response = await request.get(`${MOCK}/healthz`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'confido-mock' });
  });

  test('Legal Wave is up and built against the mock', async ({ page }) => {
    await page.goto('/login');
    await expect(
      page.getByRole('heading', { name: 'Login to your Legal Wave account' }),
    ).toBeVisible();
  });
});
