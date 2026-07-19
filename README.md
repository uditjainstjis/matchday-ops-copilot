# Matchday Ops Copilot

**Live demo: https://matchday-ops-copilot.seriouss.workers.dev**

---

## The problem

**Theme: Smart Stadiums & Tournament Operations — FIFA World Cup 2026.**

The 2026 tournament is the largest ever staged: **48 teams, 104 matches, 16 host
cities across the USA, Canada and Mexico**, with venues up to 87,000 capacity.
Every one of those matches runs a Venue Operations Centre (VOC), and every VOC
faces the same bottleneck.

Reports arrive as *unstructured human speech*: radio traffic and app messages
from stewards, medics, safety officers and police. "Crowd surge at gate 4,
people pressed against the barrier." "Medical at block C row 12." "Aglomeración
en la puerta 2." They arrive faster than a control-room operator can read them,
in three languages, from staff who are describing a live situation rather than
filling in a form.

The consequential decisions — **how urgent is this, who must be dispatched, how
fast, and does venue command need to be woken up** — depend on parsing that text
correctly and instantly. Getting it wrong at ingress or egress, when crowd
density peaks, is how ordinary incidents become disasters.

**Matchday Ops Copilot closes that gap.** Free text goes in; a prioritised,
routed, actionable incident comes out in ~2 seconds.

---

## How each feature maps to the problem

| Feature | Operational problem it solves |
|---|---|
| **Free-text → structured incident** (generative AI) | Stewards describe situations in natural speech under stress. No form can capture that. The model reads it as written, including misspellings and Spanish/French. |
| **1–5 severity + 12-category taxonomy** | Gives the control room a common vocabulary across 16 venues and three countries, so a report means the same thing in Guadalajara as in Toronto. |
| **Match-phase-aware priority** | An identical crowd report is far more dangerous during pre-match ingress or full-time egress than in open play. Priority is computed from the phase, not just the words. |
| **Deterministic routing to response units** | Removes the "who do I call?" step. Each category maps to a primary unit plus the units that must be co-notified. |
| **Target response time (SLA) per band** | P1 = 2 min, P2 = 5, P3 = 15, P4 = 60. Turns a classification into an accountable clock. |
| **Escalation flag to venue command** | Every P1, plus P2 crowd-safety and fire, are flagged for immediate command attention — the two categories that escalate non-linearly. |
| **Location extraction (gate / block / row / level)** | Dispatching to a guessed location wastes the entire SLA window. Stated locations are extracted; unstated ones are reported as unstated, never invented. |
| **All 16 host venues, grounded** | The model is given the actual stadium, city, country and capacity, so guidance is venue-appropriate rather than generic. |
| **Loud degraded mode** | If the model is unavailable, an offline classifier answers and the UI says so. A control room must never be silently guessing. |
| **Session incident board** | The triaged stream, sorted highest-priority-first — the actual artefact an operator works from. |

---

## The key design decision

> **The AI classifies. It never decides.**

The language model does exactly one job — turn messy text into a category, a
severity, a summary and suggested actions, constrained to a JSON schema.

Every consequential decision (priority band, SLA, which units are dispatched,
whether to escalate) is then computed by **pure, audited, unit-tested functions**
in [`src/routing.ts`](src/routing.ts). The model cannot override them: there is a
test that feeds the model a response claiming a severity-5 fire is a "P4 with a
999-minute SLA routed to Catering" and asserts the system still returns
**P1 / 2 min / Fire and Rescue**.

This keeps the safety-critical path free of model variance while keeping the AI
genuinely load-bearing for the part no rule engine does well. Identical inputs
always produce identical dispatch.

---

## Generative AI — what it is and proof it runs

- **Provider:** Cloudflare Workers AI (`ai` binding, no API key stored anywhere).
- **Model:** `@cf/meta/llama-4-scout-17b-16e-instruct`
- **Structured output:** `response_format: { type: 'json_schema', … }` — this is
  what makes extraction reliable enough to build policy on. The model catalogue
  was verified live against this account (`wrangler ai models`) rather than
  assumed; the previously-common Llama 3.1/3.3 ids are **deprecated as of
  2026-05-30** and return `AiError 5028`.
- **Grounding:** venue name, city, country, capacity and match phase are injected
  into every prompt.
- **Latency:** ~1.3–2.4 s measured end-to-end against the deployed URL.

```console
$ curl -s https://matchday-ops-copilot.seriouss.workers.dev/api/health
{"status":"ok","model":"@cf/meta/llama-4-scout-17b-16e-instruct","venues":16,
 "tournament":"FIFA World Cup 2026"}

$ curl -s -X POST https://matchday-ops-copilot.seriouss.workers.dev/api/triage \
    -H 'content-type: application/json' \
    -d '{"report":"crowd surge at gate 4, people pressed against the barrier",
         "venueId":"nyn","matchPhase":"pre_match_ingress"}'
{"incident":{"id":"INC-EDEEC05A","category":"crowd_safety","severity":5,
 "priority":"P1","slaMinutes":2,"primaryUnit":"Stewarding",
 "supportingUnits":["Police and Security","Medical","Venue Operations Centre"],
 "location":{"zone":"Gate 4","gate":"4","block":null,"row":null},
 "summary":"Crowd surge at gate 4, people pressed against barrier.",
 "recommendedActions":["Deploy additional stewards to gate 4",
   "Activate crowd management protocols","Notify security to assist"],
 "escalateToVenueCommand":true,"confidence":0.85,
 "engine":"workers-ai","degradedReason":null,"latencyMs":2367}}
```

### Graceful degradation, stated out loud

If Workers AI errors, exceeds the 12-second ceiling, or returns anything
off-schema (unparseable JSON, or a category outside the permitted twelve), the
deterministic keyword classifier in [`src/fallback.ts`](src/fallback.ts) answers
instead. The response carries `engine: "deterministic-fallback"` and a
human-readable `degradedReason`, and the UI renders a high-contrast **"Degraded —
offline classifier"** banner. There is no path that produces a blank screen.

---

## Testing

**158 tests across 5 files, all green, one command.**

```bash
npm install
npm test          # 158 passed
npm run check     # typecheck + lint + tests
```

| File | Tests | Covers |
|---|---:|---|
| `test/routing.test.ts` | 26 | Priority banding, severity clamping, SLA, unit routing, escalation. Includes an exhaustive sweep of **every category × phase × severity** combination and a **monotonicity invariant** (higher severity never yields lower priority). |
| `test/validate.test.ts` | 38 | Sanitisation, prompt-injection neutralisation, body-size caps, malformed JSON, unknown venues, boundary lengths, venue-catalogue integrity. |
| `test/fallback.test.ts` | 32 | Offline classification per category, conflicting signals, intensifiers/de-escalators, multilingual input, location extraction, truncation. |
| `test/triage.test.ts` | 35 | Model-envelope parsing, prompt construction, and **every failure path**: rejection, timeout, unparseable output, invented categories, out-of-range severity, empty actions, bare-string rejections. |
| `test/worker.test.ts` | 27 | Full HTTP integration through the real `fetch` handler with a stubbed AI binding: routing, status codes, security headers, cache directives, rate limiting to a real 429. |

The suite is weighted deliberately toward **failure paths and edge cases**, not
happy paths. Representative examples:

- The model returns `{"category":"alien_invasion"}` → system degrades, says why.
- The model rejects with a bare string rather than an `Error` → no throw.
- `clampSeverity(null)` must be `3`, not `1` — because `Number(null) === 0` would
  silently under-report a serious incident. (This was a real bug the suite caught.)
- A zero-width/bidi-character payload hidden in a report is stripped.
- 25 rapid requests from one IP → HTTP 429 with `Retry-After`.

---

## Security

Full detail in [SECURITY.md](SECURITY.md). Summary of controls, each present in
source with a comment explaining *why*:

| Control | Where | Why |
|---|---|---|
| No secrets in repo | `wrangler.jsonc` | Workers AI is a platform **binding**. There is no key, token or `.env` to leak. |
| Strict CSP, no `unsafe-inline`/`unsafe-eval` | `src/http.ts` | `default-src 'none'` then explicit grants — a new asset type fails closed. This is what actually stops reflected XSS executing. |
| Full hardening header set | `src/http.ts` | HSTS, `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy` denying camera/mic/geo. Applied by a single wrapper so no route can miss one. |
| Input validation at one boundary | `src/validate.ts` | Every request body is typed exactly once; nothing downstream re-parses raw input. Rejects rather than coerces an unknown venue — misrouting an incident is a safety failure. |
| Body-size cap (8 KB) | `src/index.ts`, `src/validate.ts` | An unbounded `request.json()` lets a client pin CPU/memory in the isolate. Checked on `content-length` *and* on actual length. |
| Prompt-injection defence in depth | `src/validate.ts`, `src/triage.ts` | Injection phrasing is **neutralised, not rejected** (a steward must never be blocked mid-crowd-surge); the report is passed as delimited data in a separate message; the system prompt states it must never be followed. |
| Control-character stripping | `src/validate.ts` | Zero-width and bidi characters used to hide payloads are removed — while preserving accented Spanish/French, which matters in a three-country tournament. |
| No `innerHTML` / `eval` anywhere | `public/app.js` | All model-derived text reaches the DOM via `textContent` / `createTextNode`. Model output can never execute as markup. |
| Injection sinks banned at lint time | `eslint.config.js` | `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url` are **errors**. A contributor cannot reintroduce one without failing the build. |
| Rate limiting, 20/min/IP | `src/http.ts` | Inference is the expensive resource; one client could otherwise exhaust the account and take the board down for every venue. Keyed on `CF-Connecting-IP` (edge-set, unspoofable) — never `X-Forwarded-For`. |
| Bounded limiter memory | `src/http.ts` | Expired-window eviction plus a hard key cap, so a spoofed-IP flood cannot grow the map without limit. |
| No data retention | whole app | Incidents are never persisted server-side. The board lives in the browser tab only. |
| Errors never leak internals | `src/http.ts` | Only our own literals are returned; stack traces are never echoed. Asserted by a test. |
| Zero runtime dependencies | `package.json` | Nothing in `dependencies`. The runtime supply-chain attack surface is empty. |

---

## Accessibility (WCAG 2.2 AA)

Built to be usable by a control-room operator on a keyboard, at 200% zoom, in a
dark room, with a screen reader.

- **Semantic HTML** — real `header`/`main`/`section`/`footer`, one `h1`, ordered
  heading levels, a real `<table>` with `<caption>`, `scope`-ed `<th>`, a
  `<fieldset>`/`<legend>` for the sample group. No `div` soup, no ARIA used where
  a native element exists.
- **Keyboard** — every control reachable and operable; a **skip link** is the
  first tabbable element; the scrollable board region is focusable so keyboard
  users can scroll it (SC 2.1.1).
- **Visible focus** — 3px high-contrast outline with offset on every interactive
  element (SC 2.4.11, 2.4.13).
- **Screen reader** — results announced through a `role="status"`/`aria-live="polite"`
  region as a full sentence ("Incident INC-… triaged as P1, crowd safety, severity
  5 of 5, routed to Stewarding, target response 2 minutes"). Validation errors use
  `role="alert"` (assertive) because they must interrupt. Every input has a real
  `<label>`; hints and errors are wired with `aria-describedby`; invalid state via
  `aria-invalid`.
- **Never colour alone** (SC 1.4.1) — every priority badge carries its band *and*
  a plain word: "P1 — immediate", "P3 — routine". A monochrome screenshot loses
  no information.
- **Contrast** — all pairs exceed 4.5:1 (ratios documented inline in
  `styles.css`); light and dark themes both explicitly designed, not inherited.
- **Reduced motion** (SC 2.3.3) and **forced-colors** (Windows High Contrast) media
  queries both handled.
- **Target size** (SC 2.5.8) — all interactive targets ≥ 44px tall, above the
  24px minimum.
- **Reflow** (SC 1.4.10) — single column at 320px with no horizontal page scroll;
  the wide incident table scrolls inside its own container, not the page.
- **Submit button uses `aria-disabled`, not `disabled`**, during the request — a
  `disabled` control loses focus and is skipped by screen readers, stranding the
  user mid-task.

---

## Efficiency

- **CSS and JS never invoke the Worker.** They are served straight from
  Cloudflare's edge cache via the assets binding — fewer invocations, lower
  latency, smaller dynamic attack surface. The HTML document is deliberately the
  one exception (`run_worker_first`), because Content-Security-Policy is a
  document-level header and must be attached by the Worker: full security
  benefit for one invocation per page load rather than one per asset.
- **`/api/venues` is aggressively cached** (`max-age=3600, s-maxage=86400`) and
  returns venues *plus* both controlled vocabularies in **one round trip**
  instead of three. It is effectively free after first load.
- **`/api/triage` is `no-store`** — a stale P1 on an operator's screen is a
  safety hazard, so this one is deliberately never cached.
- **O(1) venue lookup** via a `Map` built once at module scope, not rebuilt per
  request (the isolate is reused). No I/O on the request path at all.
- **Frozen module constants** for routing tables — supporting-unit arrays are
  shared references, so triage allocates nothing for them.
- **12-second model timeout.** A hung call would otherwise hold the request open
  until the platform kills it; the deterministic answer is faster and safer.
- **Bounded work everywhere** — 1200-char report cap, 8 KB body cap, 400
  max_tokens, action list capped at 4, rate-limiter map capped at 10,000 keys.
  Every loop in the codebase is bounded by a constant.
- **Complexity noted where non-obvious** — the fallback classifier is O(categories
  × terms), both fixed constants, therefore O(n) in report length and sub-millisecond.
- **Zero runtime dependencies**, no build step, no framework. The whole repo is
  well under 1 MB.

**Measured against the deployed URL:**

| Endpoint | Latency |
|---|---|
| `GET /api/health` | ~30 ms |
| `GET /api/venues` (cached) | ~25 ms |
| `POST /api/triage` (Workers AI) | ~1.3–2.4 s |
| `POST /api/triage` (degraded path) | < 20 ms |

---

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness; echoes the active model and venue count. |
| `GET` | `/api/venues` | 16 host venues, tournament shape, match phases, categories. |
| `POST` | `/api/triage` | Triage one free-text report. |

`POST /api/triage` request:

```json
{ "report": "medical at block C row 12, adult male unconscious",
  "venueId": "mex",
  "matchPhase": "second_half" }
```

Venue ids: `atl bos dal gdl hou kan lax mex mia mty nyn phl sfo sea tor van`.
Match phases: `pre_match_ingress first_half half_time second_half full_time_egress non_match_day`.

Errors return `{"error":{"message":"…","status":400}}`. Rate limit: 20 req/min/IP → `429` + `Retry-After`.

---

## Project structure

```
src/
  index.ts     Worker entrypoint, routing, rate-limit gate
  domain.ts    Frozen vocabularies + types — single source of truth
  venues.ts    16 host venues, O(1) index
  validate.ts  Input validation, sanitisation, injection scrubbing
  triage.ts    Workers AI call, schema-constrained, fallback orchestration
  routing.ts   Pure priority / SLA / dispatch policy  ← model cannot touch this
  fallback.ts  Offline classifier + location extraction
  http.ts      Security headers, JSON helpers, rate limiter
public/
  index.html   Semantic, accessible operations board
  styles.css   WCAG-AA palette, light + dark, reduced-motion, forced-colors
  app.js       No innerHTML, no eval — DOM APIs only
test/          158 tests
```

---

## Run locally

```bash
npm install
npm run dev      # wrangler dev  → http://localhost:8787
npm test         # 158 tests
npm run check    # typecheck + lint + tests
npm run deploy   # wrangler deploy
```

Requires Node 20+ and a Cloudflare account with Workers AI (free tier is enough).

---

## Licence

MIT — see [LICENSE](LICENSE).

Built for **PromptWars: Virtual (Hack2skill × Google for Developers), Challenge 4
— Smart Stadiums & Tournament Operations.**
