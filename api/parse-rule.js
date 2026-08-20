/**
 * api/parse-rule.js — Vercel serverless function.
 *
 * The ONLY server-side piece of the app. It exists solely to keep the Groq API
 * key off the client (a static bundle would expose it). It takes { text },
 * asks Groq to structure it, and returns the parsed JSON. All discount
 * validation still happens client-side through the shared boundary.
 */

import { parseRule } from './_groq.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    // Vercel parses JSON bodies automatically; guard for the raw-string case.
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
    const result = await parseRule(body.text)
    res.status(200).json(result)
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Unexpected server error' })
  }
}
