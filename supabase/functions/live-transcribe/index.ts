// live-transcribe — the server STT engine (livebuild v2, cross-browser).
//
// The browser's Web Speech API is Chrome-only; this function is the SERVER
// engine that makes live transcription work on Chrome, Safari (desktop + iOS),
// Firefox, and Chromium-based browsers alike. The client captures audio with
// MediaRecorder (universal) and uploads sequential self-contained chunks; each
// chunk is transcribed here and ONLY the text returns.
//
// Provider: Deepgram batch (pre-recorded) transcription, nova-2.
//   POST https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&language=en
//   Authorization: Token <DEEPGRAM_API_KEY>   (server-side only, never shipped)
//
// Secret gating: when DEEPGRAM_API_KEY is absent the function reports
//   GET  → { available: false, reason: 'secret_pending' }
//   POST → 503 { error: 'server transcription unavailable', reason: 'secret_pending' }
// and the client transparently falls back to the Web Speech engine. The UI
// never knows which engine is running beyond an availability probe.
//
// No audio is stored: chunk bytes stay in memory for the life of the request
// and only the transcript text is returned. Nothing persists here; the
// caller (client) feeds final text segments to /live-facts.
//
//   GET  /live-transcribe                  → { available, reason? }
//   POST /live-transcribe                  → { text, index }
//        headers: x-cs-session, x-cs-index, Content-Type: <audio mime>
//        body: raw audio bytes (one self-contained chunk)

import { handleOptions, jsonResponse } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'

const MAX_CHUNK_BYTES = 25 * 1024 * 1024 // Deepgram limit headroom
const MAX_INDEX = 100000

function deepgramKey(): string | null {
  return Deno.env.get('DEEPGRAM_API_KEY') ?? null
}

async function transcribeChunk(audio: ArrayBuffer, mime: string): Promise<string | { error: string; status?: number }> {
  const key = deepgramKey()
  if (!key) return { error: 'server transcription unavailable', status: 503 }
  const params = new URLSearchParams({
    model: Deno.env.get('DEEPGRAM_MODEL') ?? 'nova-2',
    smart_format: 'true',
    punctuate: 'true',
    language: Deno.env.get('DEEPGRAM_LANGUAGE') ?? 'en',
  })
  let response: Response
  try {
    response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': mime.length > 0 ? mime : 'audio/webm',
      },
      body: audio,
    })
  } catch (error) {
    return { error: `Transcription transport failed: ${(error as Error).message}` }
  }
  const raw = await response.text()
  if (!response.ok) {
    return { error: `Deepgram returned ${response.status}: ${raw.slice(0, 300)}`, status: 502 }
  }
  try {
    const parsed = JSON.parse(raw) as {
      results?: {
        channels?: {
          alternatives?: { transcript?: string }[]
        }[]
      }
    }
    const transcript = parsed.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
    return transcript.trim()
  } catch {
    return { error: 'Deepgram response was not valid JSON', status: 502 }
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)

  const session = await readSession(request)
  if (!session) return jsonResponse(request, { error: 'Not authenticated' }, 401)
  if (session.app_role !== 'admin') return jsonResponse(request, { error: 'Admin session required' }, 403)

  try {
    // ---------------------------------------------------------------
    // GET — availability probe (no secret value ever leaves the server)
    // ---------------------------------------------------------------
    if (request.method === 'GET') {
      const available = deepgramKey() !== null
      return jsonResponse(request, {
        available,
        engine: available ? 'server' : 'browser',
        ...(available ? {} : { reason: 'secret_pending' }),
      })
    }

    if (request.method !== 'POST') {
      return jsonResponse(request, { error: 'Unsupported method' }, 405)
    }

    if (deepgramKey() === null) {
      return jsonResponse(request, { error: 'server transcription unavailable', reason: 'secret_pending' }, 503)
    }

    const sessionId = request.headers.get('x-cs-session')?.slice(0, 120) ?? ''
    if (sessionId.length === 0) {
      return jsonResponse(request, { error: 'x-cs-session header is required' }, 400)
    }
    const indexRaw = request.headers.get('x-cs-index') ?? '0'
    const index = Number.parseInt(indexRaw, 10)
    if (!Number.isFinite(index) || index < 0 || index > MAX_INDEX) {
      return jsonResponse(request, { error: 'x-cs-index header is invalid' }, 400)
    }

    const mime = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const audio = await request.arrayBuffer()
    if (audio.byteLength === 0) {
      return jsonResponse(request, { error: 'empty audio chunk' }, 400)
    }
    if (audio.byteLength > MAX_CHUNK_BYTES) {
      return jsonResponse(request, { error: 'audio chunk too large' }, 413)
    }

    const result = await transcribeChunk(audio, mime)
    if (typeof result !== 'string') {
      console.error(`[live-transcribe] chunk ${index} failed: ${result.error}`)
      return jsonResponse(request, { error: result.error, ...(result.status ? {} : {}) }, result.status ?? 502)
    }
    // Empty transcripts happen for silent chunks — a normal, successful no-op.
    return jsonResponse(request, { text: result, index })
  } catch (error) {
    console.error('[live-transcribe] error:', error instanceof Error ? error.message : error)
    return jsonResponse(request, { error: 'Internal error' }, 500)
  }
})
