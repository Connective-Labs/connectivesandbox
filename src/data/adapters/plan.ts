// GLM planning adapter (Phase 3): the rep's brief + client context go to the
// plan-workflow Edge Function; a validated WorkflowPlan and its deterministically
// compiled draft come back. The plan is advice — Test/Publish stays the gate.

import type { WorkflowSpec } from '@/engine/types'
import type { WorkflowPlan } from '@/engine/plan'
import { assertOk, callFunction, type FunctionResponse } from '@/data/api'

export type { WorkflowPlan }

export interface PlanDraft {
  id: string | null
  version: number
  spec: WorkflowSpec
  delta_summary: string
}

export interface PlanResult {
  plan: WorkflowPlan
  draft: PlanDraft
  /** Human-readable list of the slot changes the compile applied. */
  applied: string[]
}

export async function planWorkflow(
  workflowId: string,
  clientId: string,
  brief: string,
): Promise<PlanResult> {
  const response = await callFunction<PlanResult>('/plan-workflow', {
    method: 'POST',
    body: { workflow_id: workflowId, client_id: clientId, brief },
  })
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}
