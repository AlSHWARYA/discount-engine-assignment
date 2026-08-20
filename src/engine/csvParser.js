/**
 * csvParser.js
 *
 * CSV input adapter. Converts CSV text into engine shapes and routes every rule
 * through the shared `validateRule` boundary. Prices are converted to integer
 * PAISE here (₹3,999.60 → 399960 paise) so precision is preserved into the
 * engine rather than pre-rounded.
 *
 * rules.csv: rule_id, scope, applies_to, type, value, stackable, min_cart_value
 * cart.csv : item_id, product, brand, platform, base_price
 */

import Papa from 'papaparse'
import { validateRule } from './ruleValidation.js'

function parse(csvText) {
  return Papa.parse(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })
}

/** Guards against uploading the wrong file into the wrong drop zone. */
function checkHeaders(rows, required, label) {
  if (rows.length === 0) return `This file appears to be empty.`
  const present = Object.keys(rows[0])
  const missing = required.filter((c) => !present.includes(c))
  if (missing.length === required.length) {
    return `This doesn't look like a ${label} file — expected columns like "${required.join('", "')}". Did you upload the wrong file here?`
  }
  return null
}

/** Strict number parse: rejects "", "100abc", Infinity, NaN. */
function strictNumber(v) {
  const t = String(v ?? '').trim()
  if (t === '') return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

/** Parses rules.csv → { data: DiscountRule[], errors: string[] }. */
export function parseRulesCSV(csvText) {
  const { data: rows, errors: parseErrors } = parse(csvText)
  if (parseErrors.length > 0) return { data: [], errors: parseErrors.map((e) => e.message) }

  const headerErr = checkHeaders(rows, ['rule_id', 'scope', 'type', 'value'], 'rules')
  if (headerErr) return { data: [], errors: [headerErr] }

  const data = []
  const errors = []
  const seenIds = new Set()

  rows.forEach((row, i) => {
    const rowNum = i + 2
    const ruleId = String(row.rule_id ?? '').trim()
    if (!ruleId) {
      errors.push(`Row ${rowNum}: missing rule_id`)
      return
    }
    if (seenIds.has(ruleId)) {
      errors.push(`Row ${rowNum}: duplicate rule_id "${ruleId}"`)
      return
    }

    const result = validateRule({
      ruleId,
      scope: row.scope,
      appliesTo: row.applies_to,
      type: row.type,
      value: row.value,
      stackable: row.stackable,
      minCartValue: row.min_cart_value,
    })
    if (!result.ok) {
      errors.push(`Row ${rowNum} (${ruleId}): ${result.error}`)
      return
    }
    seenIds.add(ruleId)
    data.push(result.rule)
  })

  return { data, errors }
}

/** Parses cart.csv → { data: CartItem[] (basePrice in paise), errors: string[] }. */
export function parseCartCSV(csvText) {
  const { data: rows, errors: parseErrors } = parse(csvText)
  if (parseErrors.length > 0) return { data: [], errors: parseErrors.map((e) => e.message) }

  const headerErr = checkHeaders(rows, ['item_id', 'product', 'base_price'], 'cart')
  if (headerErr) return { data: [], errors: [headerErr] }

  const data = []
  const errors = []
  const seenIds = new Set()

  rows.forEach((row, i) => {
    const rowNum = i + 2
    const itemId = String(row.item_id ?? '').trim()
    const product = String(row.product ?? '').trim()
    const brand = String(row.brand ?? '').trim()
    const platform = String(row.platform ?? '').trim()

    const missing = []
    if (!itemId) missing.push('item_id')
    if (!product) missing.push('product')
    if (!brand) missing.push('brand')
    if (!platform) missing.push('platform')
    if (row.base_price === undefined || String(row.base_price).trim() === '') missing.push('base_price')
    if (missing.length > 0) {
      errors.push(`Row ${rowNum}: missing fields — ${missing.join(', ')}`)
      return
    }
    if (seenIds.has(itemId)) {
      errors.push(`Row ${rowNum}: duplicate item_id "${itemId}"`)
      return
    }

    const basePrice = strictNumber(row.base_price)
    if (Number.isNaN(basePrice) || basePrice <= 0) {
      errors.push(`Row ${rowNum}: base_price must be a positive number, got "${row.base_price}"`)
      return
    }

    seenIds.add(itemId)
    data.push({ itemId, product, brand, platform, basePrice: Math.round(basePrice * 100) })
  })

  return { data, errors }
}
