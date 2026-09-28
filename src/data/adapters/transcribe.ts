// STT adapter (browser-side). Two engines behind ONE small interface
// (start/stop/onSegment — decision recorded in AGENTS.md), so the UI never
// knows which is running:
//
//   server  — MediaRecorder capture (all browsers, all mobiles) → sequential
//             self-contained chunks → /live-transcribe (Deepgram batch,
//             server-side key). Default when the DEEPGRAM_API_KEY secret is
//             provisioned; the availability probe decides.
//   browser — the Web Speech API (webkitSpeechRecognition), Chrome-only.
//             Fallback when the server engine is unavailable.
//
// No audio is ever STORED: chunks are transient, only final text segments
// are durable (the caller feeds them to /live-facts). Interim results feed
// live captions only.

import { callFunction, postBinary } from '@/data/api'

export interface TranscriptSegment {
  /** Monotonic segment counter for this call, assigned by the engine. */
  index: number
  text: string
  /** Wall-clock ISO timestamp. */
  at: string
  /** false while the utterance is still being spoken (live captions only). */
  final: boolean
}

export interface TranscriptionEngine {
  start(): void
  stop(): void
}

export interface TranscriptionHandlers {
  onSegment(segment: TranscriptSegment): void
  /** `fatal` errors end the session (permission denied, engine dead);
   *  `transient` ones surface as a notice and the session continues. */
  onError(message: string, kind?: 'fatal' | 'transient'): void
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: { transcript: string }
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [index: number]: SpeechRecognitionResultLike }
}

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** True when this browser exposes the Web Speech recognition engine. */
export function speechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  )
}

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/**
 * Build the Web Speech engine (the browser fallback). Callers must check
 * speechSupported() first.
 */
export function createWebSpeechEngine(handlers: TranscriptionHandlers): TranscriptionEngine {
  const Ctor = recognitionCtor()
  if (Ctor === null) {
    // Defensive: UI gates on speechSupported(), but never throw here.
    return { start: () => handlers.onError('Live transcription needs Chrome.'), stop: () => {} }
  }
  const Recognition = Ctor

  let active = false
  let index = 0
  let recognition: SpeechRecognitionLike | null = null
  // Interim text per recognition result slot, so repeated onresult events for
  // the same utterance update the same interim segment.
  const interim = new Map<number, string>()

  function spawn(): SpeechRecognitionLike {
    const instance = new Recognition()
    instance.continuous = true
    instance.interimResults = true
    instance.lang = 'en-SG'
    instance.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result === undefined) continue
        const text = Array.from({ length: result.length }, (_, j) => result[j]?.transcript ?? '')
          .join('')
          .trim()
        if (text.length === 0) continue
        if (result.isFinal) {
          interim.delete(i)
          handlers.onSegment({ index: index++, text, at: new Date().toISOString(), final: true })
        } else {
          interim.set(i, text)
          handlers.onSegment({ index, text, at: new Date().toISOString(), final: false })
        }
      }
    }
    instance.onerror = (event) => {
      // 'no-speech' and 'aborted' are routine in a continuous session.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        handlers.onError(
          event.error === 'not-allowed'
            ? 'Microphone permission was denied.'
            : `Transcription error: ${event.error ?? 'unknown'}`,
        )
      }
    }
    // Chrome stops the recognizer periodically; restart while the call is
    // still active so a long discovery call never silently goes deaf.
    instance.onend = () => {
      if (active) {
        try {
          instance.start()
        } catch {
          // start() throws if the instance is somehow already running.
        }
      }
    }
    return instance
  }

  return {
    start() {
      if (active) return
      active = true
      index = 0
      interim.clear()
      recognition = spawn()
      try {
        recognition.start()
      } catch {
        active = false
        handlers.onError('Could not start transcription. Try again.')
      }
    },
    stop() {
      active = false
      recognition?.stop()
      recognition = null
    },
  }
}

// ---------------------------------------------------------------------------
// Server engine — MediaRecorder → chunked upload → Deepgram (server-side key)
// ---------------------------------------------------------------------------

/** True when this browser can capture audio for the server engine. */
export function recordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

let serverProbeCache: { at: number; available: boolean } | null = null

/** Probe /live-transcribe availability (cached 30s). No secret value ever
 *  reaches the browser — only a boolean. */
export async function serverTranscriptionAvailable(): Promise<boolean> {
  if (serverProbeCache !== null && Date.now() - serverProbeCache.at < 30_000) {
    return serverProbeCache.available
  }
  try {
    const response = await callFunction<{ available?: boolean }>('/live-transcribe')
    const available = response.status < 400 && response.data.available === true
    serverProbeCache = { at: Date.now(), available }
    return available
  } catch {
    serverProbeCache = { at: Date.now(), available: false }
    return false
  }
}

export type EngineChoice = 'server' | 'browser'

/** Pick the engine: server (all browsers) when available, Web Speech
 *  fallback, null when neither works. */
export async function chooseEngine(): Promise<EngineChoice | null> {
  if (recordingSupported() && (await serverTranscriptionAvailable())) return 'server'
  if (speechSupported()) return 'browser'
  return null
}

interface ServerEngineOptions {
  /** Transcript-call identifier (rides the upload header for tracing). */
  sessionId: string
  /** Chunk length in ms — self-contained recordings, each fully decodable. */
  chunkMs?: number
}

const CHUNK_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const candidate of CHUNK_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

/**
 * Build the server engine. Records in self-contained chunks (a fresh
 * MediaRecorder per chunk, so every blob is fully decodable — Deepgram
 * pre-recorded cannot decode bare MediaRecorder timeslice continuations),
 * uploads them sequentially in order, and emits one FINAL segment per chunk.
 * The engine choice is transparent to the UI: identical TranscriptionEngine
 * interface as the Web Speech engine.
 */
export function createServerEngine(
  options: ServerEngineOptions,
  handlers: TranscriptionHandlers,
): TranscriptionEngine {
  const chunkMs = options.chunkMs ?? 8000
  const mimeType = pickMimeType()

  let active = false
  let index = 0
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let rotateTimer: number | null = null
  let uploadChain: Promise<void> = Promise.resolve()

  const uploadChunk = (blob: Blob, chunkIndex: number) => {
    uploadChain = uploadChain
      .then(async () => {
        if (!active && chunkIndex === 0) return
        try {
          const data = await postBinary<{ text?: string; index?: number }>(
            '/live-transcribe',
            blob,
            {
              'Content-Type': mimeType || 'audio/webm',
              'x-cs-session': options.sessionId,
              'x-cs-index': String(chunkIndex),
            },
          )
          const text = (data.text ?? '').trim()
          if (text.length > 0) {
            handlers.onSegment({ index: chunkIndex, text, at: new Date().toISOString(), final: true })
          }
        } catch (error) {
          const status = (error as { status?: number }).status
          if (status === 503) {
            handlers.onError('Server transcription is not available right now.', 'fatal')
          } else if (status === undefined || status >= 500) {
            // Transient transport/upstream failure: drop the chunk, keep going.
            handlers.onError('A moment of audio was lost — continuing.', 'transient')
          } else if (status !== 400) {
            handlers.onError('Transcription error — continuing.', 'transient')
          }
        }
      })
      .catch(() => {
        // The chain must never die.
      })
  }

  const spin = () => {
    if (!active || stream === null) return
    try {
      const next = mimeType.length > 0 ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      next.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) uploadChunk(event.data, index++)
      }
      next.onstop = () => {
        if (active) spin()
      }
      next.start() // no timeslice: stop() flushes one complete, decodable blob
      recorder = next
      rotateTimer = window.setTimeout(() => {
        if (recorder === next && next.state === 'recording') next.stop()
      }, chunkMs)
    } catch (error) {
      handlers.onError(`Could not start audio capture: ${(error as Error).message}`, 'fatal')
    }
  }

  return {
    start() {
      if (active) return
      active = true
      index = 0
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then((mediaStream) => {
          if (!active) {
            mediaStream.getTracks().forEach((track) => track.stop())
            return
          }
          stream = mediaStream
          spin()
        })
        .catch((error: DOMException) => {
          active = false
          handlers.onError(
            error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
              ? 'Microphone permission was denied.'
              : `Could not access the microphone: ${error?.message ?? 'unknown'}`,
            'fatal',
          )
        })
    },
    stop() {
      active = false
      if (rotateTimer !== null) {
        window.clearTimeout(rotateTimer)
        rotateTimer = null
      }
      // Flush the in-flight chunk, then release the microphone. The final
      // upload may land shortly after stop — its text still reaches the caller.
      try {
        recorder?.stop()
      } catch {
        // already stopped
      }
      recorder = null
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
    },
  }
}

/** Build the chosen engine. */
export function createEngine(
  choice: EngineChoice,
  handlers: TranscriptionHandlers,
  options: { sessionId: string; chunkMs?: number },
): TranscriptionEngine {
  if (choice === 'server') return createServerEngine(options, handlers)
  return createWebSpeechEngine(handlers)
}

