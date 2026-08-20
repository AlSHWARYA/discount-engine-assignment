# Opptra Discount Engine

A customer-facing cart pricing engine. Upload discount rules and a cart, and it
shows the final price of each item, the offer applied in plain language, and a
cart-level offer if the total qualifies. Rules can also be added in **plain
English** (parsed by an LLM) or a cart can be loaded from a **PDF**.

**Live demo:** https://discount-engine-assignment-two.vercel.app/

**Loom walkthrough:** _<paste your Loom link here>_

## Run locally (3 steps)

```bash
npm install
cp .env.example .env      # then paste your free Groq key (console.groq.com) into it
npm run dev               # http://localhost:5173
```

Upload `sample-data/rules.csv` and `sample-data/cart.csv`, click **Calculate
Discounts**, and you should see the expected results below. (Task 2's plain-English
input needs the Groq key; everything else works without it.)

Run the test suite with:

```bash
npm test        # node:test — engine, adapters, validation + property tests
```

## Expected results (sample data)

| Item | Base | Rule(s) applied | Final |
|------|------|-----------------|-------|
| ITEM-01 | Rs.1,299 | RULE-01 wins (Rs.195 > Rs.150) | **Rs.1,104** |
| ITEM-02 | Rs.849 | RULE-02 (−Rs.150) + RULE-03 stacked (−10%) | **Rs.629** |
| ITEM-03 | Rs.599 | RULE-01 (15% off) | **Rs.509** |
| ITEM-04 | Rs.2,499 | No offers available | **Rs.2,499** |
| ITEM-05 | Rs.449 | RULE-01 (15% off) | **Rs.382** |
| ITEM-06 | Rs.899 | RULE-03 (10% off, stackable) | **Rs.809** |
| | | Cart total before offer | Rs.5,932 |
| | | Cart offer — RULE-04 (10% off ≥ Rs.4,000) | −Rs.593 |
| | | **Final cart total** | **Rs.5,339** |

## Architecture — inputs adapt to the engine

The core principle the brief asks for: **the discount calculator never learns
which input produced its data.** Every input mode converts *some* source into the
same two arrays, and the engine runs on those.

```
INPUT ADAPTERS                          ENGINE (pure, untouched by input mode)
  csvParser.js        ┐
  nlRuleAdapter.js    ├─►  { rules[], cartItems[] } ─►  processCart → summarizeCart
  pdfCartAdapter.js   ┘                                    │
                                                           └─► results + cart offer
```

- `src/engine/ruleValidation.js` — **the single trust boundary.** Every rule, from
  any source, is validated + normalised here before it reaches the engine.
- `src/engine/discountEngine.js` — pure item + cart pricing. No UI, no I/O.
- `src/engine/csvParser.js`, `src/adapters/nlRuleAdapter.js`,
  `src/adapters/pdfCartAdapter.js` — the three input adapters.
- `api/parse-rule.js` — the only server code (see below).

Adding a fourth input mode = one new adapter + one new control in `App.jsx`. The
engine and results rendering don't change.

## The three tasks

- **Cart-level offer** — after all item discounts, if the (unrounded) subtotal
  meets a cart rule's threshold, the best cart rule applies to the whole total and
  shows as a separate line. Hidden if the threshold isn't met.
- **Natural-language rule** — a text field → LLM → structured rule → **confirmation
  step** → the engine re-runs with it added. Ambiguous input is surfaced, not guessed.
- **PDF cart** — upload a cart PDF → items extracted client-side → the cart is
  **replaced** and the engine re-runs. Bad rows are surfaced, not silently dropped.

## Why there's a (tiny) backend

The brief says add a server *only if PDF parsing requires it*. PDF parsing does
**not** — it runs entirely client-side with pdf.js. But the LLM does: shipping a
Groq API key in a static bundle would expose it to anyone. So the one server file,
`api/parse-rule.js` (a Vercel serverless function), exists solely to keep the key
server-side. This is a deliberate deviation from the letter of the brief for a
security reason; the alternative (a "paste your own key" box) would mean the
reviewer needs their own key to try the live demo. Local dev mirrors this function
with a Vite middleware so both environments behave identically.

## Design decisions & edge cases

Deliberate calls, each enforced in code:

### Item pricing
| Situation | Decision |
|-----------|----------|
| Two non-stackable rules tie on rupee saving | First in load order wins (deterministic secondary sort) |
| Flat discount exceeds the price (e.g. Rs.2,000 off Rs.449) | Final price clamped to Rs.0; saving capped at base |
| Percentage > 100 (e.g. "150% off") | Rejected at validation; engine also clamps as a backstop |
| Zero/negative base price | Row flagged and skipped, never priced |
| Multiple stackable rules of mixed type | Percentages applied first, then flats (order matters once both stack) — deterministic |
| Stackable rule matches but no non-stackable rule does | The stackable rule still applies on its own |
| Brand/platform text like "Amazon india" vs "Amazon India" | Matching is trim + lowercase + whitespace-collapsed |
| Garbage numbers (`100abc`, `Infinity`) / duplicate IDs in CSV | Rejected per-row with a clear message |

### Cart pricing
| Situation | Decision |
|-----------|----------|
| Cart total exactly equals threshold | Inclusive `≥` — the offer applies |
| Threshold checked against which number? | The **unrounded** subtotal (see Rounding) |
| Two cart rules both qualify | Only the single best-saving one applies; cart rules don't stack |
| `stackable` on a cart rule | Ignored (undefined at cart scope) |
| Empty cart / all rows invalid | Renders Rs.0 gracefully, no crash |

### Natural-language input
| Situation | Decision |
|-----------|----------|
| Ambiguous ("discount for big orders") | Surfaced as unresolvable with a reason; nothing is guessed |
| LLM returns non-JSON / fences / bad fields | Stripped, parsed, then **strictly type-decoded** (`validateRuleStrict`) — wrong types like `value: true` are rejected, not coerced — before the confirm step |
| LLM/network is slow or hangs | 10s abort timeout + `max_tokens` cap + input length limit on the server |
| User edits the text after parsing | The stale confirmation card is invalidated immediately |
| Input describes two rules | The first is parsed **and a visible notice** says others were present — never silently dropped |
| Rule targets a brand not in the cart | Accepted (valid but inactive) with a transparent note on the confirm card |
| Negative / out-of-range value | Rejected at validation |
| LLM/network failure | Clear inline error; the app never crashes |
| Rapid re-parses | A request token ignores stale/out-of-order responses |
| Custom rule IDs | Auto-generated `RULE-CUSTOM-n`, in-memory for the session |

### PDF input
| Situation | Decision |
|-----------|----------|
| Multi-word fields ("Natura Casa") | Columns rebuilt by token **X-coordinate**, not whitespace splitting |
| PDF has no item IDs | `ITEM-0x` synthesized on import |
| Header / divider / order lines | Skipped as structural, not treated as data |
| Currency noise (`Rs.` / `₹` / commas / decimals) | Normalised to a number |
| Some rows parse, some don't | Good rows load; bad rows shown with row number + reason |
| **All rows fail / empty PDF** | The existing cart is **preserved** (import is atomic — a failed parse never wipes the cart) |
| Negative price (`Rs.-500`) | Skipped as non-positive, never read as `₹500` |
| Repeated header on a later page | Skipped as structural, not flagged as a bad row |
| `getPage`/`getTextContent` throws mid-read | Caught; clean error; uploader never hangs on "Reading PDF…" |
| Oversized / many-page PDF | Rejected up front (5 MB / 20-page guards) |
| A newer upload finishes before an older one | Request token ignores the stale result |
| Scanned/image PDF (no text layer) | Clear "couldn't read this PDF" message |

### Money — integer paise (the money-safe primitive)

All money is stored and computed as **integer paise** (₹1 = 100 paise) inside
the engine. There is no floating-point money, which is what makes the pricing
reliable:

- **The cart threshold is compared exactly** — an exact ₹4,000 cart triggers a
  `≥ 4,000` rule reliably (no float error like `3999.9999…`).
- **Precision is preserved on ingest** — ₹3,999.60 becomes `399960` paise, not a
  pre-rounded ₹4,000.
- **One rounding point:** only the percentage step (a percentage of an integer
  can be fractional paise) rounds, to the nearest paise.
- **Display is derived, never independently rounded.** Whole-rupee figures come
  from a single canonical value: a line's *saving* is `displayedBase −
  displayedFinal`, and the cart total is `displayedSubtotal − displayedSaved`. So
  the receipt always adds up and no two numbers can contradict each other (e.g. a
  ₹5 item at 10% off shows "final ₹5, you save —", never "save ₹1").

The one residual trade-off: because prices display in whole rupees but the
threshold is decided in exact paise, a cart can display a rounded subtotal that
differs from the exact value used for the threshold by under a rupee at a razor
boundary — the standard, documented reality of any whole-rupee receipt.

### LLM abuse controls

The serverless proxy bounds per-request cost (input length limit, `max_tokens`
cap, and a 10s abort timeout). True per-IP rate limiting would need a shared
store (Vercel KV / Upstash) and is out of scope for this prototype — noted as the
next step before the endpoint were truly public.

## Deploy

```bash
npm run build            # outputs to dist/
```

Deployed on Vercel (Vite framework preset). Set `GROQ_API_KEY` as an environment
variable in the Vercel project so the serverless function can reach Groq. The
`api/parse-rule.js` function is deployed automatically.

## Project structure

```
api/
  parse-rule.js         ← serverless function (LLM proxy, keeps key server-side)
  _groq.js              ← shared Groq call (also used by the Vite dev middleware)
src/
  engine/
    discountEngine.js   ← pure item + cart pricing
    ruleValidation.js   ← the single validation/trust boundary
    csvParser.js        ← CSV input adapter
  adapters/
    nlRuleAdapter.js    ← natural-language input adapter (Task 2)
    pdfCartAdapter.js   ← PDF input adapter — pdf.js token extraction (Task 3)
    pdfTable.js         ← pure PDF table reconstruction (unit-testable)
  components/           ← upload areas, NL input, tables, banners
  App.jsx               ← wiring: input modes → engine → results
sample-data/
  rules.csv, cart.csv, cart.pdf
```
