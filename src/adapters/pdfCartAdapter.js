/**
 * pdfCartAdapter.js  (INPUT ADAPTER — Task 3)
 *
 * Extracts a cart from a PDF, fully client-side (pdf.js in the browser — the
 * file never leaves the machine). Produces the SAME CartItem[] the CSV path
 * does, so the engine is untouched. Token extraction lives here; the table
 * reconstruction (column clustering, row validation) lives in the pure,
 * unit-tested pdfTable.js.
 *
 * Returns { items, skipped, error }.
 */

import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { buildCartFromPages } from './pdfTable.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

export async function parsePdfCart(file) {
  let pdf
  try {
    const data = new Uint8Array(await file.arrayBuffer())
    pdf = await pdfjsLib.getDocument({ data }).promise
  } catch {
    return { items: [], skipped: [], error: 'Could not open this PDF. Is the file valid?' }
  }

  const pages = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const tokens = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
    pages.push(tokens)
  }

  return buildCartFromPages(pages)
}
