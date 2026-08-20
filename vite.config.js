import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Dev-only middleware that mirrors the Vercel serverless function at
 * /api/parse-rule, so `npm run dev` and the deployed app behave identically.
 * In production, Vercel serves api/parse-rule.js instead; this plugin does
 * nothing there. The Groq key is read from the environment on the server side
 * only and is never exposed to the client bundle.
 */
function groqDevApi(env) {
  return {
    name: 'groq-dev-api',
    configureServer(server) {
      process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || env.GROQ_API_KEY
      server.middlewares.use('/api/parse-rule', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }
        try {
          const { parseRule } = await import('./api/_groq.js')
          let body = ''
          for await (const chunk of req) body += chunk
          const { text } = JSON.parse(body || '{}')
          const result = await parseRule(text)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(result))
        } catch (err) {
          res.statusCode = err.status || 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: err.message || 'Unexpected server error' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), groqDevApi(env)],
  }
})
