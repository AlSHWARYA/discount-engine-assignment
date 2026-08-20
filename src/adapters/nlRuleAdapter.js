/**
 * nlRuleAdapter.js  (INPUT ADAPTER — Task 2)
 *
 * Turns plain English into a validated DiscountRule the engine already
 * understands. It calls the serverless LLM endpoint, then runs the result
 * through the SAME `validateRule` boundary the CSV path uses — the model's
 * output is never trusted directly.
 *
 * Returns a discriminated result the UI can render without knowing about LLMs:
 *   { status: 'ok',           rule, extraCount }   — parsed & valid (extraCount>0 ⇒ more rules were in the text)
 *   { status: 'unresolvable', reason }             — ambiguous input, ask the user to clarify
 *   { status: 'error',        reason }             — LLM/network/validation failure
 */

import { validateRule } from '../engine/ruleValidation.js'

export async function parseNaturalLanguageRule(text) {
  if (!text || !text.trim()) {
    return { status: 'error', reason: 'Type a rule to parse.' }
  }

  let payload
  try {
    const resp = await fetch('/api/parse-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    })
    payload = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      return { status: 'error', reason: payload.error || `Request failed (${resp.status}).` }
    }
  } catch {
    return { status: 'error', reason: 'Could not reach the parser. Check your connection and try again.' }
  }

  if (!payload.resolvable || !Array.isArray(payload.rules) || payload.rules.length === 0) {
    return {
      status: 'unresolvable',
      reason: payload.reason || 'That rule was ambiguous. Add a value and a target (brand, platform, or cart threshold).',
    }
  }

  // Multi-rule input: take the first, tell the UI others were present (never silently drop).
  const extraCount = payload.rules.length - 1
  const validated = validateRule(payload.rules[0])
  if (!validated.ok) {
    return { status: 'error', reason: `Parsed rule was invalid: ${validated.error}` }
  }

  return { status: 'ok', rule: validated.rule, extraCount }
}
