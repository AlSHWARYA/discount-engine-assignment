/**
 * pdfTable.js
 *
 * Pure table-reconstruction logic for the PDF cart adapter — no pdf.js, no DOM,
 * so it is unit-testable in Node. Given text tokens with X/Y coordinates (one
 * array per page), it rebuilds the Product/Brand/Platform/Base Price table by
 * clustering tokens into columns by X position (so multi-word fields survive).
 *
 * Returns { items, skipped, error } — see pdfCartAdapter.js for the shape.
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

/** Pull a price out of noisy currency text: "Rs.1,299" / "₹1,299.00" → 1299. */
export function parsePrice(raw) {
  const m = String(raw).match(/(\d[\d,]*(?:\.\d+)?)/)
  if (!m) return NaN
  return parseFloat(m[1].replace(/,/g, ''))
}

/** Group one page's tokens into rows by Y, each row sorted left→right, top row first. */
function groupRows(tokens) {
  const rows = []
  for (const t of tokens) {
    let row = rows.find((r) => Math.abs(r.y - t.y) <= Y_TOL)
    if (!row) {
      row = { y: t.y, tokens: [] }
      rows.push(row)
    }
    row.tokens.push(t)
  }
  rows.forEach((r) => r.tokens.sort((a, b) => a.x - b.x))
  return rows.sort((a, b) => b.y - a.y)
}

/** Assign a row's tokens to columns by nearest anchor at-or-before their X. */
function tokensToRecord(tokens, anchors) {
  const cells = {}
  for (const t of tokens) {
    let chosen = anchors[0]
    for (const a of anchors) {
      if (t.x + 1 >= a.x) chosen = a
    }
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

  // Locate the header row; derive column anchors from its token X positions.
  let anchors = null
  let headerIndex = -1
  for (let i = 0; i < allRows.length; i++) {
    const found = {}
    for (const t of allRows[i].tokens) {
      const n = norm(t.str)
      for (const col of COLUMN_KEYS) {
        if (col.match(n) && found[col.key] === undefined) found[col.key] = t.x
      }
    }
    if (found.product !== undefined && found.basePrice !== undefined && found.brand !== undefined) {
      anchors = COLUMN_KEYS.filter((c) => found[c.key] !== undefined)
        .map((c) => ({ key: c.key, x: found[c.key] }))
        .sort((a, b) => a.x - b.x)
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
    if (!rawText || isDivider(rawText)) continue // structural line, skip silently

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
      skipped.push({ row: i + 1, text: rawText, reason: `unreadable price "${rec.basePrice || ''}"` })
      continue
    }

    seq += 1
    items.push({
      itemId: `ITEM-${String(seq).padStart(2, '0')}`,
      product: rec.product,
      brand: rec.brand,
      platform: rec.platform,
      basePrice: Math.round(price),
    })
  }

  return { items, skipped, error: null }
}
