/**
 * _groq.js  (underscore ⇒ not a Vercel route; shared by the serverless function
 * and the Vite dev middleware so local and prod behave identically)
 *
 * Calls Groq to turn a plain-English rule description into structured JSON.
 * It ONLY does extraction — it never trusts the model's output as final. The
 * client re-validates the returned rule through the same `validateRule`
 * boundary the CSV path uses. This module's job is: get JSON back, or fail
 * cleanly.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'openai/gpt-oss-120b'

const SYSTEM_PROMPT = `You convert a shopper-facing discount rule written in plain English into structured JSON.

Return ONLY a JSON object of this exact shape:
{
  "resolvable": boolean,
  "reason": string,            // when resolvable is false, explain what is missing
  "rules": [                    // one object per distinct rule found in the text
    {
      "scope": "platform" | "brand" | "cart",
      "appliesTo": string | null,   // brand or platform name; null for cart scope
      "type": "percentage" | "flat",
      "value": number,              // percentage as an integer (20 means 20%), flat in rupees
      "stackable": boolean,         // true only if the text says it stacks/combines with other offers
      "minCartValue": number | null // rupee threshold for cart scope; null otherwise
    }
  ]
}

Rules for interpretation:
- "brand" scope when it targets a brand name; "platform" scope for a marketplace (Amazon India, Flipkart, Noon); "cart" scope when it depends on total cart/order value.
- A cart rule MUST have a numeric minCartValue. Phrases like "more than Rs.5,000" or "over 5000" set minCartValue to that number.
- percentage value is 0-100. Strip the "%" and any "Rs."/currency symbols and commas from numbers.
- Set stackable true ONLY if the text explicitly says it stacks/combines/applies on top of other offers. Otherwise false.
- If the text has NO usable value or NO threshold where one is required (e.g. "give a discount for big orders"), set resolvable to false and explain in reason. Do not invent numbers.
- If the text describes more than one rule, return all of them in the array.

Examples:
"20% off for Natura Casa brand, stackable with other offers" -> {"resolvable":true,"reason":"","rules":[{"scope":"brand","appliesTo":"Natura Casa","type":"percentage","value":20,"stackable":true,"minCartValue":null}]}
"Rs.100 flat discount on all Flipkart items" -> {"resolvable":true,"reason":"","rules":[{"scope":"platform","appliesTo":"Flipkart","type":"flat","value":100,"stackable":false,"minCartValue":null}]}
"10% off if cart value is more than Rs.5,000" -> {"resolvable":true,"reason":"","rules":[{"scope":"cart","appliesTo":null,"type":"percentage","value":10,"stackable":false,"minCartValue":5000}]}
"Give a discount for big orders" -> {"resolvable":false,"reason":"No discount value or cart threshold was given. Specify an amount (e.g. 10% off) and a condition.","rules":[]}`

/**
 * @param {string} text  the user's plain-English rule
 * @returns {Promise<{resolvable:boolean, reason:string, rules:object[]}>}
 * @throws  {Error} with .status for config/network/model failures
 */
export async function parseRule(text) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    const e = new Error('LLM is not configured (missing GROQ_API_KEY on the server).')
    e.status = 500
    throw e
  }
  if (!text || !String(text).trim()) {
    const e = new Error('No rule text provided.')
    e.status = 400
    throw e
  }

  let resp
  try {
    resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: String(text).trim() },
        ],
      }),
    })
  } catch (networkErr) {
    const e = new Error('Could not reach the language model. Check your connection and try again.')
    e.status = 502
    throw e
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    const e = new Error(`Language model request failed (${resp.status}). ${body.slice(0, 200)}`)
    e.status = 502
    throw e
  }

  const data = await resp.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    const e = new Error('The language model returned an empty response.')
    e.status = 502
    throw e
  }

  // Defensive parse: strip markdown fences if the model added them.
  const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    const e = new Error('The language model did not return valid JSON. Try rephrasing the rule.')
    e.status = 502
    throw e
  }

  return {
    resolvable: parsed.resolvable !== false,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
  }
}
