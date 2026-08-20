/**
 * ruleValidation.js
 *
 * The single trust boundary for discount rules.
 *
 * Every input path — CSV upload, natural-language (LLM), and (future) any
 * other source — funnels its raw rule object through `validateRule` before it
 * is ever handed to the engine. Nothing downstream has to re-check a rule:
 * if it made it past here, it is structurally sound.
 *
 * This is the file the assignment's "inputs adapt to the engine, not the other
 * way around" principle hinges on. Adapters produce a raw shape; this validates
 * and normalises it into the canonical DiscountRule the engine consumes.
 */

export const SCOPES = ['platform', 'brand', 'cart']
export const TYPES = ['percentage', 'flat']

/** Trim, lowercase, and collapse internal whitespace. Used for all matching. */
export function normalize(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Coerce loose truthy strings/booleans ("true", "1", "yes", true) to boolean. */
export function coerceBool(v) {
  if (typeof v === 'boolean') return v
  const s = normalize(v)
  return s === 'true' || s === '1' || s === 'yes' || s === 'y'
}

function err(reason) {
  return { ok: false, error: reason }
}

/**
 * Validates and normalises a raw rule into a canonical DiscountRule.
 *
 * Accepts a partial/loose object (from CSV columns or an LLM) with fields:
 *   ruleId?, scope, appliesTo?, type, value, stackable?, minCartValue?
 *
 * Returns { ok: true, rule } or { ok: false, error }.
 *
 * Decisions enforced here (all documented in the README):
 *   - scope ∈ {platform, brand, cart}
 *   - type  ∈ {percentage, flat}
 *   - value > 0; and for percentage, value ≤ 100  (blocks "150% off")
 *   - cart rules REQUIRE a positive minCartValue and ignore appliesTo/stackable
 *   - non-cart rules REQUIRE a non-empty appliesTo target
 */
export function validateRule(raw) {
  if (!raw || typeof raw !== 'object') return err('rule is empty or not an object')

  const scope = normalize(raw.scope)
  if (!SCOPES.includes(scope)) {
    return err(`scope must be one of ${SCOPES.join(', ')} — got "${raw.scope ?? ''}"`)
  }

  const type = normalize(raw.type)
  if (!TYPES.includes(type)) {
    return err(`type must be "percentage" or "flat" — got "${raw.type ?? ''}"`)
  }

  const value = Number(raw.value)
  if (!Number.isFinite(value) || value <= 0) {
    return err(`value must be a positive number — got "${raw.value ?? ''}"`)
  }
  if (type === 'percentage' && value > 100) {
    return err(`percentage value must be between 0 and 100 — got ${value}`)
  }

  const appliesTo = String(raw.appliesTo ?? '').trim()

  let minCartValue = null
  if (scope === 'cart') {
    minCartValue = Number(raw.minCartValue)
    if (!Number.isFinite(minCartValue) || minCartValue <= 0) {
      return err('a cart rule needs a positive minimum cart value (e.g. "cart total ≥ Rs.4,000")')
    }
  } else if (!appliesTo) {
    return err(`a ${scope} rule needs an "applies to" target (e.g. a brand or platform name)`)
  }

  const rule = {
    ruleId: String(raw.ruleId ?? '').trim() || null, // callers assign one if absent
    scope,
    // Cart rules apply to the whole cart, so appliesTo is meaningless for them.
    appliesTo: scope === 'cart' ? '' : appliesTo,
    type,
    value,
    // stackable is only defined for item-level rules; cart rules never stack.
    stackable: scope === 'cart' ? false : coerceBool(raw.stackable),
    minCartValue,
  }

  return { ok: true, rule }
}
