// STT adapter (browser-side). v1 engine: the browser's built-in Web Speech
// API (webkitSpeechRecognition) — Chrome-only, degrades with a clear one-line
// message on unsupported browsers. No audio is stored or uploaded: only final
// text segments leave the browser, handed to the caller via onSegment.
//
// Engine interface (start/stop/onSegment) is deliberately small so a
// streaming server engine (Deepgram/Whisper) slots in later without UI
// changes — the UI only ever talks to TranscriptionEngine (decision recorded
// in AGENTS.md). Interim results are surfaced for live captions; only final
// segments are durable (the live-draft function persists those).

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
  onError(message: string): void
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
 * Build the v1 engine. Chrome-only: callers must check speechSupported()
 * first and show "Live transcription needs Chrome." otherwise.
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
