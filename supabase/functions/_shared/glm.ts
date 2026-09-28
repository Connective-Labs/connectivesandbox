// GLM (Z.ai) chat client for the Edge Functions. OpenAI-compatible chat
// completions at https://api.z.ai/api/paas/v4/chat/completions (verified
// against the current Z.ai docs).
//
// Phase 6 parameters (captain's choice + docs):
//   model:            glm-5.3-flash (GLM_MODEL secret overrides)
//   temperature:      1
//   top_p:            0.95
//   thinking:         { type: 'enabled' }   — GLM-5.3 series reasoning switch
//   reasoning_effort: high (GLM_REASONING_EFFORT secret overrides)
//
// DEVIATION NOTE (recorded in AGENTS.md): the build brief specifies
// reasoning_effort 'max'. Verified against Z.ai docs and measured live,
// 'max' makes a single builder turn think for ~150s+ — right at (and often
// past) the hosted Edge Function wall-clock limit, killing the request
// (WORKER_RESOURCE_LIMIT). 'high' completes the same turn in ~60s with full
// content. The effort is a secret (GLM_REASONING_EFFORT) so the captain can
// flip it to 'max' where a longer-running runtime exists.
//
// The ZAI_API_KEY secret never leaves the server (AGENTS.md invariant 5).

const GLM_API_BASE = 'https://api.z.ai/api/paas/v4'
const DEFAULT_MODEL = 'glm-5.3-flash'

export interface GlmContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface GlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | GlmContentPart[]
}

export interface GlmRequestOptions {
  stream?: boolean
  maxTokens?: number
  /** Per-call effort override (default stays the GLM_REASONING_EFFORT secret). */
  reasoningEffort?: 'low' | 'high' | 'max'
}

function glmApiKey(): string {
  const key = Deno.env.get('ZAI_API_KEY')
  if (!key) throw new Error('ZAI_API_KEY is not configured')
  return key
}

function glmModel(): string {
  return Deno.env.get('GLM_MODEL') ?? DEFAULT_MODEL
}

function glmReasoningEffort(override?: 'low' | 'high' | 'max'): 'low' | 'high' | 'max' {
  if (override !== undefined) return override
  const value = Deno.env.get('GLM_REASONING_EFFORT')
  return value === 'low' || value === 'max' ? value : 'high'
}

function requestBody(messages: GlmMessage[], options: GlmRequestOptions): Record<string, unknown> {
  return {
    model: glmModel(),
    messages,
    temperature: 1,
    top_p: 0.95,
    thinking: { type: 'enabled' },
    reasoning_effort: glmReasoningEffort(options.reasoningEffort),
    stream: options.stream ?? false,
    // GLM-5.3-flash with reasoning_effort 'max' can spend thousands of
    // tokens thinking; keep the output budget generous so content survives.
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : { max_tokens: 16384 }),
  }
}

async function glmFetch(messages: GlmMessage[], options: GlmRequestOptions): Promise<Response> {
  return fetch(`${GLM_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${glmApiKey()}`,
    },
    body: JSON.stringify(requestBody(messages, options)),
  })
}

/** Non-streaming completion: returns the assistant message content. */
export async function glmChat(
  messages: GlmMessage[],
  options: GlmRequestOptions = {},
): Promise<string> {
  const response = await glmFetch(messages, { ...options, stream: false })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`GLM request failed: ${response.status} ${raw.slice(0, 300)}`)
  }
  const parsed = JSON.parse(raw) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]
  }
  const choice = parsed.choices?.[0]
  const content = choice?.message?.content ?? ''
  if (content.length === 0 && choice?.finish_reason === 'length') {
    throw new Error('GLM output budget exhausted before any content was produced')
  }
  return content
}

/**
 * Streaming completion: returns the raw fetch Response whose body is the
 * upstream SSE stream (data: {...} chunks, data: [DONE] terminator) for the
 * caller to relay or aggregate.
 */
export async function glmChatStream(
  messages: GlmMessage[],
  options: GlmRequestOptions = {},
): Promise<Response> {
  return glmFetch(messages, { ...options, stream: true })
}
