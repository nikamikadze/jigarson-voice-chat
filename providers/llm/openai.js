import fetch from 'node-fetch'
import { buildSystemPrompt } from '../../llm/prompt.js'

const sessions = new Map()
const MODEL = process.env.OPENAI_LLM_MODEL || 'gpt-4.1'
const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
const TRANSCRIPT_CORRECTION_MODEL =
  process.env.OPENAI_TRANSCRIPT_CORRECTION_MODEL || MODEL

function supportsReasoningEffort(model) {
  return /^gpt-5/i.test(model)
}

export function clearSession(id = 'default') {
  sessions.delete(id)
}

export function rememberTurn(id = 'default', userText, assistantText) {
  const history = sessions.get(id) || []
  history.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  )
  sessions.set(id, history.slice(-20))
}

export async function correctTranscript(rawText, { signal } = {}) {
  const text = String(rawText || '').trim()
  if (!text || process.env.OPENAI_TRANSCRIPT_CORRECTION !== 'true') return text
  if (!process.env.OPENAI_API_KEY)
    throw new Error('Missing env: OPENAI_API_KEY')

  const body = {
    model: TRANSCRIPT_CORRECTION_MODEL,
    messages: [
      {
        role: 'developer',
        content: [
          'You clean up Georgian speech-to-text transcripts for a voice assistant.',
          'Return only the corrected transcript, in Georgian script.',
          'Do not answer the user. Do not add information.',
          'Preserve names and intent. Fix obvious ASR mistakes, punctuation, and word spacing.',
          'If the transcript is too ambiguous, return the original text unchanged.',
        ].join(' '),
      },
      { role: 'user', content: text },
    ],
    max_completion_tokens: Number(
      process.env.OPENAI_TRANSCRIPT_CORRECTION_MAX_TOKENS || 90,
    ),
  }
  if (supportsReasoningEffort(TRANSCRIPT_CORRECTION_MODEL)) {
    body.reasoning_effort =
      process.env.OPENAI_TRANSCRIPT_CORRECTION_REASONING_EFFORT || 'minimal'
  }
  if (process.env.OPENAI_TRANSCRIPT_CORRECTION_TEMPERATURE) {
    body.temperature = Number(
      process.env.OPENAI_TRANSCRIPT_CORRECTION_TEMPERATURE,
    )
  }

  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(payload.error?.message || 'Transcript correction failed')
  return (payload.choices?.[0]?.message?.content || text).trim() || text
}

export async function* streamChat({
  sessionId = 'default',
  userText,
  signal,
  onFirstToken,
}) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('Missing env: OPENAI_API_KEY')
  const messages = [
    { role: 'developer', content: await buildSystemPrompt(userText) },
    ...(sessions.get(sessionId) || []),
    { role: 'user', content: userText },
  ]
  const body = {
    model: MODEL,
    messages,
    max_completion_tokens: Number(process.env.OPENAI_LLM_MAX_TOKENS || 180),
    stream: true,
  }
  if (supportsReasoningEffort(MODEL)) {
    body.reasoning_effort = process.env.OPENAI_LLM_REASONING_EFFORT || 'minimal'
  }
  if (process.env.OPENAI_LLM_TEMPERATURE)
    body.temperature = Number(process.env.OPENAI_LLM_TEMPERATURE)
  console.log('[GPT REQUEST START]', {
    url: CHAT_COMPLETIONS_URL,
    model: MODEL,
    sessionId,
    userTextType: typeof userText,
    userText,
  })
  console.log('[GPT REQUEST BODY]', JSON.stringify(body, null, 2))
  const startedAt = performance.now()
  let res
  try {
    res = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('[GPT ERROR]', err)
    throw err
  }

  if (!res.ok) {
    const errorText = await res.text()
    console.error('[GPT ERROR]', errorText)
    throw new Error(errorText)
  }

  let first = true
  let tokenCount = 0
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        if (!tokenCount) {
          const message = 'GPT stream ended before any content token'
          console.error('[GPT ERROR]', message)
          throw new Error(message)
        }
        return
      }
      try {
        const data = JSON.parse(payload)
        const token = data.choices?.[0]?.delta?.content || ''
        if (!token) continue
        tokenCount += 1
        if (first) {
          first = false
          const latencyMs = performance.now() - startedAt
          console.log('[GPT FIRST TOKEN]', {
            latencyMs: Math.round(latencyMs),
            token,
          })
          onFirstToken?.(latencyMs)
        }
        yield token
      } catch {
        // Ignore partial SSE frames until a full event arrives.
      }
    }
  }
  if (!tokenCount) {
    const message = 'GPT stream ended before any content token'
    console.error('[GPT ERROR]', message)
    throw new Error(message)
  }
}
