/**
 * pdfTable.js
 *
 * Pure table reconstruction for the PDF cart adapter — no pdf.js, no DOM, so it
 * is unit-tested (see test/engine.test.mjs). Given text tokens with X/Y
 * coordinates (one array per page), it rebuilds the Product/Brand/Platform/Base
 * Price table by clustering tokens into columns by X (so multi-word fields
 * survive). Prices become integer PAISE, matching the engine.
 *
 * Returns { items, skipped, error }.
 */

const Y_TOL = 3

// Substring matchers so a header cell works whether the PDF emits "Base Price"
// as one token or as separate "Base" / "Price" tokens.
const COLUMN_KEYS = [
  { key: 'product', match: (s) => s.includes('product') },
  { key: 'brand', match: (s) => s.includes('brand') },
  { key: 'platform', match: (s) => s.includes('platform') },
  { key: 'basePrice', match: (s) => s === 'base' || s.includes('price') },
]

const norm = (s) => s.trim().toLowerCase()
const isDivider = (s) => /^[\s─―—–=_-]+$/.test(s) && s.trim().length > 0

/** Parse a price (may be negative) out of noisy text: "Rs.1,299" → 1299, "Rs.-5" → -5. */
export function parsePrice(raw) {
  const m = String(raw).match(/(-?\d[\d,]*(?:\.\d+)?)/)
  if (!m) return NaN
  return parseFloat(m[1].replace(/,/g, ''))
}

/** True if a row's tokens look like a header row (used to skip repeated headers). */
function looksLikeHeader(tokens) {
  const found = {}
  for (const t of tokens) {
    const n = norm(t.str)
    for (const col of COLUMN_KEYS) if (col.match(n)) found[col.key] = true
  }
  return found.product && found.basePrice && found.brand
}

function groupRows(tokens) {
  const rows = []
  for (const t of tokens) {
    let row = rows.find((r) => Math.abs(r.y - t.y) <= Y_TOL)
    if (!row) { row = { y: t.y, tokens: [] }; rows.push(row) }
    row.tokens.push(t)
  }
  rows.forEach((r) => r.tokens.sort((a, b) => a.x - b.x))
  return rows.sort((a, b) => b.y - a.y)
}

function tokensToRecord(tokens, anchors) {
  const cells = {}
  for (const t of tokens) {
    let chosen = anchors[0]
    for (const a of anchors) if (t.x + 1 >= a.x) chosen = a
    cells[chosen.key] = (cells[chosen.key] ? cells[chosen.key] + ' ' : '') + t.str.trim()
  }
  for (const k of Object.keys(cells)) cells[k] = cells[k].replace(/\s+/g, ' ').trim()
  return cells
}

export function buildCartFromPages(pages) {
  const allRows = []
  for (const tokens of pages) allRows.push(...groupRows(tokens))

  if (allRows.length === 0) {
    return { items: [], skipped: [], error: 'No selectable text found — this looks like a scanned/image PDF. Please upload a text-based cart PDF.' }
  }

  let anchors = null
  let headerIndex = -1
  for (let i = 0; i < allRows.length; i++) {
    const found = {}
    for (const t of allRows[i].tokens) {
      const n = norm(t.str)
      for (const col of COLUMN_KEYS) if (col.match(n) && found[col.key] === undefined) found[col.key] = t.x
    }
    if (found.product !== undefined && found.basePrice !== undefined && found.brand !== undefined) {
      anchors = COLUMN_KEYS.filter((c) => found[c.key] !== undefined).map((c) => ({ key: c.key, x: found[c.key] })).sort((a, b) => a.x - b.x)
      headerIndex = i
      break
    }
  }

  if (!anchors) {
    return { items: [], skipped: [], error: 'Could not find a header row (Product, Brand, Platform, Base Price). Check the PDF format.' }
  }

  const items = []
  const skipped = []
  let seq = 0

  for (let i = headerIndex + 1; i < allRows.length; i++) {
    const row = allRows[i]
    const rawText = row.tokens.map((t) => t.str).join(' ').trim()
    if (!rawText || isDivider(rawText)) continue          // structural line
    if (looksLikeHeader(row.tokens)) continue             // repeated header on a later page

    const rec = tokensToRecord(row.tokens, anchors)
    const price = parsePrice(rec.basePrice || '')
    const missing = []
    if (!rec.product) missing.push('product')
    if (!rec.brand) missing.push('brand')
    if (!rec.platform) missing.push('platform')

    if (missing.length > 0) {
      skipped.push({ row: i + 1, text: rawText, reason: `missing ${missing.join(', ')}` })
      continue
    }
    if (!Number.isFinite(price) || price <= 0) {
      skipped.push({ row: i + 1, text: rawText, reason: `unreadable or non-positive price "${rec.basePrice || ''}"` })
      continue
    }

    seq += 1
    items.push({
      itemId: `ITEM-${String(seq).padStart(2, '0')}`,
      product: rec.product,
      brand: rec.brand,
      platform: rec.platform,
      basePrice: Math.round(price * 100), // paise
    })
  }

  return { items, skipped, error: null }
}
