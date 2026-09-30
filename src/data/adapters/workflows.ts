// Real workflows adapter. Admin CRUD rides the `admin-api` Edge
// Function gateway; for a logged-in client the gateway scopes reads to that
// client's rows (mirroring the RLS policies). Specs stored in the database
// are validated client-side against src/engine/schema.ts before publishing.

import type { WorkflowSpec } from '@/engine/types'
import type { WorkflowSummary } from '@/data/types'
import { viaCache, invalidateReads } from '@/data/prefetch'
import { assertOk, callFunction, type FunctionResponse } from '@/data/api'

interface WorkflowRow {
  id: string
  client_id: string
  name: string
  description: string | null
  version: number
  updated_at: string
}

interface WorkflowDetailRow extends WorkflowRow {
  spec: WorkflowSpec
}

function toSummary(row: WorkflowRow): WorkflowSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    client_id: row.client_id,
    version: row.version,
    updated_at: row.updated_at,
  }
}

function withData<T>(response: FunctionResponse<T>): T {
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}

export function listWorkflows(clientId?: string): Promise<WorkflowSummary[]> {
  // Read-through cache: warmed behind the login gate, instant on mount.
  return viaCache(`workflows:${clientId ?? 'all'}`, async () => {
    const query = clientId ? `?client_id=${encodeURIComponent(clientId)}` : ''
    const { workflows } = withData(
      await callFunction<{ workflows: WorkflowRow[] }>(`/admin-api/workflows${query}`),
    )
    return workflows.map(toSummary)
  })
}

export function getWorkflowSpec(workflowId: string): Promise<WorkflowSpec | null> {
  return viaCache(`spec:${workflowId}`, async () => {
    const response = await callFunction<{ workflow?: WorkflowDetailRow; error?: string }>(
      `/admin-api/workflows/${workflowId}`,
    )
    if (response.status === 404) return null
    assertOk(response as unknown as FunctionResponse<{ error?: string }>)
    return response.data.workflow?.spec ?? null
  })
}

export async function createWorkflow(
  clientId: string,
  name: string,
  spec: WorkflowSpec | null,
): Promise<WorkflowSummary> {
  // A null spec stores a valid empty WorkflowSpec so the row satisfies the
  // NOT NULL spec column and the client workspace renders an empty state.
  const { workflow } = withData(
    await callFunction<{ workflow: WorkflowRow }>('/admin-api/workflows', {
      method: 'POST',
      body: {
        client_id: clientId,
        name,
        spec: spec !== null ? { ...spec, name } : null,
      },
    }),
  )
  invalidateReads()
  return toSummary(workflow)
}

export async function renameWorkflow(workflowId: string, name: string): Promise<void> {
  withData(
    await callFunction(`/admin-api/workflows/${workflowId}`, {
      method: 'PATCH',
      body: { name },
    }),
  )
  invalidateReads()
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  withData(
    await callFunction(`/admin-api/workflows/${workflowId}`, { method: 'DELETE' }),
  )
  invalidateReads()
}

/** Update the workflow description in both the summary and the stored spec. */
export async function updateWorkflowDescription(
  workflowId: string,
  description: string,
): Promise<void> {
  withData(
    await callFunction(`/admin-api/workflows/${workflowId}`, {
      method: 'PATCH',
      body: { description },
    }),
  )
  invalidateReads()
}

/** Publish: stores a validated spec against the workflow and bumps version. */
export async function saveWorkflowSpec(workflowId: string, spec: WorkflowSpec): Promise<void> {
  withData(
    await callFunction(`/admin-api/workflows/${workflowId}/spec`, {
      method: 'PUT',
      body: { spec },
    }),
  )
  invalidateReads()
}

/** Raw cross-client copy (Phase 4): clone a workflow's spec into another
 *  client. The curated path is save-as-template + instantiate. */
export async function cloneWorkflowTo(
  workflowId: string,
  targetClientId: string,
  name: string,
): Promise<WorkflowSummary> {
  const { workflow } = withData(
    await callFunction<{ workflow: WorkflowRow }>(`/admin-api/workflows/${workflowId}/clone`, {
      method: 'POST',
      body: { target_client_id: targetClientId, name },
    }),
  )
  invalidateReads()
  return toSummary(workflow)
}
