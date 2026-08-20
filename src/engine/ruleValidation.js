/**
 * ruleValidation.js
 *
 * The single trust boundary for discount rules.
 *
 * Two entry points:
 *   - validateRule(raw)        coercive — for CSV, where every cell is a string
 *                              ("15", "true"). Normalises then domain-checks.
 *   - validateRuleStrict(raw)  strict decoder — for LLM/JSON output, where types
 *                              are real. Rejects wrong types (value: true,
 *                              appliesTo: {...}) BEFORE the coercive pass, so the
 *                              model can't smuggle a nonsense rule through
 *                              JavaScript's loose coercion.
 *
 * Money note: `value` (flat rupees) and `minCartValue` (rupees) are kept in
 * rupees as authored, for display. The engine converts them to integer paise at
 * the point of calculation. Percentage `value` is a plain 0–100 number.
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
 * Coercive validation + normalisation into a canonical DiscountRule.
 * Decisions enforced (all documented in the README):
 *   - scope ∈ {platform, brand, cart}; type ∈ {percentage, flat}
 *   - value > 0; percentage value ≤ 100  (blocks "150% off")
 *   - cart rules REQUIRE a positive minCartValue; ignore appliesTo/stackable
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

  const value = toStrictNumber(raw.value)
  if (value === null || value <= 0) {
    return err(`value must be a positive number — got "${raw.value ?? ''}"`)
  }
  if (type === 'percentage' && value > 100) {
    return err(`percentage value must be between 0 and 100 — got ${value}`)
  }

  const appliesTo = String(raw.appliesTo ?? '').trim()

  let minCartValue = null
  if (scope === 'cart') {
    minCartValue = toStrictNumber(raw.minCartValue)
    if (minCartValue === null || minCartValue <= 0) {
      return err('a cart rule needs a positive minimum cart value (e.g. "cart total ≥ Rs.4,000")')
    }
  } else if (!appliesTo) {
    return err(`a ${scope} rule needs an "applies to" target (e.g. a brand or platform name)`)
  }

  const rule = {
    ruleId: String(raw.ruleId ?? '').trim() || null,
    scope,
    appliesTo: scope === 'cart' ? '' : appliesTo,
    type,
    value,
    stackable: scope === 'cart' ? false : coerceBool(raw.stackable),
    minCartValue,
  }
  return { ok: true, rule }
}

/**
 * Strict decoder for LLM/JSON output. Rejects wrong JS types up front — e.g.
 * value:true, minCartValue:true, appliesTo:{name:"Nike"} — then defers to the
 * shared domain checks. This is the "strict decoder before normalization" the
 * CSV path deliberately doesn't need (CSV cells are always strings).
 */
export function validateRuleStrict(raw) {
  if (!raw || typeof raw !== 'object') return err('rule is not an object')

  if (typeof raw.scope !== 'string') return err('scope must be a string')
  if (typeof raw.type !== 'string') return err('type must be a string')
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    return err('value must be a finite number')
  }
  if (raw.appliesTo != null && typeof raw.appliesTo !== 'string') {
    return err('appliesTo must be a string or null')
  }
  if (raw.stackable != null && typeof raw.stackable !== 'boolean') {
    return err('stackable must be a boolean')
  }
  if (raw.minCartValue != null && (typeof raw.minCartValue !== 'number' || !Number.isFinite(raw.minCartValue))) {
    return err('minCartValue must be a finite number or null')
  }
  return validateRule(raw)
}

/** Parse a number strictly: rejects "", "100abc", Infinity, NaN. */
function toStrictNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = String(v ?? '').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
