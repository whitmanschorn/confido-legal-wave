/**
 * `/clients` — PLAN.md §6, `clients.spec`.
 *
 * This is the **only** page that talks to Confido from the browser.
 * `src/pages/clients.tsx:28` pulls the firm's secret out of `/api/session` and
 * hands it to `createClient` / `getClient`
 * (`src/confido-legal-requests/addClient.ts:32-36`,
 * `src/confido-legal-requests/getClient.ts:30-34`), which build a
 * `GraphQLClient` against `gqlEndpoint`. `CONFIDO_API_ENDPOINT` is *not* a
 * `NEXT_PUBLIC_` variable, so in the client bundle
 * `src/confido-legal-requests/index.ts:22-24` falls back to the hardcoded
 * sandbox URL `https://api.sandbox.gravity-legal.com/v2`.
 *
 * The `lockdown` fixture is what makes that credential-free: it intercepts that
 * exact origin and re-issues the request against the mock. Every test below
 * therefore asserts **both** halves — what the UI shows *and* that the request
 * was forwarded (`lockdown.forwardCount()`) and landed on the mock
 * (`mock.events`). That pairing is the proof the suite never reaches the
 * internet; a UI assertion alone would still pass if the browser had quietly
 * talked to the real sandbox.
 */

import { expect, test } from '../fixtures/test';
import type { MockEvent } from '../fixtures/test';
import type { Locator, Page } from '@playwright/test';

/** The `Add a Client` dialog (Chakra names the dialog from its `ModalHeader`). */
function addClientDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Add a Client' });
}

/**
 * Opens the modal from `/clients`. `Add client` (page, `clients.tsx:87`) and
 * `Add Client` (modal submit, `AddClient.tsx:122`) differ only in case, and
 * Playwright's accessible-name matching is case-insensitive unless told
 * otherwise — hence `exact: true` on both, everywhere in this file.
 */
async function openAddClientModal(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add client', exact: true }).click();
  const dialog = addClientDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Client Name')).toBeVisible();
  return dialog;
}

/** Pulls a JSON string field out of one of the page's `<Code>` blocks. */
async function jsonFieldOf(block: Locator, field: string): Promise<string> {
  const text = await block.innerText();
  const match = new RegExp(`"${field}":\\s*"([^"]*)"`).exec(text);
  expect(match, `no "${field}" in:\n${text}`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

test.describe('clients page (browser-side Confido calls)', () => {
  test('Add client creates the client through the intercepted sandbox URL', async ({
    page,
    mock,
    lockdown,
    connectedUser,
  }) => {
    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();

    const clientName = `Wave Client ${connectedUser.username}`;
    const mark = await mock.events.mark();
    // Drop anything the connect flow may have forwarded, so the counter below
    // measures only this interaction.
    lockdown.clear();

    const dialog = await openAddClientModal(page);
    await dialog.getByLabel('Client Name').fill(clientName);
    await dialog.getByRole('button', { name: 'Add Client', exact: true }).click();

    // The modal closes itself on success (`AddClient.tsx:62`).
    await expect(dialog).toBeHidden();

    const card = page.getByRole('heading', { name: 'Added client' });
    await expect(card).toBeVisible();
    const addedJson = page.locator('code').first();
    await expect(addedJson).toContainText(`"clientName": "${clientName}"`);
    const clientId = await jsonFieldOf(addedJson, 'id');
    expect(clientId).not.toHaveLength(0);

    // Half 1: the browser's request really was intercepted and re-pointed at
    // the mock instead of leaving the box.
    await lockdown.waitForForwards(1);
    expect(lockdown.forwardCount()).toBeGreaterThanOrEqual(1);
    const forwarded = lockdown.forwarded[lockdown.forwarded.length - 1];
    expect(forwarded.url).toBe('https://api.sandbox.gravity-legal.com/v2');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.status).toBe(200);
    // (The CORS preflight is fulfilled locally and is not counted as a forward.)
    // Nothing of consequence escaped: the Chakra template's `bit.ly`/`tinyurl`
    // avatars are aborted images, which `offendingEscapes()` deliberately
    // ignores outside strict mode.
    expect(lockdown.offendingEscapes()).toHaveLength(0);

    // Half 2: the mock actually executed `AddClient` for this firm's token.
    const event = await mock.events.waitFor({
      op: 'AddClient',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(true);
    expect(event.tokenKind).toBe('firm');
    expect(event.variables).toMatchObject({
      input: { clientName, firmId: connectedUser.firmId },
    });

    // The `id` the page printed is the one the mock stored.
    const state = await mock.state();
    const stored = state.clients.filter((record) => record.id === clientId);
    expect(stored).toHaveLength(1);
    expect(stored[0].clientName).toBe(clientName);
    expect(stored[0].firmId).toBe(connectedUser.firmId);
  });

  test('Request client by id round-trips the same id and shows email/phone as null', async ({
    page,
    mock,
    lockdown,
    connectedUser,
  }) => {
    await page.goto('/clients');
    const clientName = `Lookup Client ${connectedUser.username}`;

    const dialog = await openAddClientModal(page);
    await dialog.getByLabel('Client Name').fill(clientName);
    await dialog.getByRole('button', { name: 'Add Client', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Added client' })).toBeVisible();

    const addedJson = page.locator('code').first();
    const clientId = await jsonFieldOf(addedJson, 'id');

    const mark = await mock.events.mark();
    lockdown.clear();

    await page
      .getByRole('button', { name: 'Request client by id', exact: true })
      .click();

    const requested = page.getByRole('heading', { name: 'Requested client' });
    await expect(requested).toBeVisible();

    const fetchedJson = page.locator('code').nth(1);
    await expect(fetchedJson).toContainText(`"id": "${clientId}"`);
    await expect(fetchedJson).toContainText(`"clientName": "${clientName}"`);
    // The real API returns explicit nulls for unset optional fields (PLAN.md §0.1).
    await expect(fetchedJson).toContainText('"email": null');
    await expect(fetchedJson).toContainText('"phone": null');

    await lockdown.waitForForwards(1);
    expect(lockdown.forwarded[0].method).toBe('POST');
    expect(lockdown.forwarded[0].url).toBe('https://api.sandbox.gravity-legal.com/v2');
    expect(lockdown.offendingEscapes()).toHaveLength(0);

    const event = await mock.events.waitFor({
      op: 'GetClient',
      firmId: connectedUser.firmId,
      since: mark,
    });
    expect(event.ok).toBe(true);
    expect(event.variables).toMatchObject({ id: clientId });
  });

  test('both browser-side operations go out over the forwarded sandbox origin', async ({
    page,
    mock,
    lockdown,
    connectedUser,
  }) => {
    await page.goto('/clients');
    const clientName = `Both Ops ${connectedUser.username}`;
    const mark = await mock.events.mark();
    lockdown.clear();

    const dialog = await openAddClientModal(page);
    await dialog.getByLabel('Client Name').fill(clientName);
    await dialog.getByRole('button', { name: 'Add Client', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Added client' })).toBeVisible();

    await page
      .getByRole('button', { name: 'Request client by id', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Requested client' })).toBeVisible();

    // Exactly two forwarded requests: the mutation and the query. Nothing else
    // in the page talks to Confido from the browser.
    await lockdown.waitForForwards(2);
    expect(lockdown.forwardCount()).toBe(2);
    lockdown.forwarded.forEach((request) => {
      expect(request.url).toBe('https://api.sandbox.gravity-legal.com/v2');
      expect(request.status).toBe(200);
    });
    expect(lockdown.offendingEscapes()).toHaveLength(0);

    const events = await mock.events.waitForAll({
      since: mark,
      firmId: connectedUser.firmId,
      where: (candidate: MockEvent) =>
        candidate.operationName === 'AddClient' ||
        candidate.operationName === 'GetClient',
      count: 2,
    });
    expect(events.map((candidate) => candidate.operationName)).toEqual([
      'AddClient',
      'GetClient',
    ]);
    // Both were authenticated with the firm token that the *browser* holds.
    events.forEach((candidate) => expect(candidate.tokenKind).toBe('firm'));
  });

  test('an empty client name is rejected client-side, before any request leaves', async ({
    page,
    mock,
    lockdown,
    connectedUser,
  }) => {
    await page.goto('/clients');
    const mark = await mock.events.mark();
    lockdown.clear();

    const dialog = await openAddClientModal(page);
    // `AddClient.tsx:49-52` trims, so whitespace is "empty" too.
    await dialog.getByLabel('Client Name').fill('   ');
    await dialog.getByRole('button', { name: 'Add Client', exact: true }).click();

    await expect(dialog.getByText('Client name cannot be empty.')).toBeVisible();
    // The modal stays open and no result card appears.
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Added client' })).toHaveCount(0);

    // Nothing was sent: no forwarded sandbox request and no mock operation.
    expect(lockdown.forwardCount()).toBe(0);
    expect(lockdown.offendingEscapes()).toHaveLength(0);
    // (Scoped to the two browser-side operations: `GetFirm` may still arrive
    // here from `SessionProvider`'s own `/api/session` fetch, server-side.)
    const events = await mock.events.list({ since: mark, firmId: connectedUser.firmId });
    expect(
      events
        .map((event) => event.operationName)
        .filter((name) => name === 'AddClient' || name === 'GetClient'),
    ).toHaveLength(0);

    // Typing a real name clears the alert and works.
    const clientName = `Recovered ${connectedUser.username}`;
    await dialog.getByLabel('Client Name').fill(clientName);
    await dialog.getByRole('button', { name: 'Add Client', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Added client' })).toBeVisible();
    await expect(page.locator('code').first()).toContainText(
      `"clientName": "${clientName}"`,
    );
    await lockdown.waitForForwards(1);
  });

  test('a logged-in but unconnected firm is told the firm id is missing', async ({
    page,
    mock,
    lockdown,
    user,
  }) => {
    // `user`, not `connectedUser`: signed in, but `glFirm` is absent from
    // `/api/session`, so `clients.tsx:27` computes `firmId = ''` and the guard
    // at `AddClient.tsx:41-47` fires. (`/clients` also renders for logged-out
    // visitors — no `requireAuth` — but that case belongs to auth.spec.)
    expect(user.username).toBeTruthy();

    await page.goto('/clients');
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
    const mark = await mock.events.mark();
    lockdown.clear();

    const dialog = await openAddClientModal(page);
    await dialog.getByLabel('Client Name').fill('Nobody In Particular');
    await dialog.getByRole('button', { name: 'Add Client', exact: true }).click();

    await expect(
      dialog.getByText(
        'Firm ID is missing. Please ensure you are logged in with a valid firm.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Added client' })).toHaveCount(0);

    // The guard runs before `createClient`, so nothing is forwarded at all —
    // which also means the missing firm token is never put on the wire.
    expect(lockdown.forwardCount()).toBe(0);
    expect(lockdown.offendingEscapes()).toHaveLength(0);
    const events = await mock.events.list({ since: mark });
    expect(
      events.filter((event) => event.operationName === 'AddClient'),
    ).toHaveLength(0);
  });
});
