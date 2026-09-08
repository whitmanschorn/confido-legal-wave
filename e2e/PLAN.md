# Legal Wave: credential-free Playwright suite — plan of attack

Goal: exercise **every** user-facing and API-route behaviour of Legal Wave under Playwright,
with the suite passing **on a clean clone, with no Confido credentials and no network access
to Confido**. All work is **additive**: nothing under `src/`, `prisma/`, `public/`,
`package.json`, or any other pre-existing file may change. Everything lives in `e2e/`
(plus, in the last phase, one new GitHub Actions workflow file).

Verification of the additive rule, run before every commit:

```
git status --porcelain | grep -vE '^\?\? (e2e/|\.github/)' | grep -v '^ M e2e/' ; # must print nothing
```

### 0.0 Hard constraint discovered in Phase 0: e2e code is type-checked by `next build`

The root `tsconfig.json` has `"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"]`, so `next build`
type-checks everything under `e2e/` too — and we may not edit the root tsconfig. Therefore **every
`.ts` file under `e2e/` must compile under the root config as well as under `e2e/tsconfig.json`**
(root is `target: es5`, `moduleResolution: node`, `strict`, `isolatedModules`, no `downlevelIteration`).

Rules that follow, and that every unit must obey:

* **No iterator spread or `for…of` over a `Map`/`Set`.** Use `Array.from(map.values())` and
  `map.forEach(...)`. (`[...map.values()]` is TS2802 under the root config.)
* **Extensionless relative imports** (`./types`, not `./types.js`). `tsx` resolves these fine.
* `import type` / `export type` for type-only bindings (`isolatedModules`).
* No `for await`. Shims stay `.js` (the root `include` only matches `.ts`/`.tsx`, so they are exempt).
* Verify with **both**: `npx tsc --noEmit` from `e2e/`, and `npx tsc --noEmit` from the repo root
  (root output is clean; ignore nothing).

If a test can only be made to pass by changing app code, **do not change the app**. Encode the
current behaviour, tag the test with an annotation `{ type: 'quirk', description: '...' }`, and
add a line to `e2e/QUIRKS.md`. Those quirks are findings we want to show the maintainers.

---

## 0. Facts about the app the harness must respect (already verified)

| Fact | Consequence for the harness |
|---|---|
| Server-side Confido calls go through `graphql-request` to `process.env.CONFIDO_API_ENDPOINT` (fallback sandbox URL). | Point the env var at the mock server. No code change needed. |
| The **Clients page calls Confido from the browser** (`getClient`, `createClient` in `AddClient.tsx` / `clients.tsx`). The client bundle inlines the sandbox fallback URL `https://api.sandbox.gravity-legal.com/v2` and sends the firm token as `x-api-key`. | Playwright `context.route` must intercept that URL and forward the request to the mock server. |
| SDK scripts come from `NEXT_PUBLIC_CONFIDO_SDK_URL` and `NEXT_PUBLIC_CL_ONBOARDING_JS_URL` (`_document.tsx`, `<script async>`). | Point both at the mock server **and** inject the shims with `page.addInitScript` so ordering never races the `async` tag. Shims must be idempotent (`if (window.gravityLegal) return`). |
| Connect URL is `${NEXT_PUBLIC_CONFIDO_APP_DOMAIN}/connect/${partner.appId}` opened with `target=_blank`. Callback is `GET /api/gravity-callback?code=&state=`. | Mock server hosts a fake authorize page under `/app/connect/:appId` that redirects to `http://127.0.0.1:7001/api/gravity-callback`. |
| Home page **always** calls `me { partner { id appId } }` with the partner token. | Mock must accept exactly one partner token: `p_secret_mock_partner`. |
| `createFirm` is called with `mockOnboarding: false`; the UI shows "Pending" until `firm.isAcceptingPayments` is true. | Mock firms created via Sign-Up-Link/Onboarding start **not** accepting payments; a control endpoint activates them. Firms created via Connect start active. |
| Payment session tokens: `createPaymentToken(input:{bankAccountId, paymentLinkId})` returns `paymentToken`. The Paylinks page passes a **hardcoded** `paymentLinkId` (`a1e7a82e-...`) and the form reads `hostedFieldsState.paymentLink.totalAmount`. | Mock accepts any `paymentLinkId` and returns a session tied to a fake payment link with `totalAmount` (use 25000). Shim must populate `state.paymentLink`. |
| `paymentSessionComplete` selection set: `id status storedPaymentMethod{cardBrand payerName paymentMethod lastFour id} transactions{id amountProcessed payRequest{externalId}}`. App generates `externalId` (uuid v4) itself. `PaymentStatus` enum is lowercase: `error | success | partial_success | failed`. | Return `status: "success"`, echo `externalId`, persist the payment so `payRequestList(input:{externalId, firmId})` finds it. |
| `completeSavePaymentMethod` selection set: `id lastFour`. `createSavePaymentMethodToken` returns `savePaymentMethodToken`. | Simple. |
| `addClient(input:{clientName, firmId})` returns `clientName id`; `client(id)` returns `id clientName email phone`. | Store clients per firm; reject `firmId` mismatch. |
| Hosted-fields hook (`useConfidoLegal.ts`) calls `init` with container ids `card-number card-exp card-cvv account-holder-name account-number routing-number`, `addChangeListener`, `removeChangeListener`, `setActiveForm`, `recalculateSurcharging`, `submitFields`. `HostedFieldInput` shows a spinner until `fields[x].loading === false`. | Shim must implement the full `window.gravityLegal` interface in `src/confido-legal-hook/ConfidoLegal.d.ts` and emit an initial change event with all fields `loading:false`. |
| Onboarding modal calls `window.confidoOnboarding.renderForm({containerId:'confido-onboarding-form', token, ...})`; `/owner-form?o_code=` calls `renderOwnerForm({code, containerId:'confido-owner-form'})`. | Second shim. |
| Webhook routes verify `HMAC-SHA512(base64)` of `JSON.stringify(body)` with `GL_WEBHOOK_SECRET` (header `x-signature`) and `GL_LEGACY_WEBHOOK_SECRET` (header `x-prahari-signature`). They call `res.send(400)` / `res.send(200)`, i.e. **HTTP 200 with the number as body**. | Test computes the HMAC locally; assert body text, annotate as quirk. Same quirk in `/api/login` (`res.send(403)`) and `/api/disconnect`. |
| DB is SQLite at `prisma/legal-wave.sqlite`; `npm run reset-db` wipes it. Prisma singleton is created at server start. | Reset **in the webServer command** before `next build/start`. Isolate tests by creating a unique user per test, not by resetting. |
| `next dev` is slow and HMR-flaky; NEXT_PUBLIC vars are inlined at build time. | Use `npm run build && npm run start` in the webServer with the env applied to both. |
| Ports: Legal Wave `7001` (fixed in package.json). | Mock server on `7002`. Use `127.0.0.1`, not `localhost`, everywhere. |
| Node 24 works; `next build` passes on a clean clone. `tsc` fails only on `.svg` module declarations (pre-existing, ignore). | Nothing to do. |
| Real schema is at `e2e/mock-server/schema.graphql` (4007 lines, dumped via unauthenticated introspection of `https://api.sandbox.gravity-legal.com/v2`). Scalars: `DateTimeISO JSON BigInt`. | Build the mock from this SDL so every response is type-correct. |

### 0.1 Facts verified against the live sandbox API (2026-09-08)

These were captured by running real requests with a throwaway sandbox firm token. The mock should
reproduce these shapes and messages verbatim; they override anything looser written elsewhere in this file.

| Situation | Real response |
|---|---|
| Unknown / malformed `x-api-key` | **HTTP 500**, body `{"errors":[{"message":"Context creation failed: Invalid firm token.","extensions":{"code":"INTERNAL_SERVER_ERROR"}}]}` (no `data` key) |
| Revoked firm token (after `disconnectFromPartner`) | **HTTP 500**, message `Context creation failed: Token has been revoked.` |
| No `x-api-key` at all | **HTTP 200**, `data: null`, error `Access denied! You don't have permission for this action!` with `path` |
| Validation / not-found errors | **HTTP 200**, `data: null`, `extensions.code: "USER_INPUT_ERROR"`, e.g. `Client with id(<uuid>) not found.`, `Firm with id(<uuid>) not found.` |
| Business-rule errors | **HTTP 200**, `data: null`, `extensions.code: "INTERNAL_SERVER_ERROR"`, messages below |
| `firm` right after `createFirm(mockOnboarding:false)` | `status: "CREATED"`, `isAcceptingPayments: false` |
| `me` with a **firm** token | `__typename: "Scope"` (only the partner token yields `me.partner`) |
| `createFirmSignUpLink` | `link: "https://app.sandbox.confidolegal.com/signup?s_code=<32 hex>"`, `expiresAt` ≈ 20 min out. **Mock (frozen): `${MOCK}/app/signup?s_code=<32 hex>`** — the query form, mirroring the real API. This overrides the `/app/signup/<code>` path form written in §3.3/§3.5 below; the fake app answers **both** shapes, but every minted link uses the query form, and `home-signup-link.spec` asserts the popup URL starts with `${MOCK}/app/signup`. |
| `createOnboardingToken` | token prefix `onboarding_public_sandbox_`, expires ≈ 24 h |
| `createPaymentToken(input:{})` on a non-active firm | error `no operating accounts exist` |
| `createPaymentToken(input:{})` on an active firm | `paymentToken` prefix `pay_public_sandbox_` |
| `createPaymentToken(input:{paymentLinkId:"a1e7a82e-…"})` (the Paylinks page's hardcoded id), active or not | error `Paylink not found` → **the real Paylinks page 500s for every account but the author's.** Mock default must reproduce this; add control `POST /__control/paylinks/seed {id, totalAmount}` so a second test can seed that exact id and exercise the form. |
| `createSavePaymentMethodToken` on a non-active firm | error `This firm is not active.` |
| `createSavePaymentMethodToken` on an active firm | token prefix `spm_public_sandbox_` |
| `paymentSessionComplete` with a valid token but no hosted-fields submission | error `binData is required for card payments` (use this text for "nothing staged" with method CREDIT/DEBIT) |
| `paymentSessionComplete` with unknown token | error `PaymentSession not found` |
| `completeSavePaymentMethod` with unknown token | error `SavePaymentMethodSession not found` |
| `addClient` with a `firmId` that is not the token's firm | `USER_INPUT_ERROR` `Firm with id(<uuid>) not found.` |
| `addClient` success | `{ id: <uuid>, clientName }`; `client(id)` returns `email: null, phone: null` when unset |
| `payRequestList` for an unknown externalId | `[]` |
| `disconnectFromPartner` | returns `{ id: <firmId> }` and **revokes the calling token immediately** (next call → `Token has been revoked.`) |
| Legal Wave `GET /api/session` after the token was revoked out-of-band | verified on the hosted demo: the route catches the error, sets `firm.glApiToken` to `null` in the DB, and the response has no `glFirm`. Home then shows the connect splash again. This is the recovery path `api-routes.spec` must cover via `POST /__control/firms/:id/revoke-tokens`. |
| `sandboxOnlyActivateFirm` (no args) with a **firm** token | works: firm → `status: "ACTIVE"`, `isAcceptingPayments: true`, default operating + trust accounts created. Mock control `activate` mirrors this real mutation. |
| `bankAccountsList` | `{ bankAccounts: [BankAccount] }` — no `total`. `BankAccount` fields: `id accountHolderName accountType category("operating"\|"trust") isDefault isFeeAccount isChargebackAccount lastFour nickname routingNumber firmId` |

Token prefixes for the mock: `p_secret_mock_`, `f_secret_mock_`, `pay_public_mock_`, `spm_public_mock_`, `onboarding_public_mock_`.

Two additional quirks observed on the **hosted** demo (`confido-legal-wave.vercel.app`), to be asserted by `api-routes.spec` against the local build:
`GET /api/session` returns the user's **plaintext password** (`user.password`) and the **Confido firm secret token** (`firm.glApiToken`) to the browser.

Selectors the app exposes (there are **no** `data-testid`s in the app; use roles and labels):

| Screen | Selectors |
|---|---|
| Sign up | labels `Firm name`, `Username`, `Password`; button `Sign up`/submit |
| Login | labels `Username`, `Password`; submit |
| Home (unconnected) | heading `Let's get started 🚀`; accordion buttons `Connect`, `Sign Up Link`, `Onboarding.js`; link text = connect URL; buttons `Sign Up For Confido Legal`, `Apply Now!` |
| Home (connected) | text `Connected to Confido Legal ✅`; badge `Ready` or `Pending` — **must use `getByText('Ready', { exact: true })`**, because the status sentence above the badge also contains the word (`Your payments application is approved…` / `…is pending…`), so a loose match is a strict-mode violation; button `Disconnect`; button `Complete application` (pending only); heading `Let's collect some money 💸🤑` (ready only); three cards `Payment Intents`, `Stored Payment Methods`, `Payment Links` with `Try it out` |
| Sidebar | `Home`, `Payment Intents`, `Stored Payment Methods`, `Clients` |
| Payment Intents | label `Amount` (placeholder `$10.00`), `Name` (input id `name`), `Email for receipt`; tabs `Card`, `Bank Account`; checkboxes `Store payment method` and `Send receipt (...)`; submit button **`Run payment`** (plus a second button `Submit fields only (test)`); hosted-field labels `Card Number`, `Exp`, `CVV`, `Account Name`, `Account Number`, `Routing Number`; result heading `Success!`; `Lookup Pay Request by External ID` box with `Lookup` button; modal heading `Pay Request Data`; `Collect more`. Surcharge notice text is `a 3% surcharging fee will be added`, plus an alert `A fee of $X.XX will be added to your total.` |
| Paylinks | label `Amount` (renders **no** value — the amount is printed as a bare `<Text>` above it), `Email for receipt`, tabs, checkbox `Store payment method`, submit button `Run payment` |
| Stored Payment Methods | button `Save New Payment Method`; modal heading `Save a Payment Method`, text `Loading...` while the token is fetched, labels `Client name`, `Email`; tabs; buttons `Save` / `Cancel`; result heading `Success!` then `Close` |
| Clients | button `Add client`; modal heading `Add a Client`, label `Client Name`, submit button `Add Client`; result heading `Added client`; button `Request client by id`; heading `Requested client` |
| Transactions | static template: text `Showing 1 to 5 of 42 results`, 5 rows |
| Card brand icon | `CreditCardBrandIcon` inlines an SVG via `@svgr/webpack` with **no** title, `alt` or `aria-label`. Distinguish by brand fill: visa `path[fill="#0E4595"]` (3 paths), mastercard `path[fill="#D9222A"]` (7 paths), generic `path[fill="#9D9400"]`. |
| Owner form | `Invalid url` alert when no `o_code` |
| Standing link iframe | `No standing link URL provided` |

---

## 1. Directory layout (all new)

```
e2e/
  package.json            own deps; NOT the root package.json
  package-lock.json
  .gitignore              node_modules, test-results, playwright-report, blob-report
  tsconfig.json
  playwright.config.ts
  PLAN.md                 this file
  QUIRKS.md               app behaviours we had to encode rather than fix
  README.md               how to run, how the mock works, how to add a scenario
  mock-server/
    schema.graphql        real sandbox SDL (already present)
    server.ts             boots yoga + control API + static shims + fake app pages (plain node http or hono)
    store.ts              in-memory state (see §3)
    resolvers.ts          hand-written resolvers for the 14 operations + auth
    mocks.ts              scalar mocks + list-length defaults for addMocksToSchema
    events.ts             ring buffer of every GraphQL operation received
    fake-app/             HTML for /app/connect/:appId, /app/signup/:code, /app, /iframe-target
    scripts/refresh-schema.ts   re-introspects sandbox → schema.graphql (manual, opt-in)
  shims/
    hosted-fields.js      window.gravityLegal
    onboarding.js         window.confidoOnboarding
  fixtures/
    test.ts               extended `test` with fixtures: lockdown, shims, mock, user, connectedUser
    mock-client.ts        typed helpers for /__control
    legal-wave.ts         page helpers (signupViaApi, loginViaUi, connectViaCallback, ...)
    cards.ts              test card/ACH constants mirroring Confido's documented sandbox values
  specs/
    auth.spec.ts
    home-connect.spec.ts
    home-signup-link.spec.ts
    home-onboarding.spec.ts
    payment-intents.spec.ts
    paylinks.spec.ts
    stored-payment-methods.spec.ts
    clients.spec.ts
    transactions.spec.ts
    owner-form.spec.ts
    standing-link.spec.ts
    webhooks.spec.ts
    api-routes.spec.ts
    network-isolation.spec.ts
    contract-drift.spec.ts     opt-in, live introspection diff, report-only
```

Pinned deps for `e2e/package.json` (versions current as of 2026-09-08):

```
@playwright/test 1.63.x   graphql 16.8.x (match root)   graphql-yoga 5.22.x
@graphql-tools/schema 10.x   @graphql-tools/mock 9.x   tsx (latest)   typescript 5.x
```

Scripts: `"test": "playwright test"`, `"test:ui": "playwright test --ui"`, `"mock": "tsx mock-server/server.ts"`,
`"refresh-schema": "tsx mock-server/scripts/refresh-schema.ts"`.

---

## 2. Playwright config

```ts
// e2e/playwright.config.ts (shape, not final code)
const MOCK = 'http://127.0.0.1:7002';
const APP  = 'http://127.0.0.1:7001';
const appEnv = {
  ...process.env,
  CONFIDO_API_ENDPOINT: `${MOCK}/v2`,
  CONFIDO_PARTNER_TOKEN: 'p_secret_mock_partner',
  NEXT_PUBLIC_CONFIDO_APP_DOMAIN: `${MOCK}/app`,
  NEXT_PUBLIC_CONFIDO_SDK_URL: `${MOCK}/js/hosted-fields.js`,
  NEXT_PUBLIC_CL_ONBOARDING_JS_URL: `${MOCK}/js/onboarding.js`,
  GL_WEBHOOK_SECRET: 'mock-webhook-secret',
  GL_LEGACY_WEBHOOK_SECRET: 'mock-legacy-secret',
  NODE_ENV: 'production',
};
export default defineConfig({
  testDir: 'specs',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,          // SQLite + Prisma; raise only if stable
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000, expect: { timeout: 15_000 },
  use: { baseURL: APP, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npx tsx mock-server/server.ts', url: `${MOCK}/healthz`, reuseExistingServer: !process.env.CI, timeout: 30_000 },
    { command: 'npm run reset-db && npm run build && npm run start', cwd: '..', env: appEnv,
      url: `${APP}/login`, reuseExistingServer: !process.env.CI, timeout: 240_000 },
  ],
});
```

Notes: real `process.env` beats `.env.local` in Next, so a stray `.env.local` cannot leak the
sandbox in. The root `node_modules` must exist (`npm ci` at repo root) because the webServer
command runs root scripts. Do **not** add a root script; document `npm --prefix e2e test`.

---

## 3. Mock server

### 3.1 GraphQL

* `makeExecutableSchema({ typeDefs: schema.graphql, resolvers })`, then
  `addMocksToSchema({ schema, preserveResolvers: true, mocks })` so anything not hand-written is
  auto-generated and type-correct. Scalar mocks: `DateTimeISO → new Date().toISOString()`,
  `JSON → {}`, `BigInt → "0"`.
* Serve with graphql-yoga at **both** `/v2` and `/` (`graphqlEndpoint` accepts a pattern or mount two).
  `maskedErrors: false` so error messages reach the app verbatim.
* Auth from `x-api-key`:
  * `p_secret_mock_partner` → partner context.
  * `f_secret_mock_<firmId>` → firm context if issued and not revoked.
  * anything else → reproduce the real shapes in §0.1: unknown token → HTTP **500** `Context creation failed: Invalid firm token.`;
    revoked token → HTTP **500** `Context creation failed: Token has been revoked.`; missing header → HTTP **200**
    with `data: null` and `Access denied! You don't have permission for this action!`.
    (`graphql-request` throws on all three; `/api/session` catches and nulls the stored token — that path is a test.)
  * Use `extensions.code: "USER_INPUT_ERROR"` for not-found/validation errors and `"INTERNAL_SERVER_ERROR"` for business-rule errors, matching §0.1.
* Record every operation in `events.ts`: `{ ts, operationName, tokenKind, firmId, variables, ok, errorMessage }`.

### 3.2 Store (in memory, keyed so parallel tests never collide)

```
partner: { id:'partner_mock', appId:'mock-app' }
firms:   Map<firmId, { id, name, status: FirmStatus, isAcceptingPayments, surchargingEnabled, tokens:Set, revokedTokens:Set }>
connectCodes: Map<code, { firmId, used }>
onboardingTokens: Map<token, firmId>
signUpLinks: Map<code, firmId>
clients: Map<clientId, { firmId, clientName, email?, phone? }>
sessions: Map<token, { kind:'payment'|'spm', firmId, paymentLink?:{id,totalAmount}, staged?: StagedInstrument, used:boolean }>
payments: Map<paymentId, { firmId, externalId, status, amount, method, transactions:[...], storedPaymentMethod? }>
spms: Map<id, { firmId, lastFour, cardBrand, paymentMethod, payerName }>
```

### 3.3 Hand-written resolvers (exactly the 14 operations the app uses)

| Operation | Behaviour |
|---|---|
| `Query.me` (partner) | `{ partner }` |
| `Query.firm` (firm) | `{ id, name, isAcceptingPayments }` |
| `Query.client(id)` (firm) | from store, else `USER_INPUT_ERROR` `Client with id(<uuid>) not found.` (§0.1 wording wins over the looser `Client not found` written here originally) |
| `Query.payRequestList(input{externalId, firmId})` | payments with that `externalId` → `[{ externalId, transactions:[{ id, status_v2:'SUCCESSFUL' }] }]` |
| `Mutation.createFirm(input{name, mockOnboarding})` (partner) | new firm; `status = mockOnboarding ? ACTIVE : CREATED`; `isAcceptingPayments = mockOnboarding`; returns `apiToken`, `onboardingToken{token,expiresAt}`, `signUpLink{ link: ${MOCK}/app/signup/<code>, expiresAt }` |
| `Mutation.createFirmSignUpLink` (firm) | new link for that firm |
| `Mutation.createOnboardingToken` (firm) | new token |
| `Mutation.exchangeCodeForFirmApiToken(code)` (partner) | one-time; returns new firm token; second use → error `Invalid or expired code` |
| `Mutation.disconnectFromPartner` (firm) | revoke the calling token; `{ id }` |
| `Mutation.createPaymentToken(input)` (firm) | new payment session `pay_public_mock_<n>`; if `paymentLinkId` set, attach `paymentLink:{ id, totalAmount: 25000 }` |
| `Mutation.createSavePaymentMethodToken(input)` (firm) | `spm_public_mock_<n>` |
| `Mutation.paymentSessionComplete(input)` (firm) | see decision table below |
| `Mutation.completeSavePaymentMethod(input)` (firm) | requires staged instrument; returns `{ id, lastFour }`; stores SPM |
| `Mutation.addClient(input{clientName, firmId})` (firm) | `firmId` must equal token's firm, else `USER_INPUT_ERROR` `Firm with id(<uuid>) not found.` (**not** `Forbidden` — §0.1 wins); returns `{ id, clientName }` |

**Operation names the mock records** (what `/__control/events` matches on — these come from the
`gql` documents in `src/confido-legal-requests/`, so spell them exactly):
`GetMyPartner`, `GetFirm`, `GetClient`, `PayRequestList`, `CreateFirm`, `CreateFirmSignUpLink`,
`CreateOnboardingToken`, `ExchangedCodeForFirmToken` (**note the app's typo — not `Exchange…`**,
`src/confido-legal-requests/exchangeCodeForFirmToken.ts:6`), `DisconnectFromPartner`,
`CreatePaymentToken`, `CreateSavePaymentMethodToken`, `PaymentSessionComplete`,
`CompleteSavePaymentMethod`, `AddClient`.

**Recorded `variables` are the raw wire variables.** For `CreateSavePaymentMethodToken` that means
`{variables: {input: {}}}`, not `{input: {}}`, because the app passes an options wrapper where
graphql-request expects variables (QUIRKS.md #5). Assert the malformed shape on purpose.

`paymentSessionComplete` decision table (mirrors Confido's documented sandbox test values so the
suite reads like their docs):

| Staged instrument | Result |
|---|---|
| none staged (shim never submitted) | CREDIT/DEBIT → error `binData is required for card payments` (§0.1 wins); ACH → `No payment method submitted for this session` |
| session already used | error `Payment session already completed` |
| card `4242424242424242` | `status:"success"`, one transaction `amountProcessed = amount` |
| card `4000056655665556` | success, `paymentMethod` DEBIT |
| card `4000300011112220` | error `Card declined` |
| card `4000100000000000` | error `Card declined` **only if** `amount > 10000`, else success |
| ACH routing `000000000` or account `0000000000` | error `Invalid bank account` |
| any other ACH | success |
| `savePaymentMethod:true` and success | also returns `storedPaymentMethod{ id, lastFour, cardBrand, payerName, paymentMethod }` |
| `sendReceipt`, `payerEmail`, `payerName` | not validated; recorded in events so tests can assert the app forwarded them |

### 3.4 Control API (`/__control/*`, JSON, `Access-Control-Allow-Origin: *`)

```
POST /__control/reset
GET  /__control/state                          full dump (debugging)
GET  /__control/events?since=<ts>&op=<name>    recorded GraphQL operations
GET  /__control/firms/by-token/:token
POST /__control/firms/:id/activate             status ACTIVE, isAcceptingPayments true
POST /__control/firms/:id/deactivate
POST /__control/firms/:id/surcharging          { enabled: boolean }
POST /__control/firms/:id/revoke-tokens
POST /__control/connect/mint                   { name? } → creates ACTIVE firm + one-time code; returns { firmId, code }
GET  /__control/sessions/:token                { kind, paymentLink?, surchargingEnabled } (shim init) or 404
POST /__control/sessions/:token/stage          body = instrument from shim submitFields
POST /__control/onboarding/:token/submit       firm → APP_SUBMITTED
POST /__control/paylinks/seed                  { id, totalAmount } → seeds the hardcoded Paylinks id (§0.1)
GET  /healthz
```

### 3.5 Fake Confido app pages (served under `/app`, matches `NEXT_PUBLIC_CONFIDO_APP_DOMAIN`)

* `GET /app/connect/:appId?state=` → HTML with heading `Authorize Legal Wave` and a form button
  `Authorize`. POST creates an ACTIVE firm named `Connected Firm <n>` + one-time code and 302s to
  `http://127.0.0.1:7001/api/gravity-callback?code=<code>&state=<state>`.
  (Real Connect uses a callback URL registered in the partner portal; the mock hardcodes it.)
* `GET /app/signup/:code` → HTML `Mock Confido sign-up for <firm name>`.
* `GET /app` → HTML placeholder (the "sandbox" link target).
* `GET /iframe-target` → HTML `Mock standing link` (for the standing-link iframe test).
* `GET /js/hosted-fields.js`, `GET /js/onboarding.js` → the shim files (same files the fixture injects).

---

## 4. Browser SDK shims

Both shims are plain ES2019 JS, no build step, idempotent, and read the mock URL from
`window.__CONFIDO_MOCK_URL` (set by the fixture's `addInitScript`; default `http://127.0.0.1:7002`).

### 4.1 `hosted-fields.js` → `window.gravityLegal`

* `init(options)`: store token = `options.paymentToken ?? options.savePaymentMethodToken`. For each
  key in `options.fields`, find the container by `containerId` and append
  `<input data-testid="hf-<key>" aria-label="<key>" autocomplete="off">` (skip if already present).
  Initialise state:
  `{ activeForm, fields:{ <key>:{ containerId, loading:false, error:null } }, loading:false, paymentProcessing:false, surcharging:{ active:false, amount:null, willBeApplied:false } }`.
  Then `GET /__control/sessions/:token`: 404 → `state.loadError = new Error('Invalid payment token')`;
  otherwise set `state.paymentLink = { totalAmount }` if present and remember `surchargingEnabled`.
  Emit a change event. Input listeners update state and emit events.
* Card brand detection from the number: `4→visa`, `5|2→mastercard`, `3→amex`, `6→discover`.
  `paymentMethod`: card form → `CREDIT` (`DEBIT` for `4000056655665556`); ach form → `ACH`.
* `recalculateSurcharging({ principalAmount })`: if firm surcharging enabled and `activeForm==='card'`
  and `paymentMethod==='CREDIT'` → `{ active:true, willBeApplied:true, rate:0.03, amount:{ fee: Math.round(principalAmount*0.03) } }`, else `willBeApplied:false`. Emit.
* `setActiveForm(form)`, `getState()`, `addChangeListener`, `removeChangeListener`.
* `submitFields()`: validate the active form (required: card number+exp+cvv, or routing+account+holder).
  Missing → set `fields[x].error = { message: 'Required' }`, emit, return `{ success:false, error:new Error('Invalid fields') }`.
  Else `POST /__control/sessions/:token/stage` with the instrument and return `{ success:true }`.
  Mark `paymentProcessing` true/false around the call.
* Expose `window.__hostedFieldsShim = { version: 1 }` so tests can assert the shim is active.

### 4.2 `onboarding.js` → `window.confidoOnboarding`

* `renderForm({ containerId, token, onChange })`: render `<form data-testid="onboarding-form">` with
  inputs `Legal business name`, `EIN` and a button `Submit application`. On submit `POST
  /__control/onboarding/:token/submit`, replace with text `Application submitted`, call
  `onChange({ type:'submitted' })`.
* `renderOwnerForm({ code, containerId })`: render `<div data-testid="owner-form">Owner form for <code></div>`.
* `refresh()`: no-op.

---

## 5. Fixtures (`fixtures/test.ts`)

* **`lockdown`** (auto): `context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, handler)`.
  * If the URL is `https://api.sandbox.gravity-legal.com/v2` → forward: `route.fetch({ url: MOCK + '/v2' })` and `route.fulfill` with the response (this is the Clients page's browser-side call).
  * Anything else → `route.abort()` and push to `escaped[]`. In teardown, fail the test if any escaped
    request has `resourceType` in `document|script|xhr|fetch|websocket`. Images/fonts (the template's
    `bit.ly` avatars, `tinyurl` profile image) are aborted silently.
* **`shims`** (auto): `context.addInitScript` that sets `window.__CONFIDO_MOCK_URL` then evaluates both shim files.
* **`mock`**: typed client for the control API.
* **`user`**: `POST /api/signup` via `context.request` with `firmName: 'Firm <id>'`, `username: 'u_<worker>_<rand>'`,
  `password: 'pw'`; the cookie `wave:userId` lands in the context. Returns `{ username, password, firmName }`.
* **`connectedUser`**: `user` + `mock.connect.mint()` + `page.goto('/api/gravity-callback?code=…&state=t')`
  → follows redirect to `/`. Returns `{ ...user, firmId, firmToken }`.
* **`pendingFirmUser`**: `user` + `POST /api/get-sign-up-link` (creates a non-accepting firm).

Never use fixed sleeps; wait on locators, responses (`page.waitForResponse('**/api/complete-payment')`),
or `expect.poll` against `/__control/events`.

---

## 6. Spec inventory (definition of "all functionality")

Each bullet is at least one test. `[quirk]` = encode current behaviour and annotate.

**auth.spec**
- Sign up via UI → lands on `/`, shows `Let's get started`, cookie `wave:userId` set.
- Login via UI with correct password → `/`.
- Login with wrong password `[quirk: /api/login returns HTTP 200 with body "403"; the page still redirects to /, which bounces to /signup]`.
- `/logout` → redirected to `/login`, cookie cleared.
- Logged-out visits to `/`, `/payment-intents`, `/paylinks` redirect to `/signup`.
- Logged-out visit to `/clients`, `/stored-payment-methods`, `/transactions` (no `requireAuth`) → observe and encode `[quirk if it errors]`.

**home-connect.spec**
- Unconnected home: three accordion options; the Connect link `href` equals `${MOCK}/app/connect/mock-app`.
- Click Connect → popup → `Authorize` → callback → main page reloaded shows `Connected to Confido Legal ✅`, firm name, truncated id `xxxxxx...xxxxxx`, `Ready`, `Let's collect some money`, three vehicle cards each with `Try it out` linking to the right route.
- `Disconnect` → splash returns; events contain `disconnectFromPartner`; `/api/session` shows `firm.glApiToken === null`.
- Reusing a connect code → callback 500 `[quirk: unhandled error]`.

**home-signup-link.spec**
- `Sign Up For Confido Legal` → popup URL matches `${MOCK}/app/signup/`; events contain `createFirm` with `mockOnboarding:false`; `/api/session` shows a `f_secret_mock_` token; home shows `Pending`, `Complete application`, the sandbox info alert; payment cards hidden.
- Second click → events contain `createFirmSignUpLink` (not `createFirm`).
- `mock.firms.activate(firmId)` → reload → `Ready`.

**home-onboarding.spec**
- `Apply Now!` → modal → shim form visible → `Submit application` → `Application submitted` → close → home shows `Pending`; events contain `createFirm` and firm status is `APP_SUBMITTED` in `/__control/state`.
- On a pending firm, `Complete application` opens the modal and events contain `createOnboardingToken`.

**payment-intents.spec** (connectedUser)
- Page renders; six hosted-field inputs present; spinners gone.
- Typing `4242…` shows the Visa brand icon (inspect `CreditCardBrandIcon` for the accessible hook; fall back to `img[alt]` or `svg` presence).
- Happy path card: amount `$10.00`, name, email, submit → `Success!`; JSON contains `"status": "success"` and `"amountProcessed": 1000`; events show `paymentSessionComplete` with `method:'CREDIT'`, `payerEmail`, `sendReceipt`.
- `Lookup Pay Request by External ID` with the externalId from the result → modal `Pay Request Data` containing that externalId.
- Decline card `4000300011112220` → no `Success!`; `[quirk: the app swallows non-OK responses; no error is shown]`; events show the error.
- `4000100000000000` with `$150.00` → declined; with `$50.00` → success.
- `Bank Account` tab, valid routing/account → success with `method:'ACH'`; routing `000000000` → declined.
- `savePaymentMethod` checked → result JSON contains `storedPaymentMethod.lastFour: "4242"`.
- Surcharging enabled via control → typing amount shows `3% surcharging` notice and fee alert; ACH tab hides it.
- Empty card fields → shim validation error shown under the field; no API call.
- Unconnected user visits `/payment-intents` → `[quirk: server-side 500 because createPaymentToken is called with a null token]` assert status 500.
- `Collect more` reloads and issues a fresh `createPaymentToken`.

**paylinks.spec** (connectedUser)
- Page renders (mock accepts the hardcoded link id); events show `createPaymentToken` with that `paymentLinkId`.
- Submit with `4242` → `Success!`; `amountProcessed === 25000` (came from `state.paymentLink.totalAmount`).

**stored-payment-methods.spec** (connectedUser)
- `Save New Payment Method` → modal shows `Loading...` then fields; events show `createSavePaymentMethodToken`.
- Fill client name/email + card → `Success!` JSON with `lastFour: "4242"`; events show `completeSavePaymentMethod` with `paymentMethod:'CREDIT'`.
- ACH variant.
- Submit with empty fields → error alert, no API call.
- Unconnected user → observe `[quirk]` (create-token 500 → modal state).

**clients.spec** (connectedUser)
- `Add client` → `Client Name` → submit → `Added client` JSON with `clientName`; the request went to the **intercepted sandbox URL** and was forwarded (assert via events + `lockdown` forward counter).
- `Request client by id` → `Requested client` JSON with same id.
- Empty name → `Client name cannot be empty.`
- Unconnected user → `Firm ID is missing…` message.

**transactions.spec**
- Renders the static template: `Showing 1 to 5 of 42 results`, five rows, `Kent C. Dodds` present `[quirk: page is an unmodified Chakra template; not in sidebar]`.

**owner-form.spec**
- `/owner-form?o_code=owner_abc` → shim renders `Owner form for owner_abc`.
- `/owner-form` → `Invalid url`.

**standing-link.spec**
- `/iframes/standinglink?url=${MOCK}/iframe-target` → iframe `src` equals the URL and frame body contains `Mock standing link`.
- No `url` → `No standing link URL provided`.

**webhooks.spec** (request-only)
- Valid `x-signature` → status 200, body `200`; console-free.
- Invalid signature → `[quirk: status 200, body "400"]`.
- Legacy endpoint with `x-prahari-signature`, both cases.

**api-routes.spec** (request-only)
- `GET /api/session` no cookie → `{}`; with cookie → `user`, `firm`; connected → `glFirm`.
- Revoke tokens via control → `GET /api/session` → `firm.glApiToken` null (token-revoked recovery path).
- `POST /api/pay-request-lookup` unconnected → 400 `Firm not connected`; connected with unknown externalId → 200 empty list.
- `POST /api/disconnect` unconnected → `[quirk: body "200"]`.
- `POST /api/get-sign-up-link` and `/api/onboarding/create-onboarding-code` without cookie → 500 `[quirk: throws "user not found"]`.

**network-isolation.spec**
- Full happy path (signup → connect → payment) with a **strict** lockdown that fails on *any* escaped request including images, proving the suite is credential- and network-free. Uses `route.abort` counts, not timing.

**contract-drift.spec** (skipped unless `CONFIDO_LIVE_INTROSPECT=1`)
- Introspect the real sandbox, `printSchema`, compare with `schema.graphql` using `graphql`'s `findBreakingChanges`/`findDangerousChanges`; attach the diff as a test attachment; fail only on breaking changes to the 14 operations we implement. Never requires credentials (introspection is open).

---

## 7. Execution phases (each ends with `npm test` green and a commit)

**Phase 0 — scaffold (≈1h).** `e2e/package.json`, tsconfig, `.gitignore`, `playwright.config.ts`,
`mock-server/server.ts` serving only `/healthz`. `npx playwright install chromium`. One trivial spec
that hits `/healthz`. Confirm `git status` shows only `?? e2e/`.

**Phase 1 — mock + auth + connect (≈3h).** Schema load, auth, `me`, `firm`, `createFirm`,
`exchangeCodeForFirmApiToken`, `disconnectFromPartner`, `createFirmSignUpLink`,
`createOnboardingToken`; control API; fake connect page; fixtures `user`/`connectedUser`;
`auth.spec`, `home-connect.spec`, `home-signup-link.spec`, `api-routes.spec` (session parts).
Playwright webServer starts both servers; Next is built with the mock env.

**Phase 2 — shims + payments (≈3h).** Both shims, `createPaymentToken`, `paymentSessionComplete`,
`payRequestList`, `createSavePaymentMethodToken`, `completeSavePaymentMethod`, `addClient`,
`client`; fixture `shims`; `payment-intents.spec`, `paylinks.spec`, `stored-payment-methods.spec`,
`clients.spec`, `home-onboarding.spec`.

**Phase 3 — the rest + lockdown (≈2h).** `lockdown` fixture with sandbox-URL forwarding;
`transactions`, `owner-form`, `standing-link`, `webhooks`, remaining `api-routes`,
`network-isolation`, `contract-drift`. Write `QUIRKS.md` from the annotations. Write `README.md`.

**Phase 4 — CI (≈1h).** `.github/workflows/e2e.yml`: Node 24, `npm ci` at root, `npm ci` in `e2e`,
`npx playwright install --with-deps chromium`, `npm --prefix e2e test`, upload `playwright-report`
on failure. No secrets configured anywhere. This is the proof for the maintainers: green on a fork
with zero credentials.

---

## 8. Rules for the implementing agent

1. Never modify or delete any pre-existing file. If you believe you must, stop and write the reason in `QUIRKS.md` instead.
2. Never put a real token anywhere. The only token literal in the repo is `p_secret_mock_partner`.
3. No `test.skip`/`test.fixme` to hide a failure; a failing test either gets fixed in the harness or becomes an annotated quirk asserting real behaviour.
4. No `waitForTimeout`. Wait on UI, responses, or `expect.poll` over `/__control/events`.
5. Keep the mock honest to the SDL: when unsure of a type or enum, grep `mock-server/schema.graphql` (e.g. `PaymentStatus` is lowercase `success`, `FirmStatus` is `ACTIVE`, `TransactionStatus2` is `SUCCESSFUL`).
6. Prefer role/label locators listed in §0. Do not add `data-testid` to the app.
7. Commit at the end of each phase with a message that names the phase. Run the additive check from the top of this file before each commit.
8. When a page does something surprising, read the source under `src/` to explain it, then encode it. The surprises are deliverables.

---

## 9. Delegation map: how to split this across sub-agents

The lead agent owns integration, the green run, and commits. Sub-agents own **disjoint files**.
The contracts between them are already frozen in this document, so parallel work integrates:

| Contract | Defined in | Consumed by |
|---|---|---|
| Control API routes and JSON shapes | §3.4 | shims, fixtures, specs |
| Store record shapes | §3.2 | resolvers, control API, fake app |
| `window.gravityLegal` / `window.confidoOnboarding` interfaces | §4 + `src/confido-legal-hook/ConfidoLegal.d.ts` | fixtures, specs |
| Fixture names and return types | §5 | specs |
| Env var names and ports | §2 | everything |

If a sub-agent needs to change a contract, it must stop and report; the lead updates this file first,
then work resumes. Contracts never change silently.

### 9.1 Units of work and their ownership

| Unit | Owns (exclusively) | Depends on | Parallel with |
|---|---|---|---|
| **S** store + types | `mock-server/store.ts`, `mock-server/types.ts` | nothing | — (do first, ~30 min, lead does it) |
| **G** GraphQL layer | `mock-server/resolvers.ts`, `mocks.ts`, `events.ts`, the yoga part of `server.ts` | S | C, H, F |
| **C** control API + fake app | `mock-server/control.ts`, `mock-server/fake-app/*` | S | G, H, F |
| **H** shims | `shims/hosted-fields.js`, `shims/onboarding.js` | §3.4 contract only | G, C, F |
| **F** fixtures + config | `playwright.config.ts`, `fixtures/*` | §3.4 + §4 contracts only | G, C, H |
| **T1** specs: auth, home-connect, home-signup-link, home-onboarding | those four spec files | G, C, F running | T2, T3, T4 |
| **T2** specs: payment-intents, paylinks | those two | G, C, H, F running | T1, T3, T4 |
| **T3** specs: stored-payment-methods, clients, transactions | those three | same | T1, T2, T4 |
| **T4** specs: owner-form, standing-link, webhooks, api-routes, network-isolation, contract-drift | those six | same | T1, T2, T3 |
| **D** docs + CI | `README.md`, `QUIRKS.md` consolidation, `.github/workflows/e2e.yml` | all green | — (last) |

`server.ts` is written **once, by the lead, in Phase 0** and never edited again. It does routing only
and mounts two modules by a frozen interface:

* `mock-server/graphql.ts` (unit **G**) — `export function isGraphQLPath(pathname: string): boolean`
  and `export async function handleGraphQL(req, res): Promise<void>`. Reached for `/v2`, `/graphql`,
  and `POST /`.
* `mock-server/control.ts` (unit **C**) — `export async function handleControl(req, res): Promise<void>`.
  Reached for everything else (`/__control/*`, `/app/*`, `/js/*`, `/iframe-target`, else 404).

`server.ts` itself answers `GET /healthz` and `GET /`. Phase 0 lands both modules as stubs that G and
C replace wholesale. The lead also wrote `mock-server/types.ts` (all shared type contracts) and
`mock-server/events.ts` (`recordEvent` / `queryEvents` / `eventCount` / `resetEvents`) in Phase 0, so
G and C share them read-only rather than negotiating.

### 9.2 Scheduling

```
Phase 0  lead: scaffold, healthz, S (store + types), server.ts skeleton          serial
Phase 1  fan out: G | C | H | F                                                   4 parallel sub-agents
         lead: integrate, start servers, run T1 subset by hand until green
Phase 2  fan out: T1 | T2 | T3 | T4                                               4 parallel sub-agents
         lead: run full suite, triage, hand failures back to the owning agent
Phase 3  lead: lockdown hardening, QUIRKS.md consolidation
Phase 4  D (can be one sub-agent), lead pushes and watches CI
```

### 9.3 Rules that make parallel work safe

1. **Only the lead starts the servers.** Ports 7001 and 7002 are single-occupancy. Sub-agents building
   G/C/H/F verify with `npx tsc --noEmit -p e2e` and `node --check` on the shims; they do **not**
   run `npm test`.
2. **Spec sub-agents (T1–T4) run against the lead's already-running servers.** The lead starts them
   once with `npm run mock &` and the Next build/start from §2 (or a first `npm test` with
   `reuseExistingServer: true`, which leaves them up). Sub-agents then run only their own files:
   `npx playwright test specs/<name>.spec.ts`. Concurrent Playwright runs against the shared servers
   are safe because every test creates its own user and firm.
3. **Read-only exploration is always allowed and encouraged.** Any agent may spawn an Explore
   sub-agent with a question like "what accessible name does `CreditCardBrandIcon` render for Visa;
   cite file and line" instead of guessing.
4. **One writer per file.** If two units need the same file, the lead owns it.
5. **Quirks go through the lead.** Sub-agents report a suspected quirk with file:line evidence;
   the lead writes the `QUIRKS.md` entry so wording is consistent and duplicates are merged.
6. **Sub-agents do not commit.** The lead commits at phase boundaries after the additive check.
7. **Hand back format** for every sub-agent: files written, verification command run and its result,
   any contract it wished were different, any quirk suspected (with evidence). No claims of "works"
   without a command output to back it.

## 10. Out of scope here (separate tracks, noted for later)

* **Deploying the fork to Vercel.** SQLite on Vercel's read-only filesystem will not work; the
  deploy needs a hosted Prisma datasource (Postgres/Turso) which means editing `prisma/schema.prisma`,
  so it is not additive. Also the Connect callback URL must be registered in the partner portal for a
  real deployment. A mock-backed public demo is possible by hosting `mock-server` on an always-on box
  (Fly/Railway) and pointing the Vercel env vars at it, but the in-memory store would need a small
  persistence layer first.
* Fixing the quirks. Each `QUIRKS.md` entry is a candidate PR after the suite exists to catch regressions.
