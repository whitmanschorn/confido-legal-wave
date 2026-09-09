/**
 * The two inbound webhook receivers (PLAN.md §6, `webhooks.spec`).
 *
 *   POST /api/accept-webhook         header `x-signature`,         GL_WEBHOOK_SECRET
 *   POST /api/legacy-accept-webhook  header `x-prahari-signature`, GL_LEGACY_WEBHOOK_SECRET
 *
 * Request-only: no `page`, so these are the cheapest tests in the suite.
 *
 * Two things to know before reading the assertions.
 *
 * 1. **Both routes answer HTTP 200 whatever happens.** `res.send(400)` /
 *    `res.send(200)` (`src/pages/api/accept-webhook.ts:19,25` and
 *    `src/pages/api/legacy-accept-webhook.ts:19,25`) look like Express status
 *    setters but `NextApiResponse.send` treats a number as the *body*. So the
 *    status code is in the body and the HTTP status is always 200
 *    (QUIRKS.md §1). Every test here asserts the body text and pins the 200.
 *
 * 2. **The signature covers the re-serialised parsed body, not the raw bytes.**
 *    The handler does `hmac.update(JSON.stringify(req.body))` on the object
 *    Next's body parser produced, so `signWebhookBody` in
 *    `fixtures/legal-wave.ts` hashes `JSON.stringify(body)` the same way and
 *    Playwright's `data:` option puts exactly that JSON on the wire.
 */

import { LEGACY_WEBHOOK_SECRET, WEBHOOK_SECRET } from '../playwright.config';
import {
  expect,
  legacyWebhookHeaders,
  signWebhookBody,
  test,
  webhookHeaders,
} from '../fixtures/test';

const WEBHOOK_PATH = '/api/accept-webhook';
const LEGACY_WEBHOOK_PATH = '/api/legacy-accept-webhook';

/** A plausible Confido webhook envelope. Key order matters — see the header. */
function eventBody(id: string): Record<string, unknown> {
  return {
    event: 'payment.succeeded',
    id,
    data: {
      paymentId: `pay_${id}`,
      amountProcessed: 1000,
      status: 'success',
    },
  };
}

const SEND_NUMBER_QUIRK =
  'src/pages/api/accept-webhook.ts:19,25 (and legacy-accept-webhook.ts:19,25) call ' +
  'res.send(400)/res.send(200). NextApiResponse.send treats a number as the body, not ' +
  'the status, so the route always answers HTTP 200 with the status code as text. ' +
  'A sender that got the signature wrong is told 200 OK and never retries. QUIRKS.md #1.';

test.describe('POST /api/accept-webhook', () => {
  test(
    'a correctly signed webhook is accepted — HTTP 200 with body `200`',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ request }) => {
      const body = eventBody('evt_valid');

      const response = await request.post(WEBHOOK_PATH, {
        headers: webhookHeaders(body),
        data: body,
      });

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('200');
    },
  );

  test(
    'a wrong signature is rejected in the body only — HTTP 200 with body `400`',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ request }) => {
      const body = eventBody('evt_bad_sig');

      const response = await request.post(WEBHOOK_PATH, {
        headers: {
          'content-type': 'application/json',
          'x-signature': 'not-a-real-signature',
        },
        data: body,
      });

      // The rejection is invisible to any caller doing `if (!response.ok)`.
      expect(response.status()).toBe(200);
      expect(response.ok()).toBe(true);
      expect((await response.text()).trim()).toBe('400');
    },
  );

  test(
    'no x-signature header at all is rejected the same way',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ request }) => {
      const body = eventBody('evt_no_sig');

      const response = await request.post(WEBHOOK_PATH, {
        headers: { 'content-type': 'application/json' },
        data: body,
      });

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('400');
    },
  );

  test('a signature for a different body is rejected', async ({ request }) => {
    const signed = eventBody('evt_signed');
    const sent = eventBody('evt_tampered');

    const response = await request.post(WEBHOOK_PATH, {
      headers: {
        'content-type': 'application/json',
        'x-signature': signWebhookBody(signed, WEBHOOK_SECRET),
      },
      data: sent,
    });

    expect((await response.text()).trim()).toBe('400');
  });

  test('a signature made with the legacy secret is rejected', async ({ request }) => {
    const body = eventBody('evt_wrong_secret');

    const response = await request.post(WEBHOOK_PATH, {
      headers: {
        'content-type': 'application/json',
        'x-signature': signWebhookBody(body, LEGACY_WEBHOOK_SECRET),
      },
      data: body,
    });

    // Proves the two endpoints really do use two different secrets.
    expect((await response.text()).trim()).toBe('400');
  });

  test(
    'the signature covers the re-serialised body, so raw-byte whitespace is ignored',
    {
      annotation: {
        type: 'quirk',
        description:
          'src/pages/api/accept-webhook.ts:12-15 hashes JSON.stringify(req.body) — the body ' +
          "Next's parser produced, re-serialised — rather than the raw request bytes. A payload " +
          'that is byte-for-byte different from the one the sender signed therefore still ' +
          'verifies, as long as it parses to the same object with the same key order. ' +
          'HMAC over a re-serialisation is not a signature over the message that arrived.',
      },
    },
    async ({ request }) => {
      const body = eventBody('evt_whitespace');
      const compactSignature = signWebhookBody(body, WEBHOOK_SECRET);

      // Same JSON, pretty-printed: different bytes, identical parse.
      const prettyBytes = JSON.stringify(body, null, 4);
      expect(prettyBytes).not.toBe(JSON.stringify(body));

      const response = await request.post(WEBHOOK_PATH, {
        headers: { 'content-type': 'application/json', 'x-signature': compactSignature },
        data: prettyBytes,
      });

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('200');
    },
  );

  test('re-ordering the keys does break the signature', async ({ request }) => {
    const body = eventBody('evt_reorder');
    const signature = signWebhookBody(body, WEBHOOK_SECRET);

    // `JSON.stringify` walks insertion order, and Next's parser preserves the
    // order the bytes arrived in, so a semantically identical payload with the
    // keys swapped hashes differently.
    const reordered = JSON.stringify({
      data: body.data,
      id: body.id,
      event: body.event,
    });

    const response = await request.post(WEBHOOK_PATH, {
      headers: { 'content-type': 'application/json', 'x-signature': signature },
      data: reordered,
    });

    expect((await response.text()).trim()).toBe('400');
  });

  test(
    'a GET with no body is rejected rather than crashing the route',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ request }) => {
      // The handler is not method-guarded; it falls through to the signature
      // check, which cannot match, so the answer is the usual 200/`400`.
      const response = await request.get(WEBHOOK_PATH);

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('400');
    },
  );
});

test.describe('POST /api/legacy-accept-webhook', () => {
  test(
    'a correctly signed legacy webhook is accepted — HTTP 200 with body `200`',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ request }) => {
      const body = eventBody('evt_legacy_valid');

      const response = await request.post(LEGACY_WEBHOOK_PATH, {
        headers: legacyWebhookHeaders(body),
        data: body,
      });

      expect(response.status()).toBe(200);
      expect((await response.text()).trim()).toBe('200');
    },
  );

  test(
    'a wrong x-prahari-signature is rejected in the body only — HTTP 200 with body `400`',
    { annotation: { type: 'quirk', description: SEND_NUMBER_QUIRK } },
    async ({ request }) => {
      const body = eventBody('evt_legacy_bad_sig');

      const response = await request.post(LEGACY_WEBHOOK_PATH, {
        headers: {
          'content-type': 'application/json',
          'x-prahari-signature': 'not-a-real-signature',
        },
        data: body,
      });

      expect(response.status()).toBe(200);
      expect(response.ok()).toBe(true);
      expect((await response.text()).trim()).toBe('400');
    },
  );

  test('the legacy route ignores x-signature entirely', async ({ request }) => {
    const body = eventBody('evt_legacy_wrong_header');

    const response = await request.post(LEGACY_WEBHOOK_PATH, {
      headers: webhookHeaders(body), // correct signature, wrong header name
      data: body,
    });

    expect((await response.text()).trim()).toBe('400');
  });

  test('a signature made with the modern secret is rejected', async ({ request }) => {
    const body = eventBody('evt_legacy_wrong_secret');

    const response = await request.post(LEGACY_WEBHOOK_PATH, {
      headers: {
        'content-type': 'application/json',
        'x-prahari-signature': signWebhookBody(body, WEBHOOK_SECRET),
      },
      data: body,
    });

    expect((await response.text()).trim()).toBe('400');
  });

  test('the two endpoints are independent: each only accepts its own secret', async ({
    request,
  }) => {
    const body = eventBody('evt_cross');

    const modern = await request.post(WEBHOOK_PATH, {
      headers: webhookHeaders(body),
      data: body,
    });
    const legacy = await request.post(LEGACY_WEBHOOK_PATH, {
      headers: legacyWebhookHeaders(body),
      data: body,
    });

    expect((await modern.text()).trim()).toBe('200');
    expect((await legacy.text()).trim()).toBe('200');
    expect(signWebhookBody(body, WEBHOOK_SECRET)).not.toBe(
      signWebhookBody(body, LEGACY_WEBHOOK_SECRET),
    );
  });
});
