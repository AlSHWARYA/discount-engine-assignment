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
 * Builds the full cart summary with a self-consistent, whole-rupee receipt.
 *
 * ONE BASE for the entire receipt: the displayed whole-rupee subtotal (the sum
 * of the rounded line finals). Cart eligibility, the cart saving, and the final
 * total are ALL computed from that same number — never a mix of exact-paise and
 * rounded values. This guarantees, for any cart (including pathological
 * sub-rupee ones):
 *   - the line items always sum to the subtotal,
 *   - the cart saving is never greater than the subtotal, and
 *   - subtotal − saving === total, exactly.
 *
 * Trade-off (documented in the README): whole-rupee display of sub-rupee item
 * values is inherently lossy, and cart-offer eligibility is judged on the
 * subtotal the customer actually sees — so what's shown is what's charged.
 *
 * Returns:
 *   {
 *     items: DiscountResult[]      // paise
 *     lines: [{ ...display fields in rupees, saving = base − final }]
 *     subtotal:   number (rupees)  // sum of rounded line finals
 *     cartOffer:  null | { ruleId, type, value, label, savedRupees }
 *     finalTotal: number (rupees)  // subtotal − saving
 *   }
 */
export function summarizeCart(results, rules) {
  const lines = results.map((r) => {
    const baseR = paiseToRupees(r.basePrice)
    const finalR = r.flagged ? null : paiseToRupees(r.finalPrice)
    return {
      itemId: r.itemId,
      product: r.product,
      basePrice: baseR,
      finalPrice: finalR,
      saved: r.flagged ? 0 : baseR - finalR, // derived from displayed base/final
      reasoning: r.reasoning,
      flagged: r.flagged,
    }
  })

  const subtotal = lines.filter((l) => !l.flagged).reduce((s, l) => s + l.finalPrice, 0)

  // Everything below is computed on `subtotal` (the displayed rupee value).
  const applicable = rules.filter((r) => r.scope === 'cart' && subtotal >= r.minCartValue)
  let cartOffer = null
  let saving = 0
  if (applicable.length > 0) {
    let best = null
    let bestSaving = -Infinity
    for (const rule of applicable) {
      const s = rule.type === 'percentage' ? Math.round((subtotal * rule.value) / 100) : Math.min(rule.value, subtotal)
      if (s > bestSaving) { best = rule; bestSaving = s }
    }
    saving = bestSaving // ≤ subtotal by construction (pct ≤ 100; flat capped at subtotal)
    cartOffer = {
      ruleId: best.ruleId,
      type: best.type,
      value: best.value,
      label: best.type === 'percentage' ? `Cart offer: ${best.value}% off` : `Cart offer: Rs.${best.value} off`,
      savedRupees: saving,
    }
  }

  const finalTotal = subtotal - saving
  return { items: results, lines, subtotal, cartOffer, finalTotal }
}
