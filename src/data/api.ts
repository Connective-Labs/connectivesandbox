// Thin fetch helper for the Edge Functions. The app talks to its OWN origin
// (`/functions/v1/...`) and the host proxies to Supabase — see AGENTS.md for
// why (SameSite=Strict session cookie ⇒ same-origin function calls). The
// anon/publishable key is public by design; no service_role or other secret
// ever appears here.

const FUNCTIONS_BASE: string = import.meta.env.VITE_FUNCTIONS_BASE ?? '/functions/v1'
const ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface FunctionResponse<T> {
  status: number
  data: T
}

/** Call an Edge Function with credentials so the session cookie rides along. */
export async function callFunction<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<FunctionResponse<T>> {
  const headers: Record<string, string> = {}
  if (ANON_KEY.length > 0) headers.apikey = ANON_KEY
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${FUNCTIONS_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    credentials: 'include',
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

  const text = await response.text()
  let data: unknown = {}
  if (text.length > 0) {
    try {
      data = JSON.parse(text)
    } catch {
      data = {}
    }
  }
  return { status: response.status, data: data as T }
}

/** Throw a readable ApiError when the gateway rejects an admin operation. */
export function assertOk(response: FunctionResponse<{ error?: string }>): void {
  if (response.status >= 400) {
    throw new ApiError(
      response.data.error ?? `Request failed (${response.status})`,
      response.status,
    )
  }
}

/** POST raw binary bytes to an Edge Function (server STT audio chunks).
 *  Same-origin + credentials so the session cookie rides along. Returns the
 *  parsed JSON body, or throws ApiError with the server's error message. */
export async function postBinary<T = Record<string, unknown>>(
  path: string,
  body: Blob,
  headers: Record<string, string> = {},
): Promise<T> {
  const finalHeaders: Record<string, string> = { ...headers }
  if (ANON_KEY.length > 0) finalHeaders.apikey = ANON_KEY
  const response = await fetch(`${FUNCTIONS_BASE}${path}`, {
    method: 'POST',
    headers: finalHeaders,
    credentials: 'include',
    body,
  })
  const text = await response.text()
  let data: unknown = {}
  if (text.length > 0) {
    try {
      data = JSON.parse(text)
    } catch {
      data = {}
    }
  }
  if (!response.ok) {
    const message = (data as { error?: string }).error ?? `Request failed (${response.status})`
    throw new ApiError(message, response.status)
  }
  return data as T
}

export interface StreamResult {
  /** Final metadata event (the {done:true} payload), when it arrived. */
  done: Record<string, unknown> | null
  error?: string
}

/**
 * POST an Edge Function and consume its SSE reply, invoking onDelta for each
 * content chunk. Same-origin + credentials so the session cookie rides along
 * (see the note on callFunction).
 */
export async function streamFunction(
  path: string,
  body: unknown,
  onDelta: (delta: string) => void,
): Promise<StreamResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
  if (ANON_KEY.length > 0) headers.apikey = ANON_KEY

  const response = await fetch(`${FUNCTIONS_BASE}${path}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const data = (await response.json()) as { error?: string }
      if (data.error !== undefined) message = data.error
    } catch {
      // Keep the default message.
    }
    throw new ApiError(message, response.status)
  }
  if (response.body === null) return { done: null }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamError: string | undefined
  let donePayload: Record<string, unknown> | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]' || payload.length === 0) continue
      try {
        const parsed = JSON.parse(payload) as { delta?: string; done?: boolean; error?: string }
        if (typeof parsed.delta === 'string') onDelta(parsed.delta)
        if (parsed.done === true) donePayload = parsed as Record<string, unknown>
        if (parsed.error !== undefined && parsed.done !== true) streamError = parsed.error
      } catch {
        // Skip malformed frames.
      }
    }
  }
  return { done: donePayload, ...(streamError !== undefined ? { error: streamError } : {}) }
}
