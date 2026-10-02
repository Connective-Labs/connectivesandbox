// Spec extraction + validation shared by the admin-chat builder and the
// headless verify layer. Pure module: only the frozen Zod schema, no Deno
// globals, no network — importable from Edge Functions AND Node scripts.

import { safeParseWorkflowSpec } from '../../../src/engine/schema.ts'
import type { WorkflowSpec } from '../../../src/engine/types.ts'

/** Extract the last JSON object emitted in assistant content (fenced or bare). */
export function extractSpecJson(content: string): string | null {
  const fenced = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  for (let index = fenced.length - 1; index >= 0; index--) {
    const candidate = fenced[index]?.[1]?.trim()
    if (candidate && candidate.startsWith('{')) return candidate
  }
  // Bare object: scan for a balanced {...} (string-aware).
  const start = content.lastIndexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < content.length; index++) {
    const char = content[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return content.slice(start, index + 1)
    }
  }
  return null
}

function formatZodError(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/** Validate a spec JSON string against the frozen Zod schema. */
export function validateSpec(json: string): { ok: true; spec: WorkflowSpec } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { ok: false, error: `The spec block is not valid JSON — ${(error as Error).message}` }
  }
  const result = safeParseWorkflowSpec(parsed)
  return result.success
    ? { ok: true, spec: result.data }
    : { ok: false, error: formatZodError(result.error) }
}
