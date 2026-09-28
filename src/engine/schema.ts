// Zod schema mirroring src/engine/types.ts (frozen). Validates an untrusted
// WorkflowSpec emitted by an admin LLM before the fixed component registry
// renders it. src/engine/ stays pure: Zod is a parsing library, not a network
// or data-layer dependency.

import { z } from 'zod'

import type { WorkflowSpec } from './types'

export const optionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
})

export const formFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'textarea', 'select']),
  required: z.boolean().optional(),
  options: z.array(optionSchema).optional(),
})

export const intakeComponentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file_upload'),
    id: z.string().min(1),
    label: z.string().min(1),
    accept: z.array(z.string().min(1)).min(1),
    multiple: z.boolean(),
    instructions: z.string().min(1),
  }),
  z.object({
    type: z.literal('chat'),
    id: z.string().min(1),
    placeholder: z.string().min(1),
    opening_message: z.string().min(1),
  }),
  z.object({
    type: z.literal('button_group'),
    id: z.string().min(1),
    label: z.string().min(1),
    options: z.array(optionSchema).min(1),
    multi: z.boolean(),
  }),
  z.object({
    type: z.literal('text_field'),
    id: z.string().min(1),
    label: z.string().min(1),
    multiline: z.boolean(),
  }),
  z.object({
    type: z.literal('form'),
    id: z.string().min(1),
    fields: z.array(formFieldSchema).min(1),
  }),
  z.object({
    type: z.literal('photo_slot'),
    id: z.string().min(1),
    label: z.string().min(1),
    capture_hint: z.string().min(1),
    accept: z.array(z.string().min(1)).min(1),
    // Judge-state key: picked files land in intake state under this key.
    key: z.string().min(1),
  }),
  z.object({
    type: z.literal('follow_up_card'),
    id: z.string().min(1),
    label: z.string().min(1),
    question: z.string().min(1),
    options: z.array(optionSchema).min(1),
    allow_text: z.boolean(),
  }),
])

export const thresholdSchema = z.object({
  auto: z.number().min(0).max(1),
  review: z.number().min(0).max(1),
})

export const judgeSchema = z.discriminatedUnion('question_type', [
  z.object({
    id: z.string().min(1),
    state_from: z.array(z.string()),
    question: z.string().min(1),
    question_type: z.literal('choice'),
    // For every `choice` judge, options is required.
    options: z.array(z.string().min(1)).min(1),
    thresholds: thresholdSchema,
  }),
  z.object({
    id: z.string().min(1),
    state_from: z.array(z.string()),
    question: z.string().min(1),
    question_type: z.literal('boolean'),
    options: z.array(z.string().min(1)).optional(),
    thresholds: thresholdSchema,
  }),
  z.object({
    id: z.string().min(1),
    state_from: z.array(z.string()),
    question: z.string().min(1),
    question_type: z.literal('scalar'),
    options: z.array(z.string().min(1)).optional(),
    thresholds: thresholdSchema,
  }),
])

export const dashboardPanelSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('confidence_meter'),
    id: z.string().min(1),
    judge_id: z.string().min(1),
    label: z.string().min(1),
  }),
  z.object({
    type: z.literal('analysis'),
    id: z.string().min(1),
    title: z.string().min(1),
    source: z.enum(['llm', 'judges']),
  }),
  z.object({
    type: z.literal('monitoring'),
    id: z.string().min(1),
    metrics: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('decision_log'),
    id: z.string().min(1),
    limit: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('usage_counter'),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
  // --- Module waves 1 + 2 (captain-approved extension, 2026-09-30) ---
  z.object({
    type: z.literal('triage_verdict'),
    id: z.string().min(1),
    judge_id: z.string().min(1),
    verdicts: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).min(1),
    follow_up_judge_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('quote_panel'),
    id: z.string().min(1),
    title: z.string().min(1),
    lines: z
      .array(
        z.object({
          label: z.string().min(1),
          quantity: z.number().optional(),
          amount: z.string().min(1),
        }),
      )
      .min(1),
    basis: z.string().min(1),
    status: z.enum(['draft', 'sent', 'accepted', 'expired']),
    band_judge_id: z.string().min(1).optional(),
    bands: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).optional(),
  }),
  z.object({
    type: z.literal('escalation_card'),
    id: z.string().min(1),
    contact: z.string().min(1),
    reason: z.string().min(1),
    reference: z.string().min(1).optional(),
    action_label: z.string().min(1),
    judge_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('thread_preview'),
    id: z.string().min(1),
    title: z.string().min(1),
    photo_slot_key: z.string().min(1).optional(),
    follow_up_judge_id: z.string().min(1).optional(),
    quote_judge_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('status_queue'),
    id: z.string().min(1),
    title: z.string().min(1),
    rows: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          source: z.string().min(1),
          severity: z.enum(['low', 'medium', 'high']),
          state: z.string().min(1),
        }),
      )
      .min(1),
    // Exactly two per-row action buttons — the "one yes, one not yet" shape.
    actions: z.tuple([
      z.object({ value: z.string().min(1), label: z.string().min(1), primary: z.boolean() }),
      z.object({ value: z.string().min(1), label: z.string().min(1), primary: z.boolean() }),
    ]),
  }),
  z.object({
    type: z.literal('alert_feed'),
    id: z.string().min(1),
    title: z.string().min(1),
    alerts: z
      .array(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1),
          source: z.string().min(1),
          age_days: z.number(),
          severity: z.enum(['low', 'medium', 'high']),
        }),
      )
      .min(1),
    action_label: z.string().min(1),
    // Age (days) at which a medium alert displays as critical.
    critical_after_days: z.number().optional(),
  }),
  z.object({
    type: z.literal('kpi_tiles'),
    id: z.string().min(1),
    title: z.string().min(1),
    metrics: z
      .array(
        z.object({
          label: z.string().min(1),
          metric: z.string().min(1),
          delta: z
            .object({
              direction: z.enum(['up', 'down', 'flat']),
              text: z.string().min(1),
            })
            .optional(),
        }),
      )
      .min(2)
      .max(4),
  }),
  z.object({
    type: z.literal('pipeline_tracker'),
    id: z.string().min(1),
    title: z.string().min(1),
    stages: z
      .array(
        z.object({
          label: z.string().min(1),
          count: z.number().int().nonnegative().optional(),
        }),
      )
      .min(2),
    current_judge_id: z.string().min(1).optional(),
    current: z.string().min(1).optional(),
  }),
])

export const workflowSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  intake: z.object({
    components: z.array(intakeComponentSchema),
  }),
  judges: z.array(judgeSchema),
  dashboard: z.object({
    panels: z.array(dashboardPanelSchema),
  }),
})

export type ValidatedWorkflowSpec = z.infer<typeof workflowSpecSchema>

// Compile-time check: a spec that passes the schema is assignable to the
// frozen WorkflowSpec type. If this drifts, the schema no longer mirrors
// types.ts and must be fixed.
type SchemaMatchesFrozenTypes = ValidatedWorkflowSpec extends WorkflowSpec ? true : false
const schemaMatchesFrozenTypes: SchemaMatchesFrozenTypes = true
void schemaMatchesFrozenTypes

export function parseWorkflowSpec(input: unknown): ValidatedWorkflowSpec {
  return workflowSpecSchema.parse(input)
}

export function safeParseWorkflowSpec(input: unknown) {
  return workflowSpecSchema.safeParse(input)
}
