/**
 * Edge-case + property suite for the engine and adapters.
 * Pure logic only (no browser, no network). Run with `npm test`.
 *
 * Money is integer paise inside the engine; display assertions use the derived
 * rupee figures from summarizeCart.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { validateRule, validateRuleStrict, normalize } from '../src/engine/ruleValidation.js'
import { parseRulesCSV, parseCartCSV } from '../src/engine/csvParser.js'
import { applyDiscounts, processCart, summarizeCart } from '../src/engine/discountEngine.js'
import { buildCartFromPages, parsePrice } from '../src/adapters/pdfTable.js'

const here = dirname(fileURLToPath(import.meta.url))
const sample = (f) => readFileSync(join(here, '..', 'sample-data', f), 'utf8')

const brand = (appliesTo, type, value, stackable = false, ruleId = 'R') =>
  ({ ruleId, scope: 'brand', appliesTo, type, value, stackable, minCartValue: null })
const item = (rupees, over = {}) => ({ itemId: 'X', product: 'p', brand: 'B', platform: 'P', basePrice: rupees * 100, ...over })
const cartRule = (value, min, id = 'C') => ({ ruleId: id, scope: 'cart', appliesTo: '', type: 'percentage', value, stackable: false, minCartValue: min })
const line = (finalPaise, flagged = false) => ({ itemId: 'A', basePrice: finalPaise, finalPrice: finalPaise, flagged })

// ── Spec results ────────────────────────────────────────────────

test('sample data reproduces the six spec item results', () => {
  const { data: rules } = parseRulesCSV(sample('rules.csv'))
  const { data: cart } = parseCartCSV(sample('cart.csv'))
  const s = summarizeCart(processCart(cart, rules), rules)
  const got = Object.fromEntries(s.lines.map((l) => [l.itemId, l.finalPrice]))
  assert.deepEqual(got, { 'ITEM-01': 1104, 'ITEM-02': 629, 'ITEM-03': 509, 'ITEM-04': 2499, 'ITEM-05': 382, 'ITEM-06': 809 })
})

test('cart offer reproduces Rs.5,339 final total', () => {
  const { data: rules } = parseRulesCSV(sample('rules.csv'))
  const { data: cart } = parseCartCSV(sample('cart.csv'))
  const s = summarizeCart(processCart(cart, rules), rules)
  assert.equal(s.subtotal, 5932)
  assert.equal(s.cartOffer.ruleId, 'RULE-04')
  assert.equal(s.cartOffer.savedRupees, 593)
  assert.equal(s.finalTotal, 5339)
})

// ── Money-safety / the reviewer's bugs ──────────────────────────

test('Rs.5 @ 10% off: receipt is internally consistent (no phantom saving)', () => {
  const s = summarizeCart(processCart([item(5)], []).map(() => applyDiscounts(item(5), [brand('B', 'percentage', 10)])), [])
  const l = s.lines[0]
  assert.equal(l.basePrice, 5)
  assert.equal(l.finalPrice, 5)
  assert.equal(l.saved, 0) // NOT 1 — saving is derived from displayed base/final
})

test('exact Rs.4,000 threshold triggers (integer paise, no float error)', () => {
  const s = summarizeCart([line(200000), line(200000)], [cartRule(10, 4000)]) // 4000.00 exactly
  assert.equal(s.cartOffer.ruleId, 'C')
})

test('one paise below the threshold does not trigger', () => {
  const s = summarizeCart([line(399999)], [cartRule(10, 4000)])
  assert.equal(s.cartOffer, null)
})

test('flat discount exceeding base clamps to 0', () => {
  const r = applyDiscounts(item(449), [brand('B', 'flat', 2000)])
  assert.equal(r.finalPrice, 0)
  assert.equal(r.totalDiscount, 44900)
})

// ── Item pricing ────────────────────────────────────────────────

test('tie in savings resolves to load order (first wins)', () => {
  const r = applyDiscounts(item(1000), [brand('B', 'percentage', 10, false, 'FIRST'), brand('B', 'flat', 100, false, 'SECOND')])
  assert.deepEqual(r.appliedRules, ['FIRST'])
  assert.deepEqual(r.skippedRules, ['SECOND'])
})

test('zero / negative base price is flagged', () => {
  assert.equal(applyDiscounts(item(0), [brand('B', 'flat', 50)]).flagged, true)
})

test('stackable rule applies alone when no non-stackable matches', () => {
  const r = applyDiscounts(item(900), [brand('B', 'percentage', 10, true, 'S')])
  assert.equal(r.finalPrice, 81000) // paise
})

test('mixed stackables apply percentages before flats', () => {
  const r = applyDiscounts(item(700), [
    { ruleId: 'F', scope: 'platform', appliesTo: 'P', type: 'flat', value: 100, stackable: true, minCartValue: null },
    { ruleId: 'P', scope: 'brand', appliesTo: 'B', type: 'percentage', value: 10, stackable: true, minCartValue: null },
  ])
  assert.equal(r.finalPrice, 53000) // 70000 → -10% = 63000 → -10000 = 53000
})

test('matching is case- and whitespace-insensitive', () => {
  const r = applyDiscounts(item(1000, { platform: 'Amazon India' }),
    [{ ruleId: 'R', scope: 'platform', appliesTo: '  amazon   india ', type: 'percentage', value: 10, stackable: false, minCartValue: null }])
  assert.equal(r.finalPrice, 90000)
})

// ── Cart pricing ────────────────────────────────────────────────

test('multiple qualifying cart rules → best saving wins', () => {
  const s = summarizeCart([line(500000)], [cartRule(10, 4000, 'TEN'), cartRule(20, 4000, 'TWENTY')])
  assert.equal(s.cartOffer.ruleId, 'TWENTY')
  assert.equal(s.finalTotal, 4000)
})

test('empty cart summarizes to 0', () => {
  const s = summarizeCart([], [cartRule(10, 4000)])
  assert.equal(s.subtotal, 0)
  assert.equal(s.finalTotal, 0)
  assert.equal(s.cartOffer, null)
})

// ── Validation boundary ─────────────────────────────────────────

test('coercive validation: percentage over 100 rejected', () => assert.equal(validateRule({ scope: 'brand', appliesTo: 'B', type: 'percentage', value: 150 }).ok, false))
test('coercive validation: cart rule without threshold rejected', () => assert.equal(validateRule({ scope: 'cart', type: 'percentage', value: 10 }).ok, false))
test('coercive validation: non-cart without appliesTo rejected', () => assert.equal(validateRule({ scope: 'brand', type: 'flat', value: 50 }).ok, false))

test('strict decoder rejects wrong JSON types', () => {
  assert.equal(validateRuleStrict({ scope: 'brand', appliesTo: 'B', type: 'percentage', value: true }).ok, false)
  assert.equal(validateRuleStrict({ scope: 'cart', type: 'percentage', value: 10, minCartValue: true }).ok, false)
  assert.equal(validateRuleStrict({ scope: 'brand', appliesTo: { name: 'Nike' }, type: 'flat', value: 10 }).ok, false)
  assert.equal(validateRuleStrict({ scope: 'brand', appliesTo: 'B', type: 'flat', value: 10, stackable: '???' }).ok, false)
})
test('strict decoder accepts a well-typed rule', () => {
  assert.equal(validateRuleStrict({ scope: 'brand', appliesTo: 'Nike', type: 'percentage', value: 20, stackable: true }).ok, true)
})

// ── CSV adapter ─────────────────────────────────────────────────

test('wrong file in rules zone is rejected clearly', () => {
  const { data, errors } = parseRulesCSV(sample('cart.csv'))
  assert.equal(data.length, 0)
  assert.match(errors[0], /doesn't look like a rules file/)
})

test('base_price rejects garbage and Infinity', () => {
  const csv = 'item_id,product,brand,platform,base_price\nI1,P,B,PL,100abc\nI2,P,B,PL,Infinity\nI3,P,B,PL,500'
  const { data, errors } = parseCartCSV(csv)
  assert.equal(data.length, 1)
  assert.equal(data[0].basePrice, 50000) // 500 rupees in paise
  assert.equal(errors.length, 2)
})

test('duplicate ids are rejected', () => {
  const csv = 'item_id,product,brand,platform,base_price\nI1,P,B,PL,100\nI1,Q,B,PL,200'
  const { data, errors } = parseCartCSV(csv)
  assert.equal(data.length, 1)
  assert.match(errors[0], /duplicate item_id/)
})

test('decimal price is preserved as paise (no pre-rounding)', () => {
  const csv = 'item_id,product,brand,platform,base_price\nI1,P,B,PL,3999.60'
  const { data } = parseCartCSV(csv)
  assert.equal(data[0].basePrice, 399960)
})

// ── PDF adapter ─────────────────────────────────────────────────

const T = (str, x, y) => ({ str, x, y })
const header = (y) => [T('Product', 50, y), T('Brand', 200, y), T('Platform', 320, y), T('Base Price', 470, y)]
const dataRow = (prod, br, pl, pr, y) => [T(prod, 50, y), T(br, 200, y), T(pl, 320, y), T(pr, 470, y)]

test('PDF: clean table extracts items (paise) with multi-word fields', () => {
  const page = [...header(700), ...dataRow('Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299', 680)]
  const { items, error } = buildCartFromPages([page])
  assert.equal(error, null)
  assert.deepEqual(items[0], { itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 129900 })
})

test('PDF: partial failure loads good rows, surfaces bad', () => {
  const badPlatform = [T('Bad Item', 50, 660), T('BrandB', 200, 660), T('Rs.300', 470, 660)]
  const badPrice = dataRow('Priceless', 'BrandC', 'Noon', 'N/A', 640)
  const page = [...header(700), ...dataRow('Good', 'BrandA', 'Flipkart', 'Rs.500', 680), ...badPlatform, ...badPrice]
  const { items, skipped } = buildCartFromPages([page])
  assert.equal(items.length, 1)
  assert.equal(skipped.length, 2)
})

test('PDF: negative price is skipped, not read as positive', () => {
  const page = [...header(700), ...dataRow('Neg', 'BrandA', 'Flipkart', 'Rs.-500', 680)]
  const { items, skipped } = buildCartFromPages([page])
  assert.equal(items.length, 0)
  assert.equal(skipped.length, 1)
})

test('PDF: repeated header on a later page is skipped, not flagged', () => {
  const p1 = [...header(700), ...dataRow('A', 'BrandA', 'Flipkart', 'Rs.100', 680)]
  const p2 = [...header(700), ...dataRow('B', 'BrandB', 'Noon', 'Rs.200', 680)]
  const { items, skipped } = buildCartFromPages([p1, p2])
  assert.equal(items.length, 2)
  assert.equal(skipped.length, 0)
})

test('PDF: no text layer / no header report clear errors', () => {
  assert.match(buildCartFromPages([[]]).error, /No selectable text/)
  assert.match(buildCartFromPages([dataRow('X', 'Y', 'Z', 'Rs.10', 700)]).error, /header row/)
})

test('parsePrice handles currency noise and signs', () => {
  assert.equal(parsePrice('Rs.1,299'), 1299)
  assert.equal(parsePrice('₹1,299.00'), 1299)
  assert.equal(parsePrice('Rs.-500'), -500)
  assert.ok(Number.isNaN(parsePrice('N/A')))
})

test('normalize collapses whitespace and case', () => assert.equal(normalize('  Amazon   India '), 'amazon india'))

// ── Property tests (invariants over random inputs) ──────────────

function randomRule(i) {
  const scopes = ['brand', 'platform']
  const types = ['percentage', 'flat']
  const type = types[Math.floor(Math.random() * 2)]
  return {
    ruleId: `R${i}`,
    scope: scopes[Math.floor(Math.random() * 2)],
    appliesTo: Math.random() < 0.5 ? 'B' : 'P',
    type,
    value: type === 'percentage' ? Math.floor(Math.random() * 100) + 1 : Math.floor(Math.random() * 500) + 1,
    stackable: Math.random() < 0.5,
    minCartValue: null,
  }
}
function randomCart(n) {
  return Array.from({ length: n }, (_, i) => ({ itemId: `I${i}`, product: 'p', brand: 'B', platform: 'P', basePrice: (Math.floor(Math.random() * 9999) + 1) * 100 }))
}

test('property: final price is always 0 ≤ final ≤ base', () => {
  for (let t = 0; t < 500; t++) {
    const rules = Array.from({ length: Math.floor(Math.random() * 4) }, (_, i) => randomRule(i))
    for (const r of processCart(randomCart(5), rules)) {
      assert.ok(r.finalPrice >= 0, 'final >= 0')
      assert.ok(r.finalPrice <= r.basePrice, 'final <= base')
      assert.equal(r.totalDiscount, r.basePrice - r.finalPrice)
    }
  }
})

test('property: displayed receipt always adds up', () => {
  for (let t = 0; t < 500; t++) {
    const rules = Array.from({ length: Math.floor(Math.random() * 4) }, (_, i) => randomRule(i))
    const s = summarizeCart(processCart(randomCart(6), rules), rules)
    // per-line: saved === base − final
    for (const l of s.lines) {
      if (!l.flagged) assert.equal(l.saved, l.basePrice - l.finalPrice)
    }
    // subtotal === sum of line finals; total === subtotal − cart saving
    const sumLines = s.lines.filter((l) => !l.flagged).reduce((a, l) => a + l.finalPrice, 0)
    assert.equal(s.subtotal, sumLines)
    assert.equal(s.finalTotal, s.subtotal - (s.cartOffer ? s.cartOffer.savedRupees : 0))
  }
})
