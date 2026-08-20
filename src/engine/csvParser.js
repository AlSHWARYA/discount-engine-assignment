/**
 * csvParser.js
 *
 * CSV input adapter. Converts raw CSV text into the typed objects the engine
 * expects, then routes every rule through the shared `validateRule` boundary.
 * It knows about CSV columns; it knows nothing about discount maths.
 *
 * rules.csv columns: rule_id, scope, applies_to, type, value, stackable, min_cart_value
 * cart.csv  columns: item_id, product, brand, platform, base_price
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

/**
 * Guards against uploading the wrong file into the wrong drop zone
 * (e.g. cart.csv into the rules area). Returns an error string, or null if ok.
 */
function checkHeaders(rows, required, label) {
  if (rows.length === 0) return `This file appears to be empty.`
  const present = Object.keys(rows[0])
  const missing = required.filter((c) => !present.includes(c))
  if (missing.length === required.length) {
    return `This doesn't look like a ${label} file — expected columns like "${required.join('", "')}". Did you upload the wrong file here?`
  }
  return null
}

/** Parses rules.csv → { data: DiscountRule[], errors: string[] }. */
export function parseRulesCSV(csvText) {
  const { data: rows, errors: parseErrors } = parse(csvText)
  if (parseErrors.length > 0) {
    return { data: [], errors: parseErrors.map((e) => e.message) }
  }

  const headerErr = checkHeaders(rows, ['rule_id', 'scope', 'type', 'value'], 'rules')
  if (headerErr) return { data: [], errors: [headerErr] }

  const data = []
  const errors = []

  rows.forEach((row, i) => {
    const rowNum = i + 2 // +1 header, +1 for 1-based
    const raw = {
      ruleId: row.rule_id,
      scope: row.scope,
      appliesTo: row.applies_to,
      type: row.type,
      value: row.value,
      stackable: row.stackable,
      minCartValue: row.min_cart_value,
    }

    if (!raw.ruleId || !String(raw.ruleId).trim()) {
      errors.push(`Row ${rowNum}: missing rule_id`)
      return
    }

    const result = validateRule(raw)
    if (!result.ok) {
      errors.push(`Row ${rowNum} (${raw.ruleId}): ${result.error}`)
      return
    }
    data.push(result.rule)
  })

  return { data, errors }
}

/** Parses cart.csv → { data: CartItem[], errors: string[] }. */
export function parseCartCSV(csvText) {
  const { data: rows, errors: parseErrors } = parse(csvText)
  if (parseErrors.length > 0) {
    return { data: [], errors: parseErrors.map((e) => e.message) }
  }

  const headerErr = checkHeaders(rows, ['item_id', 'product', 'base_price'], 'cart')
  if (headerErr) return { data: [], errors: [headerErr] }

  const data = []
  const errors = []

  rows.forEach((row, i) => {
    const rowNum = i + 2
    const missing = []
    if (!row.item_id) missing.push('item_id')
    if (!row.product) missing.push('product')
    if (!row.brand) missing.push('brand')
    if (!row.platform) missing.push('platform')
    if (row.base_price === undefined || row.base_price === '') missing.push('base_price')

    if (missing.length > 0) {
      errors.push(`Row ${rowNum}: missing fields — ${missing.join(', ')}`)
      return
    }

    const basePrice = parseFloat(row.base_price)
    if (isNaN(basePrice) || basePrice <= 0) {
      errors.push(`Row ${rowNum}: base_price must be a positive number, got "${row.base_price}"`)
      return
    }

    data.push({
      itemId: row.item_id.trim(),
      product: row.product.trim(),
      brand: row.brand.trim(),
      platform: row.platform.trim(),
      basePrice: Math.round(basePrice),
    })
  })

  return { data, errors }
}
