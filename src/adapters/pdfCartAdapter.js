/**
 * pdfCartAdapter.js  (INPUT ADAPTER — Task 3)
 *
 * Extracts a cart from a PDF, fully client-side (pdf.js in the browser). Token
 * extraction lives here; the table reconstruction lives in the pure, unit-tested
 * pdfTable.js. All extraction is wrapped so a mid-document failure surfaces a
 * clean error instead of escaping (which previously could hang the uploader).
 *
 * Returns { items, skipped, error }.
 */

import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { buildCartFromPages } from './pdfTable.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_PAGES = 20

export async function parsePdfCart(file) {
  if (file.size > MAX_BYTES) {
    return { items: [], skipped: [], error: `PDF is too large (max ${MAX_BYTES / 1024 / 1024} MB).` }
  }

  let pdf
  try {
    const data = new Uint8Array(await file.arrayBuffer())
    pdf = await pdfjsLib.getDocument({ data }).promise
  } catch {
    return { items: [], skipped: [], error: 'Could not open this PDF. Is the file valid?' }
  }

  if (pdf.numPages > MAX_PAGES) {
    return { items: [], skipped: [], error: `PDF has too many pages (max ${MAX_PAGES}).` }
  }

  // Wrap page reads too — getPage()/getTextContent() can throw and must not escape.
  let pages
  try {
    pages = []
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      pages.push(
        content.items
          .filter((it) => it.str && it.str.trim())
          .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      )
    }
  } catch {
    return { items: [], skipped: [], error: 'Failed while reading the PDF contents.' }
  }

  return buildCartFromPages(pages)
}
