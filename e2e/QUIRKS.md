# Legal Wave quirks

Behaviours the Playwright suite had to **encode rather than fix**, because this work is strictly
additive: no file outside `e2e/` may change. Each one is asserted by a test annotated
`{ type: 'quirk', description: ... }`, so if a maintainer fixes it the suite fails loudly and the
assertion can be flipped. Every entry below was reproduced against a local `next build && next start`
of this repo; the commands are included so they can be re-run.

Status legend: **confirmed** = reproduced with the output shown. **observed in-browser** = seen in a
Playwright run rather than with curl.

---

## 1. `res.send(<number>)` sends HTTP 200 with the number as the body

Five API routes call `res.send(200)` / `res.send(400)` / `res.send(403)`. Express's `res.send(number)`
is a status setter, but Next's `NextApiResponse.send` treats a number as the **body**. So every one of
these returns **HTTP 200** and writes the status code into the response body as text.

| Route | Source | Condition | Actual |
|---|---|---|---|
| `POST /api/login` | `src/pages/api/login.ts:29` (`res.send(200)`), `:32` (`res.send(403)`) | wrong password | `HTTP 200`, body `403` |
| `POST /api/login` | same | correct password | `HTTP 200`, body `200` |
| `POST /api/accept-webhook` | `src/pages/api/accept-webhook.ts:19` / `:25` | bad `x-signature` | `HTTP 200`, body `400` |
| `POST /api/accept-webhook` | same | good `x-signature` | `HTTP 200`, body `200` |
| `POST /api/legacy-accept-webhook` | `src/pages/api/legacy-accept-webhook.ts:19` / `:25` | bad `x-prahari-signature` | `HTTP 200`, body `400` |
| `POST /api/disconnect` | `src/pages/api/disconnect.ts:16`, `:31` | no firm connected | `HTTP 200`, body `200` |

Reproduced:

```console
$ curl -s -w ' [status=%{http_code}]\n' -X POST localhost:7001/api/login \
    -H 'content-type: application/json' -d '{"username":"quirkuser1","password":"WRONG"}'
403 [status=200]

$ curl -s -w ' [status=%{http_code}]\n' -X POST localhost:7001/api/accept-webhook \
    -H 'content-type: application/json' -H 'x-signature: bogus' -d '{"event":"payment.succeeded","id":"evt_1"}'
400 [status=200]
```

**Why it matters.** A webhook sender sees `200 OK` for a signature it got *wrong*, so Confido would
never retry and the failure is silent. Any caller doing `if (!response.ok)` — which is what the login
page effectively wants — cannot distinguish success from rejection.

**Consequence for the login page.** `src/pages/login.tsx:35` ignores the response entirely and does
`window.location.href = '/'` regardless, so a wrong password still navigates to `/`, which then
bounces to `/signup` via `requireAuth`. There is no error message anywhere in the flow.

## 2. `GET /api/session` returns the user's plaintext password and the Confido firm secret

`src/pages/api/session.ts:57` sends the whole Prisma `user` and `firm` rows to the browser. The `User`
model stores the password in plaintext (`prisma/schema.prisma`, no hashing anywhere in the repo) and
`Firm.glApiToken` is the firm's Confido API secret.

```console
$ curl -s -b jar.txt localhost:7001/api/session
{"user":{...,"password":"pw","username":"quirkuser1"},"firm":{...,"glApiToken":null,"name":"Quirk Firm"}}
```

`POST /api/signup` (`src/pages/api/signup.ts:27`) echoes the created user, password included, for the
same reason.

Once a firm is connected, `firm.glApiToken` in that same payload is a live Confido firm token. The
Clients page depends on this: `src/pages/clients.tsx:28` reads `firm?.glApiToken` out of the session
and `src/components/clients/AddClient.tsx:58` sends it to Confido as `x-api-key` **straight from the
browser**, so the firm secret is in the page's JS heap and in devtools for anyone with the session
cookie. A firm secret is a server-side credential.

## 3. Routes that skip `requireAuth` render for logged-out visitors, then crash on the client

`/` , `/payment-intents` and `/paylinks` use `requireAuth` and correctly redirect:

```console
$ curl -s -o /dev/null -w '[%{http_code}] -> %{redirect_url}\n' localhost:7001/
[307] -> http://127.0.0.1:7001/signup
```

`/clients`, `/stored-payment-methods` and `/transactions` do not, and return `HTTP 200`:

```console
$ curl -s -o /dev/null -w '[%{http_code}]\n' localhost:7001/clients
[200]
```

The server-rendered HTML is fine, but `src/components/layout/Sidebar.tsx:67` and `:69` then dereferences
`session.firm!.name` and `session.user!.username`. For a logged-out visitor `/api/session` returns
`{}`, so both are `undefined` and the render throws. *(In-browser behaviour verified in Phase 2; see
the `auth.spec` annotation for exactly what the user sees.)*

## 4. `getSessionFromRequestOrThrow` surfaces as a bare 500

`src/lib/session.ts:67` throws `new Error('user not found')` and no route catches it, so the two
onboarding routes return Next's generic error page rather than a 401 and rather than the thrown
message:

```console
$ curl -s -w ' [status=%{http_code}]\n' -X POST localhost:7001/api/get-sign-up-link
Internal Server Error [status=500]

$ curl -s -o /dev/null -w '[status=%{http_code}]\n' -X POST localhost:7001/api/onboarding/create-onboarding-code
[status=500]
```

(PLAN.md §6 predicted the body would contain `user not found`; it does not — the message is swallowed
and only the status is observable. Corrected here.)

## 5. `createSavePaymentMethodToken` passes an options object where variables belong

`src/confido-legal-requests/createSavePaymentMethodToken.ts:34-45` builds

```js
const options = { variables: { input: { clientId: params.clientId } } };
const res = await client.request(CREATE_SAVE_PAYMENT_METHOD_TOKEN, options);
```

but `graphql-request`'s second positional argument **is** the variables object, not an options
wrapper. The request that actually goes on the wire is therefore

```json
{"query":"...","variables":{"variables":{"input":{}}}}
```

`$input` is never supplied, so `CreateSavePaymentMethodTokenInput.clientId` never reaches Confido: a
stored payment method can never be attached to a client through this app. It is invisible today only
because the one caller — `src/pages/api/stored-payment-methods/create-token.ts:13` — passes no
`clientId`, and the input type is nullable so the server accepts the call.

*Consequence for this suite:* the recorded event for `CreateSavePaymentMethodToken` carries
`variables = {variables: {input: {}}}`, not `{input: {}}`. `stored-payment-methods.spec` asserts the
malformed shape on purpose — that assertion failing means someone fixed the bug.

## 6. The Paylinks form dereferences `paymentLink` without a guard

`src/components/paylinks/PaylinkPaymentForm.tsx:76`:

```js
amount: hostedFieldsState?.paymentLink.totalAmount,
```

The optional chain stops at `hostedFieldsState`, so `paymentLink` is dereferenced unguarded. The SDK
type permits state with no `paymentLink` (`src/confido-legal-hook/ConfidoLegal.d.ts:110`,
`paymentLink?: any`) — which is what any non-paylink session or a load error produces. `Run payment`
then throws a `TypeError`, which the `catch` swallows into `setError(e)`, and the page renders the raw
error object in an alert rather than a message.

This compounds with the Paylinks page being broken for every account but the author's (quirk 7).

## 7. The Paylinks page 500s for everyone: the payment link id is hardcoded

`src/pages/paylinks.tsx:29` hardcodes `paymentLinkId = 'a1e7a82e-b59e-4645-b559-22e12bfb265c'` and
passes it to `createPaymentToken` in `getServerSideProps`. That link belongs to whoever wrote the
page. For any other firm the real API answers `Paylink not found`, the error is unhandled in
`getServerSideProps`, and the route 500s before rendering.

The mock reproduces this by default. `POST /__control/paylinks/seed` lets one spec seed that exact id
so the form itself can still be exercised.

## 8. The SDK type declarations reference types that do not exist

`src/confido-legal-hook/ConfidoLegal.d.ts` uses three types that are declared **nowhere** in the repo:
`ChangeType` (line 38), `ConfidoStyleOptions` (lines 26 and 34) and `OnboardingChangeEvent` (line 33).

```console
$ grep -rn "type ChangeType\|interface ChangeType" src/ | wc -l
0
```

It only compiles because `tsconfig.json` sets `skipLibCheck: true`, which skips `.d.ts` files
entirely. Relatedly, `PaymentMethod` (line 46) and `FieldState` (line 54) are declared **without
`export`**, yet `src/components/HostedFieldInput.tsx:6` and
`src/pages/api/stored-payment-methods/complete.ts:1` both import them — masked the same way.

The practical consequence for this suite: `ChangeEvent.type` is unconstrained, so nothing validates
the event-type strings the hosted-fields shim emits.

## 9. Non-null assertions on surcharging fields the interface says may be null

`src/components/payment-intents/PaymentForm.tsx:220` and `:275` read `surcharging.rate!` and
`surcharging.amount!.fee`, gated only on `surcharging.willBeApplied`. But
`ConfidoLegal.d.ts:113-120` declares `amount: { fee: number } | null` and `rate?: number`, so an SDK
response with `willBeApplied: true` and `amount: null` is type-conformant and crashes the render. The
shim always populates both, so the suite does not hit it.

## 10. The Connect flow never round-trips a `state` parameter

`src/pages/index.tsx:13` builds the connect URL as
`${NEXT_PUBLIC_CONFIDO_APP_DOMAIN}/connect/${partner.appId}` — with **no `state` query parameter**,
despite `src/pages/api/gravity-callback.ts:15` reading `query.state` back out and logging it
(`console.log('query.state=', state)`, which also puts the value in the server log on every connect).

`state` is the CSRF defence for an OAuth-style redirect. Nothing generates it, nothing stores it and
nothing verifies it on return, so the callback accepts any `code` presented to a logged-in session.

## 11. `/api/gravity-callback` has no error handling, so a reused code 500s

`src/pages/api/gravity-callback.ts:20` calls `exchangeCodeForFirmToken(code)` with no `try`/`catch`
before `res.redirect(303, '/')`. Connect codes are one-time, so replaying a callback URL — a browser
back button is enough — throws unhandled and the user gets a raw 500 instead of being sent home or
told to reconnect.

## 12. A dead GraphQL document that does not parse

`src/components/transactions/useTransactions.ts:3-9`:

```graphql
query GET_TRANSACTIONS() {
  transactions {

  }
}
```

An empty argument list and an empty selection set are both syntax errors, and `transactions` is not a
field on `Query` in the real SDL either. It survives because `useTransactions` has no callers:

```console
$ grep -rn "useTransactions" src/ | grep -v "useTransactions.ts:"
(no output)
```

`gql` only parses when evaluated, so the module is never executed — but any codegen or lint pass over
the repo's GraphQL documents would fail on it. Related: `@apollo/client` is a dependency solely for
this dead file; the app talks to Confido through `graphql-request` everywhere else.

## 13. Typo makes a response field unreachable

`src/confido-legal-requests/createOnboardingToken.ts:16` declares `expriresAt` on
`CreateOnboardingTokenData` while the document one line above selects `expiresAt`. Anything reading
the declared field gets `undefined`. Harmless today — only `.token` is read
(`src/pages/api/onboarding/create-onboarding-code.ts:16`).

---

---

*Entries below this line are added as Phase 2 and Phase 3 confirm them in the browser.*
