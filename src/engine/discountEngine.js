/**
 * discountEngine.js
 *
 * Pure discount calculation logic. No UI, no side effects, no knowledge of
 * where its inputs came from (CSV, LLM, or PDF). It takes CartItem[] and
 * DiscountRule[] and returns results. This is the calculator the assignment
 * says must NOT be reshaped to accommodate new input modes.
 *
 * Precision policy (see README "Rounding"):
 *   - All arithmetic here runs in full floating-point precision.
 *   - Rounding to whole rupees happens ONLY at render time.
 *   - The cart threshold is checked against the UNROUNDED subtotal.
 *   - `summarizeCart` also returns display integers whose lines visibly sum
 *     to the displayed total (the "line-sum guard").
 *
 * Data shapes:
 *
 * DiscountRule {
 *   ruleId, scope: "brand"|"platform"|"cart", appliesTo, type: "percentage"|"flat",
 *   value: number, stackable: boolean, minCartValue: number|null
 * }
 * CartItem   { itemId, product, brand, platform, basePrice }
 * DiscountResult {
 *   itemId, product, brand, platform, basePrice, finalPrice, totalDiscount,
 *   appliedRules: string[], skippedRules: string[], reasoning: string, flagged: boolean
 * }
 */

import { normalize } from './ruleValidation.js'

/** Returns true if an item-level rule (brand/platform) applies to this item. */
export function ruleMatchesItem(item, rule) {
  if (rule.scope === 'cart') return false // cart rules never match individual items
  if (rule.scope === 'brand') return normalize(item.brand) === normalize(rule.appliesTo)
  if (rule.scope === 'platform') return normalize(item.platform) === normalize(rule.appliesTo)
  return false
}

/**
 * Rupee discount a rule gives on a given price (full precision).
 * Uses the price passed in — important for stacking on the discounted price.
 * Flat discounts are capped at the price so a result can never go negative.
 */
export function calculateDiscountAmount(price, rule) {
  if (rule.type === 'percentage') return (price * rule.value) / 100
  if (rule.type === 'flat') return Math.min(rule.value, price)
  return 0
}

/** Customer-facing label for an applied rule. */
function ruleToReasoning(rule) {
  const scopeLabel = rule.scope === 'brand' ? 'Brand' : rule.scope === 'cart' ? 'Cart' : 'Platform'
  if (rule.type === 'percentage') return `${scopeLabel} offer: ${rule.value}% off`
  if (rule.type === 'flat') return `${scopeLabel} offer: Rs.${rule.value} off`
  return `${scopeLabel} offer applied`
}

/**
 * Picks the non-stackable rule giving the largest rupee saving on `basePrice`.
 * Tie-break is deterministic: the rule appearing FIRST in load order wins
 * (documented). Returns { winner, skipped }.
 */
function pickWinner(nonStackable, basePrice) {
  let winner = null
  let winnerSaving = -Infinity
  const skipped = []
  for (const rule of nonStackable) {
    const saving = calculateDiscountAmount(basePrice, rule)
    if (saving > winnerSaving) {
      if (winner) skipped.push(winner)
      winner = rule
      winnerSaving = saving
    } else {
      skipped.push(rule) // strictly-greater test ⇒ ties keep the earlier rule
    }
  }
  return { winner, skipped }
}

/**
 * Applies the active rules to a single cart item. Returns a DiscountResult.
 *
 *   1. Guard invalid prices (≤ 0) — flagged, never priced.
 *   2. Match item-level rules only (cart rules are excluded here).
 *   3. Among non-stackable matches, apply the largest-saving one.
 *   4. Apply stackable rules on top, percentages before flats (order matters
 *      once a flat and a percentage stack — documented).
 *   5. Clamp final price at 0.
 */
export function applyDiscounts(item, rules) {
  const base = {
    itemId: item.itemId,
    product: item.product,
    brand: item.brand,
    platform: item.platform,
    basePrice: item.basePrice,
  }

  if (!Number.isFinite(item.basePrice) || item.basePrice <= 0) {
    return {
      ...base,
      finalPrice: 0,
      totalDiscount: 0,
      appliedRules: [],
      skippedRules: [],
      reasoning: 'Invalid base price — item skipped',
      flagged: true,
    }
  }

  const matching = rules.filter((r) => r.scope !== 'cart' && ruleMatchesItem(item, r))

  if (matching.length === 0) {
    return {
      ...base,
      finalPrice: item.basePrice,
      totalDiscount: 0,
      appliedRules: [],
      skippedRules: [],
      reasoning: 'No offers available',
      flagged: false,
    }
  }

  const nonStackable = matching.filter((r) => !r.stackable)
  const stackable = matching.filter((r) => r.stackable)

  const { winner, skipped } = pickWinner(nonStackable, item.basePrice)

  let price = item.basePrice
  const appliedRules = []
  const reasoningParts = []

  if (winner) {
    price -= calculateDiscountAmount(price, winner)
    appliedRules.push(winner.ruleId)
    reasoningParts.push(ruleToReasoning(winner))
  }

  // Percentages first, then flats — deterministic and order-stable.
  const orderedStackable = [...stackable].sort((a, b) => {
    const ta = a.type === 'percentage' ? 0 : 1
    const tb = b.type === 'percentage' ? 0 : 1
    return ta - tb || String(a.ruleId).localeCompare(String(b.ruleId))
  })

  for (const rule of orderedStackable) {
    price -= calculateDiscountAmount(price, rule)
    appliedRules.push(rule.ruleId)
    reasoningParts.push(ruleToReasoning(rule))
  }

  const finalPrice = Math.max(0, price) // clamp (full precision retained)

  return {
    ...base,
    finalPrice,
    totalDiscount: item.basePrice - finalPrice,
    appliedRules,
    skippedRules: skipped.map((r) => r.ruleId),
    reasoning: reasoningParts.join(' + '),
    flagged: false,
  }
}

/** Runs applyDiscounts across every cart item. Returns DiscountResult[]. */
export function processCart(cartItems, rules) {
  return cartItems.map((item) => applyDiscounts(item, rules))
}

const round = (x) => Math.round(x)

/**
 * Builds the full cart summary, including the cart-level offer.
 *
 * Threshold decision uses the UNROUNDED subtotal (sum of precise item finals).
 * Displayed figures round each line and derive the total from those rounded
 * lines, so the receipt visibly adds up (line-sum guard). Only the single
 * best-saving cart rule applies; cart rules do not stack with each other.
 *
 * Returns:
 *   {
 *     items:        DiscountResult[]          — precise
 *     subtotal:     number  (integer rupees)  — sum of rounded item finals
 *     cartOffer:    null | { ruleId, label, value, type, savedRupees }
 *     finalTotal:   number  (integer rupees)  — subtotal − cart saving
 *     preciseSubtotal: number                 — used for the threshold check
 *   }
 */
export function summarizeCart(results, rules) {
  const priced = results.filter((r) => !r.flagged)
  const preciseSubtotal = priced.reduce((sum, r) => sum + r.finalPrice, 0)
  const displaySubtotal = priced.reduce((sum, r) => sum + round(r.finalPrice), 0)

  const applicable = rules.filter(
    (r) => r.scope === 'cart' && preciseSubtotal >= r.minCartValue
  )

  let cartOffer = null
  if (applicable.length > 0) {
    // largest saving wins; ties → first in load order
    let best = null
    let bestSaving = -Infinity
    for (const rule of applicable) {
      const saving = calculateDiscountAmount(preciseSubtotal, rule)
      if (saving > bestSaving) {
        best = rule
        bestSaving = saving
      }
    }
    // Saving for display is computed off the displayed subtotal so the
    // rendered line and total stay internally consistent.
    const savedRupees = round(calculateDiscountAmount(displaySubtotal, best))
    cartOffer = {
      ruleId: best.ruleId,
      type: best.type,
      value: best.value,
      label:
        best.type === 'percentage'
          ? `Cart offer: ${best.value}% off`
          : `Cart offer: Rs.${best.value} off`,
      savedRupees,
    }
  }

  const finalTotal = Math.max(0, displaySubtotal - (cartOffer ? cartOffer.savedRupees : 0))

  return { items: results, subtotal: displaySubtotal, cartOffer, finalTotal, preciseSubtotal }
}
