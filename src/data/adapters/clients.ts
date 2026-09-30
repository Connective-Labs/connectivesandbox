// Real clients adapter. Admin CRUD rides the `admin-api` Edge
// Function gateway (admin cookie verified server-side, service_role applied
// inside the function — never in the browser). Client access codes are
// stored in plaintext by design (an admin must be able to read a code out
// over WhatsApp); slug is derived from the name since the clients table has
// no slug column.

import type { Client } from '@/data/types'
import { viaCache, invalidateReads } from '@/data/prefetch'
import { assertOk, callFunction, type FunctionResponse } from '@/data/api'

interface ClientRow {
  id: string
  name: string
  contact: string | null
  created_at: string
  is_active: boolean
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    slug: slugify(row.name),
    created_at: row.created_at,
  }
}

function withData<T>(response: FunctionResponse<T>): T {
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data
}

export function listClients(): Promise<Client[]> {
  // Read-through cache: warmed behind the login gate, instant on mount.
  return viaCache('clients', async () => {
    const { clients } = withData(
      await callFunction<{ clients: ClientRow[] }>('/admin-api/clients'),
    )
    return clients.map(toClient)
  })
}

export async function getClient(id: string): Promise<Client | null> {
  const rows = await listClients()
  return rows.find((client) => client.id === id) ?? null
}

/** Sandbox trade-off: codes are stored plaintext and read out over WhatsApp. */
export async function getClientAccessCode(clientId: string): Promise<string | null> {
  const response = await callFunction<{ access_code?: string; error?: string }>(
    `/admin-api/clients/${clientId}/access-code`,
  )
  if (response.status === 404) return null
  assertOk(response as unknown as FunctionResponse<{ error?: string }>)
  return response.data.access_code ?? null
}

export async function createClient(name: string, code: string): Promise<Client> {
  const { client } = withData(
    await callFunction<{ client: ClientRow }>('/admin-api/clients', {
      method: 'POST',
      body: { name, access_code: code },
    }),
  )
  invalidateReads()
  return toClient(client)
}

export async function renameClient(clientId: string, name: string): Promise<void> {
  withData(
    await callFunction(`/admin-api/clients/${clientId}`, {
      method: 'PATCH',
      body: { name },
    }),
  )
  invalidateReads()
}

export async function deleteClient(clientId: string): Promise<void> {
  withData(await callFunction(`/admin-api/clients/${clientId}`, { method: 'DELETE' }))
  invalidateReads()
}

export interface OrgUsageTotals {
  runsThisMonth: number
  decisionsMade: number
}

/** Organisation-wide totals for the usage_counter panel. */
export async function getOrgUsageTotals(): Promise<OrgUsageTotals> {
  const data = withData(
    await callFunction<{ runsThisMonth: number; decisionsMade: number }>(
      '/admin-api/usage/totals',
    ),
  )
  return { runsThisMonth: data.runsThisMonth, decisionsMade: data.decisionsMade }
}
