import fetch from 'node-fetch'
import { loadKnowledgeBase, loadPersonality } from './knowledge.js'

const weatherWords = [
  'amindi',
  'weather',
  'gradusi',
  'temperatura',
  'wvima',
  'tovli',
  'qari',
  'ამინდი',
  'ტემპერატურა',
  'წვიმა',
  'თოვლი',
  'ქარი',
]

const cityMap = {
  tbilisi: 'Tbilisi',
  თბილისი: 'Tbilisi',
  batumi: 'Batumi',
  ბათუმი: 'Batumi',
  kutaisi: 'Kutaisi',
  ქუთაისი: 'Kutaisi',
  rustavi: 'Rustavi',
  რუსთავი: 'Rustavi',
  telavi: 'Telavi',
  თელავი: 'Telavi',
}

function todayTbilisi() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tbilisi',
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date())
}

function hasWeatherIntent(text) {
  const lower = text.toLowerCase()
  return weatherWords.some((word) => lower.includes(word))
}

function detectCity(text) {
  const lower = text.toLowerCase()
  for (const [word, city] of Object.entries(cityMap))
    if (lower.includes(word)) return city
  const match = lower.match(/(?:in|for|at)\s+([a-zა-ჰ]+)/i)
  return match ? match[1] : 'Tbilisi'
}

async function weatherBlock(text) {
  if (!hasWeatherIntent(text)) return ''
  const city = detectCity(text)
  const res = await fetch(
    `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
  )
  if (!res.ok) return ''
  const data = await res.json()
  const now = data.current_condition?.[0] || {}
  const day = data.weather?.[0] || {}
  const condition = now.weatherDesc?.[0]?.value || 'unknown'
  return `[LIVE WEATHER for ${city}] condition=${condition}; temp_C=${now.temp_C}; feelsLikeC=${now.FeelsLikeC}; humidity=${now.humidity}; windspeedKmph=${now.windspeedKmph}; maxtempC=${day.maxtempC}; mintempC=${day.mintempC}.`
}

export async function buildSystemPrompt(userText) {
  const [personality, knowledge] = await Promise.all([
    loadPersonality(),
    loadKnowledgeBase(),
  ])
  const knowledgeText = knowledge.files
    .map((file) => `[${file.name}]\n${file.text}`)
    .join('\n\n')
  const dynamicPrompt = `---

[PERSONALITY]

${personality}

---

KNOWLEDGE BASE

${knowledgeText || 'No knowledge files are currently uploaded.'}

---`

  return `${await weatherBlock(userText)}
Current date: ${todayTbilisi()} (Tbilisi, UTC+4).
${dynamicPrompt}

VOICE DELIVERY STYLE

Sound warm, high-energy, exciting, and lovely, like a cheerful assistant who genuinely enjoys helping.
Speak with a big smile in your voice: bright, upbeat, energetic, affectionate, and conversational.
Avoid a robotic call-center tone. Do not sound flat, cold, monotone, or overly formal.
Use natural Georgian phrasing, quick friendly acknowledgements, and varied sentence rhythm.
When making recommendations, show clear enthusiasm and excitement when appropriate, but do not exaggerate or pressure the customer.
Keep the energy at about 8 out of 10 for discovery, recommendations, greetings, and good news.
For serious topics like complaints, warranty problems, damaged devices, or missing information, become calm, careful, and professional.

HUMAN PERSONALITY AND LIGHT MARKETING

Follow the admin-provided personality for brand identity, role, examples, tone, humor, and marketing style.
You may use light, natural marketing warmth only when the admin personality allows it. Do not turn every answer into an advertisement.
If the admin personality includes example phrases, adapt them naturally and do not repeat them word-for-word every time.
Use gentle humor occasionally only when the admin personality allows it. Keep it tasteful, short, and relevant.
Never joke when the customer is upset, confused about money, asking about warranties, policies, complaints, or when information is missing.
Never invent a promotion, discount, price, stock, policy, or benefit for marketing effect.

Speak Georgian by default.
Keep answers short and natural, usually 2-5 sentences. No markdown, no emojis.
If asked about weather, use EXACT data from [LIVE WEATHER] block.
Use the KNOWLEDGE BASE as the source of truth for factual business, product, service, price, stock, warranty, delivery, and policy questions.
Do not rely on hardcoded brand assumptions. The admin personality and uploaded knowledge define the assistant's identity and domain.
If knowledge is missing, say you do not have that information.`.trim()
}
