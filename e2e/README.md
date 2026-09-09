# Legal Wave end-to-end suite

A Playwright suite that exercises every user-facing and API-route behaviour of Legal Wave against a
**local mock of the Confido GraphQL API**. It passes on a clean clone with **no Confido credentials
and no network access to Confido**.

**120 tests across 16 spec files.** A cold run — wiped database, fresh `next build`, both servers
started from scratch — is 119 passed, 1 skipped, in about two minutes. The single skip is the
opt-in live-introspection check described under *Proving it is credential-free*.

Beyond the app code itself, exactly one line changes outside `e2e/`; see *The one file changed
outside `e2e/`* below. The suite also produced [`QUIRKS.md`](./QUIRKS.md) — **26 app behaviours** it
had to encode rather than fix, each reproduced and cited to `file:line`. That document is a
deliverable in its own right; start with the five marked High: #15 (loading the home page silently
creates a Confido firm), #21 (the app server-renders nothing), #2 (the session endpoint returns the
plaintext password and the Confido firm secret), #10 (Connect never round-trips a `state` parameter)
and #25 (the standing-link page frames any URL a query parameter names).

## Run it on a fresh machine

Nothing but Node and a browser download. **No `.env` file, no Confido credentials, no accounts, no
network access to Confido.** Verified from a clean clone on 2026-09-09 — the exact commands below,
in order, ending in 119 passed.

**Prerequisites:** Node **20+** (24 is what CI and local dev use; there is no `engines` field, so
nothing enforces it), npm, and ports **7001** and **7002** free.

```bash
git clone https://github.com/whitmanschorn/confido-legal-wave.git
cd confido-legal-wave

npm ci                                        # app deps; postinstall creates prisma/legal-wave.sqlite
npm --prefix e2e ci                           # suite deps (its own package.json, not the root one)
npx --prefix e2e playwright install chromium  # on Linux: add --with-deps (needs sudo)

npm --prefix e2e test
```

Expected, and what a green run looks like:

```
Running 120 tests using 3 workers
...
  1 skipped
  119 passed (2.2m)
```

The first run takes ~2 minutes because Playwright's `webServer` resets the SQLite database, runs
`next build` with the mock environment, and starts both servers. Locally, later runs reuse the
running servers (`reuseExistingServer`) and take seconds; CI never reuses.

**The one skip is intentional** — `contract-drift`'s live-introspection test, which needs network to
Confido and is gated behind `CONFIDO_LIVE_INTROSPECT=1`. Everything else runs offline.

| | |
|---|---|
| Legal Wave | `http://127.0.0.1:7001` (port fixed in the root `package.json`) |
| Mock Confido API | `http://127.0.0.1:7002` |

`127.0.0.1` everywhere, never `localhost` — they are different origins to a browser, and the lockdown
fixture keys off the hostname.

### Useful variants

```bash
npm --prefix e2e test -- specs/payment-intents.spec.ts   # one spec file
npm --prefix e2e test -- -g "declined"                   # one test by name
npm --prefix e2e run test:ui                             # Playwright UI / watch mode
npm --prefix e2e run mock                                # just the mock, to poke by hand
CONFIDO_LIVE_INTROSPECT=1 npm --prefix e2e test -- specs/contract-drift.spec.ts
```

For the edit-run-edit loop, see [QA: the local TDD loop](#qa-the-local-tdd-loop) — starting the
servers once yourself turns a 2-minute run into a 2-second one.

### Watching the tests run

The default config keeps artifacts only on failure — right for CI, but it means a green run leaves
nothing to look at. `playwright.artifacts.config.ts` forces video, a full-page screenshot and a trace
for **every** test and emits the browsable HTML report:

```bash
cd e2e
npx playwright test --config playwright.artifacts.config.ts \
  specs/auth.spec.ts specs/home-connect.spec.ts specs/home-signup-link.spec.ts \
  specs/home-onboarding.spec.ts specs/payment-intents.spec.ts specs/paylinks.spec.ts \
  specs/stored-payment-methods.spec.ts specs/clients.spec.ts specs/transactions.spec.ts \
  specs/owner-form.spec.ts specs/standing-link.spec.ts

npx playwright show-report artifacts-report
```

That is 79 of the 120 tests — the ones that drive a browser. `webhooks`, `api-routes` and
`contract-drift` are request-only and would record empty videos, so leave them out.

Everything else is inherited from `playwright.config.ts`, so what you are watching is the suite that
runs in CI, not a special-cased rerun. Expect ~90 MB of artifacts and a slower run; that is why it is
opt-in. Both output directories (`artifacts-report/`, `artifacts-results/`) are gitignored.

The trace is the most useful of the three: it carries a DOM snapshot, the network log and the console
for every step, so you can scrub the timeline and see exactly what the page looked like when an
assertion ran.

### If it doesn't work

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on 7001 or 7002 | Something already holds the port: `lsof -ti:7001,7002 \| xargs kill -9`. Note `next start` spawns a `next-router-worker`, so killing by process name misses it — kill by port. |
| `browserType.launch: Executable doesn't exist` | You skipped `playwright install chromium`, or ran it in the repo root instead of with `--prefix e2e` |
| Missing shared libraries on Linux | `npx --prefix e2e playwright install --with-deps chromium` |
| `next build` fails on a type error in `e2e/` | You are on a checkout without the `tsconfig.json` change; see *The one file changed outside `e2e/`* |
| Suite tries to rebuild every run | Expected unless you started the servers yourself, or you have `CI=1` set |
| Everything fails after you edited a `NEXT_PUBLIC_*` value | Those are inlined at build time — rebuild |

A stray `.env.local` cannot break the suite: Playwright passes the mock environment explicitly to the
`webServer`, and real `process.env` beats `.env.local` in Next, so a real sandbox URL sitting in an
untracked env file will not leak into the run.

## How the mock works

`mock-server/` is a plain Node HTTP server wearing three hats.

**1. The GraphQL API** (`/v2`, and `/` for POST). Built from `mock-server/schema.graphql` — the
**real** sandbox SDL, dumped by unauthenticated introspection of `api.sandbox.gravity-legal.com/v2`,
so every response is type-correct against the schema Confido actually publishes. The 14 operations the
app uses are hand-written in `resolvers.ts`; everything else is auto-generated by
`@graphql-tools/mock`. Auth comes from `x-api-key`, and the mock reproduces the real API's responses
for a bad token exactly — including the fact that an unknown or revoked firm token yields **HTTP 500**
with no `data` key, which is what drives the app's token-recovery path.

Only one token literal exists in this repo: `p_secret_mock_partner`. Firm tokens are minted as
`f_secret_mock_<firmId>`.

**2. A control API** (`/__control/*`). How tests drive mock state and observe it: activate a firm,
enable surcharging, revoke tokens, mint a Connect code, seed a payment link. `GET /__control/events`
returns every GraphQL operation the mock received, which is how specs wait for a server-side call
instead of sleeping. There are no fixed sleeps in this suite.

**3. A fake Confido app** (`/app/*`). The Connect authorize page, the sign-up landing page and an
iframe target, so the OAuth-style connect flow and the sign-up-link flow can complete end to end.

## How the browser SDKs are faked

Legal Wave loads two Confido scripts from `NEXT_PUBLIC_CONFIDO_SDK_URL` and
`NEXT_PUBLIC_CL_ONBOARDING_JS_URL`. `shims/hosted-fields.js` and `shims/onboarding.js` implement
`window.gravityLegal` and `window.confidoOnboarding` against the interface the app declares in
`src/confido-legal-hook/ConfidoLegal.d.ts`.

They are loaded twice over, deliberately: the mock serves them at `/js/*` (so the app's `<script async>`
tag resolves) *and* the `shims` fixture injects them with `addInitScript` (so they are installed before
any app code runs, and the `async` tag can never win the race). They are idempotent, so the double
load is harmless.

The hosted-fields shim renders a real `<input>` into each container the app hands it, which is what
lets tests type a card number with ordinary Playwright locators. `submitFields()` stages the
instrument on the mock, and `paymentSessionComplete` then resolves it through the decision table in
`PLAN.md §3.3` — `4242…` succeeds, `4000300011112220` declines, and so on, mirroring Confido's
documented sandbox values.

## Proving it is credential-free

The `lockdown` fixture routes every non-loopback request. Exactly one URL is forwarded rather than
aborted — `https://api.sandbox.gravity-legal.com/v2`, which the Clients page calls *from the browser*
because the sandbox fallback URL is inlined into the client bundle. It is forwarded to the local mock.
Everything else aborts and is recorded; a test fails if anything of type `document`, `script`, `xhr`,
`fetch` or `websocket` escaped.

`specs/network-isolation.spec.ts` runs a full signup → connect → payment path under a strict mode that
fails on *any* escaped request, images included.

`specs/contract-drift.spec.ts` is the counterweight: opt-in via `CONFIDO_LIVE_INTROSPECT=1`, it
re-introspects the live sandbox and diffs it against `schema.graphql`, so a mock that has quietly
drifted from reality gets caught. It needs no credentials either (introspection is open) and never
runs in CI by default.

## QA: the local TDD loop

The loop you want is **servers up once, then re-run a single spec on every edit**. A full cold run
rebuilds the app and takes ~2 minutes; a warm single-spec run takes ~2 seconds.

### 1. One-time setup

The three install commands from [Run it on a fresh machine](#run-it-on-a-fresh-machine). If
`npm --prefix e2e test` already passes, you are set up.

### 2. Start the servers once and leave them up

```bash
# terminal 1 — the mock Confido API
npm --prefix e2e run mock

# terminal 2 — Legal Wave, built with the mock environment
npm run reset-db
CONFIDO_API_ENDPOINT=http://127.0.0.1:7002/v2 \
CONFIDO_PARTNER_TOKEN=p_secret_mock_partner \
NEXT_PUBLIC_CONFIDO_APP_DOMAIN=http://127.0.0.1:7002/app \
NEXT_PUBLIC_CONFIDO_SDK_URL=http://127.0.0.1:7002/js/hosted-fields.js \
NEXT_PUBLIC_CL_ONBOARDING_JS_URL=http://127.0.0.1:7002/js/onboarding.js \
GL_WEBHOOK_SECRET=mock-webhook-secret \
GL_LEGACY_WEBHOOK_SECRET=mock-legacy-secret \
  npm run build && npm run start
```

Locally `reuseExistingServer` is on, so every `playwright test` from now on attaches to these instead
of rebuilding. **`NEXT_PUBLIC_*` variables are inlined at build time** — if you change one, you must
rebuild; changing it in the shell is not enough.

You do not have to do this. `npm --prefix e2e test` starts both servers itself. It is just slower.

### 3. The loop

```bash
cd e2e
npx playwright test specs/payment-intents.spec.ts        # one file
npx playwright test -g "declined"                        # one test by name
npx playwright test specs/clients.spec.ts --headed       # watch it drive the browser
npx playwright test specs/clients.spec.ts --debug        # step through with the inspector
npx playwright test --ui                                 # the watch-mode UI; best for iterating
npx playwright test --last-failed                        # re-run only what just failed
```

After a failure, the trace is the fastest way to understand it — it has a DOM snapshot, the network
log and the console for every step:

```bash
npx playwright show-trace test-results/<test-dir>/trace.zip
```

### 4. Inspect and drive the mock by hand

The control API is a normal HTTP API; `curl` works and is often quicker than a debugger.

```bash
curl -s 127.0.0.1:7002/healthz
curl -s 127.0.0.1:7002/__control/state | jq                   # every firm, client, session, payment
curl -s '127.0.0.1:7002/__control/events?since=0' | jq        # every GraphQL op the app sent
curl -s '127.0.0.1:7002/__control/events?since=0&op=CreateFirm' | jq
# `op` matches the GraphQL operationName the app sent, so an anonymous query records as null

# drive state a test would drive
curl -sX POST 127.0.0.1:7002/__control/connect/mint -H 'content-type: application/json' -d '{"name":"Demo"}'
curl -sX POST 127.0.0.1:7002/__control/firms/<firmId>/activate
curl -sX POST 127.0.0.1:7002/__control/firms/<firmId>/surcharging -H 'content-type: application/json' -d '{"enabled":true}'
```

`GET /__control/events` is also how the suite waits for a server-side Confido call. If you are ever
tempted to reach for a sleep, poll this instead.

You can drive the GraphQL mock directly too. There is no GraphiQL playground (it is disabled, along
with the landing page, so the mock only ever answers as the real API would), but `curl` works — and
the partner token is the one literal in the repo:

```bash
curl -s 127.0.0.1:7002/v2 -H 'content-type: application/json' \
  -H 'x-api-key: p_secret_mock_partner' \
  -d '{"query":"{ me { partner { id appId } } }"}'
```

### 5. Writing a test, red first

The point of the mock is that failure states are as easy to reach as success states, so write the red
test first and watch it fail for the reason you expect:

```ts
import { test, expect, CARDS, fillCardFields, waitForHostedFields, CARD_FIELD_KEYS,
         runPaymentAndCaptureResponse } from '../fixtures/test';

test('a declined card leaves the form untouched', async ({ page, connectedUser, mock }) => {
  await page.goto('/payment-intents');
  await waitForHostedFields(page, CARD_FIELD_KEYS);
  await page.getByLabel('Amount').fill('10.00');
  await fillCardFields(page, CARDS.declined);          // 4000300011112220

  const mark = await mock.events.mark();               // take the mark BEFORE the action
  await runPaymentAndCaptureResponse(page, () =>
    page.getByRole('button', { name: 'Run payment' }).click());

  const ev = await mock.events.waitFor({
    op: 'PaymentSessionComplete',
    firmId: connectedUser.firmId,                      // always scope to your own firm
    since: mark,
  });
  expect(ev.ok).toBe(false);
  await expect(page.getByRole('heading', { name: 'Success!' })).toHaveCount(0);
});
```

Fixtures do the setup: `user` (signed up), `connectedUser` (connected, ACTIVE firm), `pendingFirmUser`
(firm not accepting payments). `lockdown` and `shims` are automatic. Read `fixtures/test.ts` and
`fixtures/mock-client.ts` — they are commented and beat guessing.

### 6. Things that will bite you

| Symptom | Cause |
|---|---|
| Playwright starts rebuilding the app | Your `npm run start` died, or you set `CI=1` |
| A `NEXT_PUBLIC_*` change has no effect | Inlined at build time — rebuild |
| A test passes alone and fails in the suite | An unscoped `mock.events` assertion; scope it by `firmId` |
| `strict mode violation: resolved to 2 elements` | `Ready`/`Pending` need `{ exact: true }` |
| Bogus `ENOENT … trace.zip` failures | Two Playwright runs sharing `test-results/`; pass `--output=/tmp/<name>` |
| A spinner never clears | The shim never got its session — check `GET /__control/sessions/<token>` |

Never use `waitForTimeout`, and never call `POST /__control/reset` while anything else is running —
the store is shared by all workers. Tests isolate by creating a fresh user and firm, not by resetting.

## Adding a scenario

1. Add state and behaviour to the mock if you need it: a store record in `mock-server/store.ts`, a
   resolver in `mock-server/resolvers.ts`, a control route in `mock-server/control.ts`. Keep the
   resolvers honest to `schema.graphql` — when unsure of an enum, grep it. `PaymentStatus` is
   lowercase `success`; `FirmStatus` is `ACTIVE`; `TransactionStatus2` is `SUCCESSFUL`.
2. Write the spec against `fixtures/test.ts`. Use `connectedUser` for anything past the connect screen.
3. Prefer role and label locators. **The app has no `data-testid`s and must not gain any** — that
   would be a change outside `e2e/`.
4. Never use `waitForTimeout`. Wait on a locator, on `page.waitForResponse`, or with `expect.poll`
   over `/__control/events`.
5. If the test can only pass by changing the app, don't. Assert the current behaviour, annotate the
   test `{ type: 'quirk', description: '...' }`, and add an entry to [`QUIRKS.md`](./QUIRKS.md).
6. **Scope every `mock.events` assertion.** The mock store is shared by all workers, so
   `mock.events.list({ since })` without a `firmId` (or another value unique to your test) will pass
   or fail depending on what else is running. A negative assertion — "this operation did *not*
   happen" — is the dangerous case: unscoped, it fails randomly; scoped to the wrong id, it can never
   fail at all. Both bugs existed in this suite and were caught by the Phase 2 audit.
7. Ask what would make your new test fail. A test asserting only that an event fired, or that an
   element that was always present is visible, is not testing the change the action caused.

## Deploying this (and why there is no live URL yet)

There is deliberately **no Vercel deployment**. Legal Wave cannot run on Vercel without changes to the
app itself, and this branch's value is that it changes nothing. Both blockers are real and independent
— neither is a configuration detail:

**1. The database is a SQLite file, and Vercel's runtime filesystem is read-only.**

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:./legal-wave.sqlite"
}
```

`prisma db push` runs at build time and would produce a file inside the bundle, so the app *builds*.
But six routes write at runtime — `prisma.user.create` in `src/pages/api/signup.ts:12`, plus firm
updates in `disconnect.ts:22`, `get-sign-up-link.ts:27`, `gravity-callback.ts:24`, `session.ts:46`,
`create-onboarding-code.ts:26`. Signing up is the first thing a visitor does, and it fails
immediately. Fixing this means editing `prisma/schema.prisma` to a hosted datasource (Vercel Postgres,
Neon, Turso) and running a migration — a change outside `e2e/`.

**2. There is no Confido backend to point it at.**

`src/pages/index.tsx:12` calls `getMyPartner()` inside `getServerSideProps`, so the home page needs a
reachable API and a valid `CONFIDO_PARTNER_TOKEN` before it renders anything. Two ways to satisfy it:

* **Real sandbox credentials.** Then the deploy is a normal Legal Wave install, and this suite is not
  involved.
* **Host the mock.** `mock-server/` is a plain Node HTTP server and would run fine on any always-on
  box (Fly, Railway, Render); point `CONFIDO_API_ENDPOINT`, `NEXT_PUBLIC_CONFIDO_APP_DOMAIN` and the
  two SDK URLs at it. **It will not work as Vercel serverless functions**: `store.ts` keeps all state
  in module-level `Map`s, so every invocation would see a different, empty store. Making it
  serverless-safe means giving the store a real persistence layer first.

So a working public demo needs a hosted database *and* a hosted mock. Neither is hard; both are
outside the scope of "add a test suite without touching the app", which is why they are written down
here rather than done.

### If you decide to deploy anyway

```bash
npx vercel login
npx vercel link
npx vercel env add CONFIDO_API_ENDPOINT           # ...and the other five from `Run it` above
npx vercel --prod
npx vercel git connect                            # auto-deploy on push to main
```

`vercel git connect` is what wires GitHub → Vercel so `main` deploys automatically; it needs the
project linked and the repo connected to the same Vercel account. Expect the deployment to build and
then 500 on `/` and `/api/signup` until both blockers above are addressed.

Note that the e2e suite does **not** need any of this. It builds and runs the app locally against the
local mock, which is the entire point.

## The one file changed outside `e2e/`

`tsconfig.json` — one line:

```diff
-  "exclude": ["node_modules"]
+  "exclude": ["node_modules", "e2e"]
```

The root config's `"include": ["**/*.ts"]` otherwise makes `next build` type-check this directory
under the *app's* compiler options (`target: es5`), which couples the app's build to the test code.
Excluding `e2e` decouples them. Type-check the suite with `npx tsc --noEmit` from `e2e/`.

Everything else in this branch is a new file under `e2e/`. To verify that:

```bash
git status --porcelain | grep -vE '^\?\? (e2e/|\.github/)' | grep -v '^ M e2e/' \
  | grep -v '^ M tsconfig.json'   # prints nothing
```

## Layout

```
e2e/
  playwright.config.ts   two webServers, mock env applied to build and start
  PLAN.md                the full specification this suite was built from
  QUIRKS.md              app behaviours encoded rather than fixed
  mock-server/
    schema.graphql       real sandbox SDL
    server.ts            routing only
    graphql.ts           yoga + auth + event recording
    resolvers.ts         the 14 operations the app uses
    mocks.ts             scalar mocks for everything else
    store.ts             in-memory state
    events.ts            ring buffer of received operations
    control.ts           /__control/*, /app/*, /js/*
    fake-app/            HTML for the fake Confido pages
  shims/                 window.gravityLegal, window.confidoOnboarding
  fixtures/              test fixtures, control-API client, page helpers, test cards
  specs/                 the tests
```
