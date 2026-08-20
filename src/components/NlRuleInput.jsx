/**
 * NlRuleInput.jsx  (Task 2 UI)
 *
 * Plain-English rule field → LLM parse → confirmation card → confirm/discard.
 * Knows nothing about the engine; it just hands a validated DiscountRule up via
 * onAddRule. A request token guards against stale async responses (rapid
 * re-parses render only the latest result).
 */

import { useRef, useState } from 'react'
import { parseNaturalLanguageRule } from '../adapters/nlRuleAdapter.js'

const box = {
  border: '1px solid #CECECE', borderRadius: 6, padding: '0.9rem 1rem', background: '#fafafa',
}
const field = {
  width: '100%', boxSizing: 'border-box', padding: '0.55rem 0.7rem', fontSize: 13,
  border: '1px solid #CECECE', borderRadius: 4, fontFamily: 'inherit', resize: 'vertical',
}
const btn = (disabled) => ({
  background: disabled ? '#CECECE' : '#FF5800', color: '#fff', border: 'none', borderRadius: 4,
  padding: '0.5rem 1.2rem', fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
  letterSpacing: '0.04em', textTransform: 'uppercase',
})
const ghostBtn = {
  background: '#fff', color: '#131A48', border: '1px solid #CECECE', borderRadius: 4,
  padding: '0.5rem 1.2rem', fontSize: 12, fontWeight: 700, cursor: 'pointer',
  letterSpacing: '0.04em', textTransform: 'uppercase',
}

function Field({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: '#888', minWidth: 96 }}>{label}</span>
      <span style={{ fontWeight: 600, color: '#131A48' }}>{value}</span>
    </div>
  )
}

export default function NlRuleInput({ onAddRule, cartItems }) {
  const [text, setText] = useState('')
  const [status, setStatus] = useState('idle') // idle | parsing | confirm | unresolvable | error
  const [parsed, setParsed] = useState(null)
  const [extraCount, setExtraCount] = useState(0)
  const [message, setMessage] = useState('')
  const reqToken = useRef(0)

  async function handleParse() {
    const token = ++reqToken.current
    setStatus('parsing')
    setMessage('')
    const result = await parseNaturalLanguageRule(text)
    if (token !== reqToken.current) return // a newer request superseded this one

    if (result.status === 'ok') {
      setParsed(result.rule)
      setExtraCount(result.extraCount)
      setStatus('confirm')
    } else if (result.status === 'unresolvable') {
      setMessage(result.reason)
      setStatus('unresolvable')
    } else {
      setMessage(result.reason)
      setStatus('error')
    }
  }

  function handleConfirm() {
    onAddRule(parsed)
    setText('')
    setParsed(null)
    setExtraCount(0)
    setStatus('idle')
  }

  function handleDiscard() {
    setParsed(null)
    setExtraCount(0)
    setStatus('idle')
  }

  // Editing the text after a parse invalidates the old result — never let a
  // confirmation card linger for text the user has since changed.
  function handleTextChange(e) {
    setText(e.target.value)
    if (status !== 'idle' && status !== 'parsing') {
      setParsed(null)
      setExtraCount(0)
      setMessage('')
      setStatus('idle')
    }
  }

  // Transparency note: does anything currently in the cart match this rule?
  const matchesCart =
    parsed &&
    parsed.scope !== 'cart' &&
    cartItems.some((it) => {
      const target = parsed.scope === 'brand' ? it.brand : it.platform
      return (target || '').trim().toLowerCase() === parsed.appliesTo.trim().toLowerCase()
    })

  const valueLabel = parsed
    ? parsed.type === 'percentage' ? `${parsed.value}% off` : `Rs.${parsed.value} off`
    : ''

  return (
    <div style={box}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
        Describe a rule in plain English — an LLM parses it, you confirm before it's added.
      </div>
      <textarea
        style={field}
        rows={2}
        placeholder='e.g. "20% off for Natura Casa brand, stackable with other offers"'
        value={text}
        onChange={handleTextChange}
        disabled={status === 'parsing'}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button style={btn(status === 'parsing' || !text.trim())} onClick={handleParse} disabled={status === 'parsing' || !text.trim()}>
          {status === 'parsing' ? 'Parsing…' : 'Parse Rule'}
        </button>
      </div>

      {status === 'unresolvable' && (
        <div style={{ marginTop: 10, background: '#fff8e6', border: '1px solid #f0c36d', borderRadius: 4, padding: '0.6rem 0.8rem', fontSize: 12, color: '#7a5a00' }}>
          <strong>Couldn't resolve that rule.</strong> {message}
        </div>
      )}

      {status === 'error' && (
        <div style={{ marginTop: 10, background: '#fce8e8', border: '1px solid #e57373', borderRadius: 4, padding: '0.6rem 0.8rem', fontSize: 12, color: '#5a1010' }}>
          {message}
        </div>
      )}

      {status === 'confirm' && parsed && (
        <div style={{ marginTop: 10, background: '#fff', border: '1px solid #131A48', borderRadius: 4, padding: '0.8rem 1rem' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#131A48', marginBottom: 6 }}>Confirm parsed rule</div>
          <Field label="Scope" value={parsed.scope.charAt(0).toUpperCase() + parsed.scope.slice(1)} />
          {parsed.scope !== 'cart' && <Field label="Applies to" value={parsed.appliesTo} />}
          <Field label="Type" value={parsed.type.charAt(0).toUpperCase() + parsed.type.slice(1)} />
          <Field label="Value" value={valueLabel} />
          {parsed.scope === 'cart' && <Field label="Min cart value" value={`Rs.${parsed.minCartValue.toLocaleString('en-IN')}`} />}
          {parsed.scope !== 'cart' && <Field label="Stackable" value={parsed.stackable ? 'Yes' : 'No'} />}

          {extraCount > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#7a5a00', background: '#fff8e6', border: '1px solid #f0c36d', borderRadius: 4, padding: '6px 8px' }}>
              Your input looked like {extraCount + 1} rules — only the first was parsed. Confirm this one, then add the rest separately.
            </div>
          )}
          {parsed.scope !== 'cart' && !matchesCart && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#555', background: '#f2f2f7', borderRadius: 4, padding: '6px 8px' }}>
              Note: no current cart item matches "{parsed.appliesTo}". The rule is valid — it'll apply if a matching item is added.
            </div>
          )}

          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button style={btn(false)} onClick={handleConfirm}>Add Rule</button>
            <button style={ghostBtn} onClick={handleDiscard}>Discard</button>
          </div>
        </div>
      )}
    </div>
  )
}
