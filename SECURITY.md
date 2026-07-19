# Security Policy

## Reporting a vulnerability

Open a GitHub issue titled `SECURITY:` with a description and reproduction
steps. Please do not include working exploit payloads in a public issue. Reports
are acknowledged within 72 hours.

---

## Threat model

Matchday Ops Copilot is a public-facing Cloudflare Worker that accepts untrusted
free text and passes it to a large language model. That produces four threat
classes, addressed below.

| # | Threat | Impact if unmitigated |
|---|---|---|
| 1 | Prompt injection via the incident report | Model ignores its instructions; misclassification of a live safety incident |
| 2 | Output-side injection (XSS) via model or user text | Script execution in an operator's control-room browser |
| 3 | Resource exhaustion / cost abuse | Free-tier inference budget drained; board unavailable to every venue |
| 4 | Credential exposure | Account compromise |

---

## 1. Prompt injection

**Controls (defence in depth — no single layer is trusted):**

1. **Pattern neutralisation** — `src/validate.ts` replaces known injection
   phrasing (`ignore previous instructions`, `you are now a…`, `</system>`,
   `[INST]`, code fences) with `[redacted]`.
2. **Neutralise, never reject.** A false rejection during a crowd surge is more
   dangerous than a scrubbed word, so a steward is never blocked from filing.
3. **Message separation** — the report is a distinct `user` message, never
   interpolated into the system prompt.
4. **Explicit delimiting** — wrapped in `<<<REPORT … REPORT>>>`.
5. **Instructed refusal** — the system prompt states the report is untrusted
   data and its instructions must never be followed.
6. **Output constraint** — `response_format: json_schema` bounds what the model
   can emit at all.
7. **Allow-list validation of output** — a category outside the permitted twelve
   is rejected outright and the deterministic fallback answers instead.
8. **Blast radius is bounded by architecture.** Even a fully successful
   injection cannot change priority, SLA, dispatched units or escalation —
   those are computed by pure functions in `src/routing.ts` that never read
   model output beyond the validated category and clamped severity. This is the
   most important control in this document.

**Residual risk:** a novel injection phrasing could still influence the category
or severity, degrading classification quality. It cannot influence dispatch
policy or execute code.

---

## 2. Output-side injection (XSS)

- **No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval` or `new Function`
  anywhere in the codebase.** Every value that originates from the model reaches
  the DOM via `textContent` / `document.createTextNode`.
- **Strict CSP** with `default-src 'none'`, `script-src 'self'`, `style-src
  'self'`, **no `unsafe-inline`, no `unsafe-eval`**, no CDN origins. Capabilities
  are granted back explicitly so a future asset type fails closed.
- **`X-Content-Type-Options: nosniff`** stops a JSON error being sniffed as script.
- **`frame-ancestors 'none'` + `X-Frame-Options: DENY`** prevent the operations
  board being clickjacked into a hostile page.
- **Control-character stripping** removes zero-width and bidirectional
  characters commonly used to hide payloads, while preserving accented Spanish
  and French text.
- **Lint-enforced** — `no-eval`, `no-implied-eval`, `no-new-func` and
  `no-script-url` are configured as **errors**, so the sinks cannot be
  reintroduced without failing `npm run check`.

---

## 3. Resource exhaustion and cost abuse

| Control | Value | Location |
|---|---|---|
| Rate limit | 20 requests / minute / IP | `src/index.ts`, `src/http.ts` |
| Request body cap | 8 KB, checked on `content-length` **and** actual length | `src/validate.ts` |
| Report length cap | 1200 characters, checked **before** sanitisation | `src/validate.ts` |
| Model timeout | 12 s, then deterministic fallback | `src/triage.ts` |
| Model output cap | 400 tokens | `src/triage.ts` |
| Action list cap | 4 items | `src/triage.ts` |
| Rate-limiter memory | 10,000 keys max, with expired-window eviction | `src/http.ts` |

The rate-limit key is `CF-Connecting-IP`, which Cloudflare's edge sets and a
client cannot spoof. `X-Forwarded-For` is deliberately never read, because it is
client-controlled.

**Known limitation:** the limiter is per-isolate in-memory, so the global count
is approximate. This is a conscious trade — it costs zero storage round-trips on
the hot path, and Cloudflare pins a client to a colo, so it is effective in
practice. A production deployment would move the counter to a Durable Object;
the `RateLimiter` interface is shaped so that is a drop-in replacement.

---

## 4. Credentials and data

- **There are no credentials in this repository.** Workers AI is accessed
  through a platform **binding** (`env.AI`), not an API key. There is no `.env`,
  no token, and nothing to rotate or leak.
- `.gitignore` excludes `.dev.vars`, `.env`, `node_modules/` and `.wrangler/`.
- **No data retention.** Incident reports are never written to any store. They
  exist for the lifetime of the request, plus the browser tab's in-memory board.
  Nothing survives a page refresh.
- **No third-party analytics, fonts, scripts or CDN requests.** The CSP would
  block them regardless.
- **No cookies, no sessions, no PII collection.** Reports may incidentally
  contain personal information (e.g. a description of a lost child); because
  nothing is persisted, that data never lands at rest.

---

## Response headers

Applied by a single wrapper (`withSecurityHeaders`) to **every** response
including static assets, so no route can omit one. Asserted by tests in
`test/worker.test.ts`.

```
content-security-policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'none';
  base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
permissions-policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
```

---

## Error handling

Error responses contain only literals defined in this codebase. Stack traces,
internal messages and upstream error details are never returned to a client;
a test asserts no response body matches a stack-trace pattern. User input is
never echoed back inside an error message.

---

## Dependency hygiene

- **Zero runtime dependencies.** `dependencies` in `package.json` is empty; the
  runtime supply-chain attack surface is nil.
- Development dependencies are limited to TypeScript, ESLint, Vitest and
  Wrangler — none of which ship any code to production.
- No build step, no bundled third-party code, no transitive runtime tree.

---

## Verification

```bash
npm run check   # typecheck (strict) + lint (0 warnings allowed) + 158 tests
```

Security-relevant behaviour is covered by tests, not just by policy: injection
neutralisation, control-character stripping, body-size rejection, malformed
JSON, unknown venues, header presence, absence of `unsafe-inline`, error-body
leakage, rate-limit 429s, and limiter memory bounding.
