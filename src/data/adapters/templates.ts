// Reusable template library adapter (Phase 2). Admin-only; rides the
// admin-api gateway like every other admin read/write. Templates are
// whole-workflow assets with parameterisation slots computed by
// src/engine/templating.ts.

import type { TemplateSlot } from '@/engine/templating'
import type { WorkflowSpec } from '@/engine/types'
import type { WorkflowSummary } from '@/data/types'
import { viaCache, invalidateReads } from '@/data/prefetch'
import { assertOk, callFunction, type FunctionResponse } from '@/data/api'

export type { TemplateSlot }

export interface WorkflowTemplate {
  id: string
  name: string
  description: string | null
  category: string
  version: number
  slots: TemplateSlot[]
  is_curated: boolean
  parent_template_id: string | null
  created_from_workflow_id: string | null
  usage_count: number
  created_at: string
  updated_at: string
}

export interface TemplateDetail extends WorkflowTemplate {
  spec: WorkflowSpec
}

function withData<T>(response: FunctionResponse<T>): T {
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}

/** Library list (curated recipe baselines self-seed server-side). */
export function listTemplates(): Promise<WorkflowTemplate[]> {
  return viaCache('templates', async () => {
    const { templates } = withData(
      await callFunction<{ templates: WorkflowTemplate[] }>('/admin-api/templates'),
    )
    return templates.map((row) => ({ ...row, slots: row.slots ?? [] }))
  })
}

export async function getTemplate(id: string): Promise<TemplateDetail | null> {
  const response = await callFunction<{ template?: TemplateDetail }>(
    `/admin-api/templates/${encodeURIComponent(id)}`,
  )
  if (response.status === 404) return null
  const { template } = withData(response)
  return template !== undefined ? { ...template, slots: template.slots ?? [] } : null
}

/** Save a published workflow as a template (new row; chains a version when
 *  as_version_of is given). */
export async function saveTemplateFromWorkflow(
  workflowId: string,
  name?: string,
  asVersionOf?: string,
): Promise<WorkflowTemplate> {
  const { template } = withData(
    await callFunction<{ template: WorkflowTemplate }>('/admin-api/templates', {
      method: 'POST',
      body: {
        workflow_id: workflowId,
        ...(name !== undefined ? { name } : {}),
        ...(asVersionOf !== undefined ? { as_version_of: asVersionOf } : {}),
      },
    }),
  )
  invalidateReads()
  return { ...template, slots: template.slots ?? [] }
}

export interface InstantiateResult {
  workflow: WorkflowSummary & { client_id: string }
  applied: string[]
}

/** Instantiate a template for a client: slot values apply deterministically,
 *  the workflow starts at version 1 and rides the normal Test/Publish gate. */
export async function instantiateTemplate(
  templateId: string,
  targetClientId: string,
  name: string,
  options: { description?: string; slotValues?: Record<string, string | number> } = {},
): Promise<InstantiateResult> {
  const result = withData(
    await callFunction<InstantiateResult>(`/admin-api/templates/${encodeURIComponent(templateId)}/instantiate`, {
      method: 'POST',
      body: {
        target_client_id: targetClientId,
        name,
        ...(options.description !== undefined ? { description: options.description } : {}),
        ...(options.slotValues !== undefined ? { slot_values: options.slotValues } : {}),
      },
    }),
  )
  invalidateReads()
  return result
}

export async function deleteTemplate(id: string): Promise<void> {
  withData(await callFunction(`/admin-api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  invalidateReads()
}
