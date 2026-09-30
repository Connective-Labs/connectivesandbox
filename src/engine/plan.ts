// WorkflowPlan — the GLM planning stage's validated output (Phase 3). The
// planner reads the rep's brief (plus any recent discovery-call transcript),
// the client context, and the template library, and proposes WHAT to build:
// which template to start from, which modules it expects, the slot-level
// customisations for THIS client, and what is still open.
//
// The plan is NEVER applied by the model: `plan-workflow` compiles the chosen
// template deterministically through src/engine/templating.ts
// (`applySlotValues`), so only whitelisted slot paths change, thresholds
// clamp to the bounded band, and the frozen Zod schema stays the hard gate.
// A plan that names an unknown template or an unknown slot key is simply not
// applied — determinism does not depend on the model's obedience.
//
// Pure module (Zod is a parsing library, not a data-layer dependency).

import { z } from 'zod'

export const workflowPlanSchema = z.object({
  /** One line: what to build for this client. */
  headline: z.string().min(1),
  /** Why this shape — shown to the rep before anything is built. */
  rationale: z.string().min(1),
  /** The chosen library template (uuid), or null for a from-scratch build. */
  template_id: z.string().min(1).nullable(),
  /** The template's name at planning time (display only). */
  template_name: z.string().min(1).nullable(),
  /** Catalogue module kinds the plan expects, display + sanity-check only. */
  modules: z.object({
    intake: z.array(z.string().min(1)),
    dashboard: z.array(z.string().min(1)),
  }),
  /** Slot-keyed customisations for this client; applied via applySlotValues
   *  (unknown keys and out-of-band values are dropped deterministically). */
  customisations: z.array(
    z.object({
      key: z.string().min(1),
      value: z.union([z.string(), z.number()]),
      why: z.string().min(1),
    }),
  ),
  /** What the rep still needs to answer — seeds the Refine-in-chat composer. */
  open_questions: z.array(z.string().min(1)),
})

export type WorkflowPlan = z.infer<typeof workflowPlanSchema>

export function parseWorkflowPlan(input: unknown): WorkflowPlan {
  return workflowPlanSchema.parse(input)
}

export function safeParseWorkflowPlan(input: unknown) {
  return workflowPlanSchema.safeParse(input)
}

/** The plan as a chat-readable markdown card (the builder transcript view). */
export function planToMarkdown(plan: WorkflowPlan): string {
  const lines: string[] = [`**${plan.headline}**`, '', plan.rationale, '']
  if (plan.template_name !== null) {
    lines.push(`Starting from template: *${plan.template_name}*`)
  } else {
    lines.push('Starting from a fresh build (no library template matched).')
  }
  const modules = [...plan.modules.intake, ...plan.modules.dashboard]
  if (modules.length > 0) {
    lines.push('', `Modules: ${modules.map((module) => `\`${module}\``).join(', ')}`)
  }
  if (plan.customisations.length > 0) {
    lines.push('', 'Customised for this client:')
    for (const item of plan.customisations.slice(0, 8)) {
      lines.push(`- ${item.why} — \`${item.value}\``)
    }
  }
  if (plan.open_questions.length > 0) {
    lines.push('', 'Still open:')
    for (const question of plan.open_questions.slice(0, 5)) {
      lines.push(`- ${question}`)
    }
  }
  return lines.join('\n')
}
