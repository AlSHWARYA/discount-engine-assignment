# Opptra Discount Engine

A customer-facing cart pricing engine. Upload discount rules and a cart, and it
shows the final price of each item, the offer applied in plain language, and a
cart-level offer if the total qualifies. Rules can also be added in **plain
English** (parsed by an LLM) or a cart can be loaded from a **PDF**.

**Live demo:** https://discount-engine-assignment-two.vercel.app/

## Run locally (3 steps)

```bash
npm install
cp .env.example .env      # then paste your free Groq key (console.groq.com) into it
npm run dev               # http://localhost:5173
```

Upload `sample-data/rules.csv` and `sample-data/cart.csv`, click **Calculate
Discounts**, and you should see the expected results below. (Task 2's plain-English
input needs the Groq key; everything else works without it.)

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
| LLM returns non-JSON / fences / bad fields | Stripped, parsed, then **re-validated** via the shared boundary before the confirm step |
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
| Scanned/image PDF (no text layer) | Clear "couldn't read this PDF" message |

### Rounding
Prices are shown in whole rupees (the spec's expected figures are all whole
rupees, though the maths produces fractions like Rs.1,104.15). The policy:

- **Full precision internally** — no rounding mid-calculation.
- **Round only at render.**
- **The cart threshold is checked against the unrounded subtotal**, so a cart at
  Rs.3,999.60 does not get falsely rounded up over a Rs.4,000 threshold.
- **Line-sum guard:** the displayed cart total is derived from the rounded line
  items, so the receipt visibly adds up.

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
