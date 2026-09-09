/**
 * `/transactions` — PLAN.md §6, `transactions.spec`.
 *
 * There is nothing to integrate here: the route is an **unmodified Chakra
 * "Members table" template**. It renders five hardcoded people from
 * `src/components/transactions/TransactionsTable.tsx:22-73`, a literal
 * "Showing 1 to 5 of 42 results" caption
 * (`src/components/transactions/TransactionsPage.tsx:51`), and Previous/Next
 * buttons wired to nothing. No Confido call is made, no Legal Wave API route is
 * hit, and the page is not linked from the sidebar.
 *
 * The one piece of "integration" code that exists,
 * `src/components/transactions/useTransactions.ts`, holds a GraphQL document
 * that is not even syntactically valid (QUIRKS.md #12) and has no callers, so
 * it is never evaluated.
 *
 * Every test in this file is therefore an annotated quirk: it pins template
 * content so that the day someone wires this page up to real data, the suite
 * says so out loud.
 */

import { expect, test } from '../fixtures/test';

const TEMPLATE_QUIRK =
  '/transactions is an unmodified Chakra template: five hardcoded members from ' +
  'TransactionsTable.tsx:22-73, a literal "Showing 1 to 5 of 42 results" ' +
  '(TransactionsPage.tsx:51), and no data layer. QUIRKS.md #12.';

/** The five names the template hardcodes, in render order. */
const TEMPLATE_MEMBERS = [
  'Christian Nwamba',
  'Kent C. Dodds',
  'Prosper Otemuyiwa',
  'Ryan Florence',
  'Segun Adebayo',
];

test.describe('transactions page (static Chakra template)', () => {
  test(
    'renders the hardcoded template: 5 rows, the "1 to 5 of 42" caption and Kent C. Dodds',
    { annotation: { type: 'quirk', description: TEMPLATE_QUIRK } },
    async ({ page, user }) => {
      expect(user.username).toBeTruthy();
      await page.goto('/transactions');

      // `Layout` only renders once SessionProvider has resolved /api/session.
      await expect(page.getByText('Transactions', { exact: true })).toBeVisible();

      // The caption is a bare string, not derived from anything.
      await expect(page.getByText('Showing 1 to 5 of 42 results')).toBeVisible();

      const rows = page.locator('tbody tr');
      await expect(rows).toHaveCount(5);

      await expect(page.getByText('Kent C. Dodds')).toBeVisible();
      await expect(page.getByText('@kent')).toBeVisible();
      await expect(page.getByText('kent@chakra-ui.com')).toBeVisible();
      await expect(page.getByText('Director of DX')).toBeVisible();

      // …and every other member of the template, in order.
      for (let i = 0; i < TEMPLATE_MEMBERS.length; i += 1) {
        await expect(rows.nth(i)).toContainText(TEMPLATE_MEMBERS[i]);
      }

      // Column headers and the dead pagination controls.
      await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Email' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Role' })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Rating' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Previous' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Next' })).toBeVisible();

      // Every row is `status: 'active'` — there is no other state in the data.
      await expect(page.getByText('active', { exact: true })).toHaveCount(5);
    },
  );

  test(
    'talks to nothing: no Confido operation and no Legal Wave API call beyond /api/session',
    { annotation: { type: 'quirk', description: TEMPLATE_QUIRK } },
    async ({ page, mock, user }) => {
      expect(user.username).toBeTruthy();

      const appRequests: string[] = [];
      const confidoRequests: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (url.indexOf('/api/') !== -1) appRequests.push(`${request.method()} ${url}`);
        // The mock also serves the two SDK shims over `/js`, which every page
        // loads from `_document.tsx`; only GraphQL and control traffic counts.
        if (url.indexOf(`${mock.baseUrl}/v2`) === 0) confidoRequests.push(url);
        if (url.indexOf(`${mock.baseUrl}/__control`) === 0) confidoRequests.push(url);
      });

      await page.goto('/transactions');
      await expect(page.getByText('Showing 1 to 5 of 42 results')).toBeVisible();
      await expect(page.locator('tbody tr')).toHaveCount(5);

      // The only Legal Wave route the page hits is the session lookup that
      // `SessionProvider` performs for every page in `Layout`.
      const nonSession = appRequests.filter(
        (entry) => entry.indexOf('/api/session') === -1,
      );
      expect(nonSession, `unexpected API calls: ${nonSession.join(', ')}`).toHaveLength(0);

      // And the browser never speaks to Confido — the dead `useTransactions`
      // document (QUIRKS.md #12) has no callers.
      expect(confidoRequests).toHaveLength(0);
    },
  );

  test(
    'is reachable only by direct URL — the sidebar never links to it',
    { annotation: { type: 'quirk', description: TEMPLATE_QUIRK } },
    async ({ page, user }) => {
      expect(user.username).toBeTruthy();
      await page.goto('/');

      // The four links `Sidebar.tsx:31-61` renders…
      await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Payment Intents' })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Stored Payment Methods' }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Clients' })).toBeVisible();

      // …and the one it does not.
      await expect(page.locator('a[href="/transactions"]')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Transactions' })).toHaveCount(0);
    },
  );
});
