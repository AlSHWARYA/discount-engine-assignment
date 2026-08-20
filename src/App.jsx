/**
 * App.jsx
 *
 * Top-level UI + state. Its job is wiring: each INPUT MODE (CSV, natural
 * language, PDF) produces the engine's canonical shapes (DiscountRule[],
 * CartItem[]), and the engine runs without knowing which input produced them.
 * Adding a fourth input mode would mean a new adapter + a new control here —
 * the engine and results rendering below stay untouched.
 */

import { useMemo, useState } from 'react'
import CsvUploader from './components/CsvUploader.jsx'
import PdfUploader from './components/PdfUploader.jsx'
import NlRuleInput from './components/NlRuleInput.jsx'
import DataTable from './components/DataTable.jsx'
import ErrorBanner from './components/ErrorBanner.jsx'
import { parseRulesCSV, parseCartCSV } from './engine/csvParser.js'
import { parsePdfCart } from './adapters/pdfCartAdapter.js'
import { processCart, summarizeCart } from './engine/discountEngine.js'

// ── Column definitions ───────────────────────────────────────────

const RULES_COLUMNS = [
  { key: 'ruleId', label: 'Rule ID' },
  { key: 'scope', label: 'Scope', render: (v) => v.charAt(0).toUpperCase() + v.slice(1) },
  { key: 'appliesTo', label: 'Applies To', render: (v, r) => (r.scope === 'cart' ? 'Entire cart' : v) },
  { key: 'type', label: 'Type', render: (v) => v.charAt(0).toUpperCase() + v.slice(1) },
  { key: 'value', label: 'Value', render: (v, row) => (row.type === 'percentage' ? `${v}% off` : `Rs.${v} off`) },
  { key: 'minCartValue', label: 'Min Cart', render: (v) => (v ? `Rs.${v.toLocaleString('en-IN')}` : '—') },
  { key: 'stackable', label: 'Stackable', render: (v, r) => (r.scope === 'cart' ? '—' : v ? 'Yes' : 'No') },
]

const CART_COLUMNS = [
  { key: 'itemId', label: 'Item' },
  { key: 'product', label: 'Product' },
  { key: 'brand', label: 'Brand' },
  { key: 'platform', label: 'Platform' },
  { key: 'basePrice', label: 'Base Price', render: (v) => `Rs.${v.toLocaleString('en-IN')}` },
]

const rupees = (v) => `Rs.${Math.round(v).toLocaleString('en-IN')}`

const RESULTS_COLUMNS = [
  { key: 'itemId', label: 'Item' },
  { key: 'product', label: 'Product' },
  { key: 'basePrice', label: 'Base Price', render: (v) => rupees(v) },
  {
    key: 'finalPrice', label: 'Final Price',
    render: (v, row) =>
      row.flagged ? <span style={{ color: '#888' }}>—</span> : (
        <span style={{ fontWeight: 700, color: row.totalDiscount > 0 ? '#1e5c2c' : '#131A48' }}>{rupees(v)}</span>
      ),
  },
  {
    key: 'totalDiscount', label: 'You Save',
    render: (v, row) =>
      !row.flagged && v > 0
        ? <span style={{ color: '#1e5c2c', fontWeight: 600 }}>{rupees(v)}</span>
        : <span style={{ color: '#888' }}>—</span>,
  },
  {
    key: 'reasoning', label: 'Offer Applied',
    render: (v) => {
      const muted = v === 'No offers available' || v.startsWith('Invalid')
      return <span style={{ color: muted ? '#888' : '#131A48', fontStyle: muted ? 'italic' : 'normal' }}>{v}</span>
    },
  },
]

// ── Styles ───────────────────────────────────────────────────────

const S = {
  page: { minHeight: '100vh', background: '#f7f7f9', fontFamily: 'Arial, sans-serif' },
  header: { background: '#131A48', padding: '0.85rem 2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  logoTxt: { fontFamily: 'Georgia, serif', fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' },
  logoSpan: { color: '#FF5800' },
  headerSub: { fontSize: 11, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.07em' },
  main: { maxWidth: 980, margin: '0 auto', padding: '1.8rem 1.5rem' },
  section: { background: '#fff', border: '1px solid #CECECE', borderRadius: 6, padding: '1.2rem 1.4rem', marginBottom: '1.2rem' },
  sectionTitle: { fontFamily: 'Georgia, serif', fontWeight: 700, fontSize: 14, color: '#131A48', marginBottom: '0.7rem', paddingBottom: 6, borderBottom: '2px solid #FF5800', display: 'inline-block' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' },
  btn: { background: '#FF5800', color: '#fff', border: 'none', borderRadius: 4, padding: '0.65rem 2rem', fontSize: 13, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase' },
  btnDisabled: { background: '#CECECE', color: '#fff', border: 'none', borderRadius: 4, padding: '0.65rem 2rem', fontSize: 13, fontWeight: 700, cursor: 'not-allowed', letterSpacing: '0.04em', textTransform: 'uppercase' },
  summaryRow: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '1rem', marginTop: '0.5rem', fontSize: 13 },
  offerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginTop: '0.6rem', padding: '0.5rem 0.8rem', background: '#f0faf2', border: '1px solid #bfe3c8', borderRadius: 4, fontSize: 13 },
  totalRow: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '1rem', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '2px solid #131A48' },
  totalLabel: { fontWeight: 700, fontSize: 14, color: '#131A48' },
  totalValue: { fontWeight: 700, fontSize: 16, color: '#131A48' },
}

// ── Component ────────────────────────────────────────────────────

export default function App() {
  const [rules, setRules] = useState([])
  const [rulesErrors, setRulesErr] = useState([])
  const [rulesFileName, setRulesFileName] = useState('')

  const [cartItems, setCartItems] = useState([])
  const [cartErrors, setCartErrors] = useState([])
  const [cartFileName, setCartFileName] = useState('')
  const [cartSource, setCartSource] = useState('')

  const [pdfSkipped, setPdfSkipped] = useState([])
  const [pdfError, setPdfError] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)

  const [customCount, setCustomCount] = useState(0)
  const [showResults, setShowResults] = useState(false)

  // The engine re-runs automatically whenever rules or cart change (once shown).
  const summary = useMemo(
    () => (showResults && cartItems.length > 0 ? summarizeCart(processCart(cartItems, rules), rules) : null),
    [showResults, cartItems, rules]
  )

  // ── Handlers ──

  function handleRulesLoad(csvText, fileName) {
    const { data, errors } = parseRulesCSV(csvText)
    setRules(data)
    setRulesErr(errors)
    setRulesFileName(fileName)
  }

  function handleCartCsvLoad(csvText, fileName) {
    const { data, errors } = parseCartCSV(csvText)
    setCartItems(data)
    setCartErrors(errors)
    setCartFileName(fileName)
    setCartSource('csv')
    setPdfSkipped([])
    setPdfError('')
  }

  async function handleCartPdfLoad(file) {
    setPdfBusy(true)
    setPdfError('')
    setCartErrors([])
    const { items, skipped, error } = await parsePdfCart(file)
    setPdfBusy(false)
    if (error) {
      setPdfError(error)
      return
    }
    setCartItems(items)          // PDF replaces the current cart
    setPdfSkipped(skipped)
    setCartFileName(file.name)
    setCartSource('pdf')
    if (items.length > 0) setShowResults(true) // re-run automatically
  }

  function handleAddCustomRule(rule) {
    const n = customCount + 1
    setCustomCount(n)
    setRules((prev) => [...prev, { ...rule, ruleId: `RULE-CUSTOM-${n}` }])
    if (cartItems.length > 0) setShowResults(true) // re-run automatically with the new rule
  }

  const canCalculate = cartItems.length > 0
  const results = summary?.items ?? []

  // ── Render ──

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div style={S.logoTxt}>O<span style={S.logoSpan}>pp</span>tra</div>
        <div style={S.headerSub}>Discount Engine</div>
      </div>

      <div style={S.main}>
        {/* Upload row */}
        <div style={S.grid2}>
          {/* Rules */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Discount Rules</div>
            <CsvUploader label="rules.csv" description="Upload your discount rules CSV" onLoad={handleRulesLoad} hasData={rules.length > 0} fileName={rulesFileName} />
            <ErrorBanner errors={rulesErrors} />
            {rules.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{rules.length} rule{rules.length > 1 ? 's' : ''} active</div>
                <DataTable columns={RULES_COLUMNS} rows={rules} />
              </div>
            )}
          </div>

          {/* Cart — CSV or PDF */}
          <div style={S.section}>
            <div style={S.sectionTitle}>Cart Items</div>
            <CsvUploader label="cart.csv" description="Upload your cart CSV" onLoad={handleCartCsvLoad} hasData={cartItems.length > 0 && cartSource === 'csv'} fileName={cartSource === 'csv' ? cartFileName : ''} />
            <PdfUploader onLoad={handleCartPdfLoad} busy={pdfBusy} />
            <ErrorBanner errors={cartErrors} />
            {pdfError && <ErrorBanner errors={[pdfError]} />}
            {pdfSkipped.length > 0 && (
              <div style={{ marginTop: 8, background: '#fff8e6', border: '1px solid #f0c36d', borderRadius: 4, padding: '0.6rem 0.8rem', fontSize: 12, color: '#7a5a00' }}>
                <strong>{pdfSkipped.length} PDF row{pdfSkipped.length > 1 ? 's' : ''} skipped</strong> (loaded the rest):
                {pdfSkipped.map((s, i) => (
                  <div key={i} style={{ marginTop: 2 }}>• row {s.row}: {s.reason} — <span style={{ color: '#a08050' }}>{s.text}</span></div>
                ))}
              </div>
            )}
            {cartItems.length > 0 && (
              <div style={{ marginTop: '0.75rem' }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                  {cartItems.length} item{cartItems.length > 1 ? 's' : ''} loaded{cartSource === 'pdf' ? ' from PDF' : ''}
                </div>
                <DataTable columns={CART_COLUMNS} rows={cartItems} />
              </div>
            )}
          </div>
        </div>

        {/* Natural-language rule */}
        <div style={S.section}>
          <div style={S.sectionTitle}>Add a Rule in Plain English</div>
          <NlRuleInput onAddRule={handleAddCustomRule} cartItems={cartItems} />
        </div>

        {/* Calculate */}
        <div style={{ textAlign: 'center', marginBottom: '1.2rem' }}>
          <button style={canCalculate ? S.btn : S.btnDisabled} onClick={() => setShowResults(true)} disabled={!canCalculate}>
            Calculate Discounts
          </button>
          {!canCalculate && <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>Load a cart (CSV or PDF) to calculate</div>}
        </div>

        {/* Results */}
        {summary && (
          <div style={S.section}>
            <div style={S.sectionTitle}>Cart Summary</div>
            <DataTable columns={RESULTS_COLUMNS} rows={results} />

            <div style={S.summaryRow}>
              <span style={{ color: '#555' }}>Cart total before offer</span>
              <span style={{ fontWeight: 700, color: '#131A48' }}>{rupees(summary.subtotal)}</span>
            </div>

            {summary.cartOffer && (
              <div style={S.offerRow}>
                <span style={{ fontWeight: 600, color: '#1e5c2c' }}>
                  {summary.cartOffer.label} — Rs.{summary.cartOffer.savedRupees.toLocaleString('en-IN')} saved
                  <span style={{ color: '#888', fontWeight: 400 }}> ({summary.cartOffer.ruleId})</span>
                </span>
                <span style={{ fontWeight: 700, color: '#1e5c2c' }}>−{rupees(summary.cartOffer.savedRupees)}</span>
              </div>
            )}

            <div style={S.totalRow}>
              <span style={S.totalLabel}>Final Cart Total</span>
              <span style={S.totalValue}>{rupees(summary.finalTotal)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
