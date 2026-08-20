/**
 * PdfUploader.jsx  (Task 3 UI)
 *
 * A compact upload control for a cart PDF. Passes the File object up via
 * onLoad(file); parsing happens in the adapter, not here.
 */

import { useRef } from 'react'

export default function PdfUploader({ onLoad, busy }) {
  const inputRef = useRef(null)

  function handleFile(e) {
    const file = e.target.files[0]
    if (file) onLoad(file)
    e.target.value = '' // allow re-uploading the same file
  }

  return (
    <div
      style={{
        border: '2px dashed #CECECE', borderRadius: 6, padding: '0.7rem 1rem',
        background: '#fafafa', cursor: busy ? 'wait' : 'pointer', marginTop: 8,
      }}
      onClick={() => !busy && inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} onChange={handleFile} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span style={{ fontSize: 18 }}>📑</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#131A48' }}>Upload cart PDF</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
            {busy ? 'Reading PDF…' : 'Replaces the current cart and re-runs the engine'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#FF5800', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {busy ? '…' : 'PDF'}
        </div>
      </div>
    </div>
  )
}
