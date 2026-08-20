/**
 * discountEngine.js
 *
 * Pure discount calculation. No UI, no I/O, no knowledge of input source.
 *
 * MONEY IS INTEGER PAISE. Every price/discount here is an integer number of
 * paise (₹1 = 100 paise). This is the money-safe primitive: there is no
 * floating-point money, so the cart threshold is compared exactly and the
 * "when to round" problem collapses. The ONLY rounding is the percentage step
 * (a percentage of an integer can be fractional paise), rounded once, to the
 * nearest paise.
 *
 * Rule money stays authored: rule.value is a 0–100 percent OR flat rupees;
 * rule.minCartValue is rupees. They are converted to paise at point of use.
 *
 * Data shapes:
 *   CartItem { itemId, product, brand, platform, basePrice }   // basePrice in PAISE
 *   DiscountRule { ruleId, scope, appliesTo, type, value, stackable, minCartValue }
 *   DiscountResult { ..., basePrice, finalPrice, totalDiscount }  // all PAISE
 */

import { normalize } from './ruleValidation.js'

const RUPEE = 100 // paise per rupee
const toPaise = (rupees) => Math.round(rupees * RUPEE)
export const paiseToRupees = (paise) => Math.round(paise / RUPEE)

/** Returns true if an item-level rule (brand/platform) applies to this item. */
export function ruleMatchesItem(item, rule) {
  if (rule.scope === 'cart') return false
  if (rule.scope === 'brand') return normalize(item.brand) === normalize(rule.appliesTo)
  if (rule.scope === 'platform') return normalize(item.platform) === normalize(rule.appliesTo)
  return false
}

/**
 * Discount a rule gives on a price, in PAISE. Uses the price passed in (so
 * stacking compounds on the discounted price). Flat discounts are capped at the
 * price so a result can never go negative.
 */
export function calculateDiscountAmount(pricePaise, rule) {
  if (rule.type === 'percentage') return Math.round((pricePaise * rule.value) / 100)
  if (rule.type === 'flat') return Math.min(toPaise(rule.value), pricePaise)
  return 0
}

/** Customer-facing label for an applied rule. */
function ruleToReasoning(rule) {
  const scopeLabel = rule.scope === 'brand' ? 'Brand' : rule.scope === 'cart' ? 'Cart' : 'Platform'
  if (rule.type === 'percentage') return `${scopeLabel} offer: ${rule.value}% off`
  if (rule.type === 'flat') return `${scopeLabel} offer: Rs.${rule.value} off`
  return `${scopeLabel} offer applied`
}

/** Largest-saving non-stackable rule; ties broken by load order (first wins). */
function pickWinner(nonStackable, basePaise) {
  let winner = null
  let winnerSaving = -Infinity
  const skipped = []
  for (const rule of nonStackable) {
    const saving = calculateDiscountAmount(basePaise, rule)
    if (saving > winnerSaving) {
      if (winner) skipped.push(winner)
      winner = rule
      winnerSaving = saving
    } else {
      skipped.push(rule)
    }
  }
  return { winner, skipped }
}

/** Applies the active rules to one cart item. Returns a DiscountResult (paise). */
export function applyDiscounts(item, rules) {
  const base = {
    itemId: item.itemId,
    product: item.product,
    brand: item.brand,
    platform: item.platform,
    basePrice: item.basePrice,
  }

  if (!Number.isInteger(item.basePrice) || item.basePrice <= 0) {
    return { ...base, finalPrice: 0, totalDiscount: 0, appliedRules: [], skippedRules: [], reasoning: 'Invalid base price — item skipped', flagged: true }
  }

  const matching = rules.filter((r) => r.scope !== 'cart' && ruleMatchesItem(item, r))

  if (matching.length === 0) {
    return { ...base, finalPrice: item.basePrice, totalDiscount: 0, appliedRules: [], skippedRules: [], reasoning: 'No offers available', flagged: false }
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

  // Percentages first, then flats — order matters once both stack; deterministic.
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

  const finalPrice = Math.max(0, price)
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

/** Runs applyDiscounts across every cart item. */
export function processCart(cartItems, rules) {
  return cartItems.map((item) => applyDiscounts(item, rules))
}

/**
 * Builds the full cart summary with a money-safe, internally consistent receipt.
 *
 *   - Threshold is checked against the EXACT paise subtotal (no float, so the
 *     exact-Rs.4,000 boundary is reliable).
 *   - Displayed figures are all in whole rupees and DERIVED so the receipt adds
 *     up: line saving = displayedBase − displayedFinal; cart total =
 *     displayedSubtotal − displayedSaved. Nothing is rounded independently.
 *
 * Returns:
 *   {
 *     items: DiscountResult[]          // paise
 *     lines: [{ ...display fields in rupees }]
 *     subtotal:   number (rupees)      // sum of rounded line finals
 *     cartOffer:  null | { ruleId, type, value, label, savedRupees }
 *     finalTotal: number (rupees)      // subtotal − cart saving (derived)
 *     subtotalPaise: number            // exact, used for the threshold
 *   }
 */
export function summarizeCart(results, rules) {
  const priced = results.filter((r) => !r.flagged)
  const subtotalPaise = priced.reduce((sum, r) => sum + r.finalPrice, 0)

  // Displayed lines — saving derived from displayed base/final (never independent).
  const lines = results.map((r) => {
    const baseR = paiseToRupees(r.basePrice)
    const finalR = r.flagged ? null : paiseToRupees(r.finalPrice)
    return {
      itemId: r.itemId,
      product: r.product,
      basePrice: baseR,
      finalPrice: finalR,
      saved: r.flagged ? 0 : baseR - finalR,
      reasoning: r.reasoning,
      flagged: r.flagged,
    }
  })
  const subtotal = lines.filter((l) => !l.flagged).reduce((s, l) => s + l.finalPrice, 0)

  // Cart offer decided on the EXACT paise subtotal; best saving wins, no stacking.
  const applicable = rules.filter((r) => r.scope === 'cart' && subtotalPaise >= toPaise(r.minCartValue))
  let cartOffer = null
  let cartSavingPaise = 0
  if (applicable.length > 0) {
    let best = null
    let bestSaving = -Infinity
    for (const rule of applicable) {
      const saving = calculateDiscountAmount(subtotalPaise, rule)
      if (saving > bestSaving) { best = rule; bestSaving = saving }
    }
    cartSavingPaise = bestSaving
    cartOffer = {
      ruleId: best.ruleId,
      type: best.type,
      value: best.value,
      label: best.type === 'percentage' ? `Cart offer: ${best.value}% off` : `Cart offer: Rs.${best.value} off`,
      savedRupees: paiseToRupees(cartSavingPaise),
    }
  }

  const finalTotal = Math.max(0, subtotal - (cartOffer ? cartOffer.savedRupees : 0))
  return { items: results, lines, subtotal, cartOffer, finalTotal, subtotalPaise }
}
