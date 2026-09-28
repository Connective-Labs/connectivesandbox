// live-draft — the draft rail (livebuild v2).
//
// Since the fact-ledger rearchitecture, DRAFTS ARE COMPILED by `live-facts`
// from the keyed fact ledger (src/engine/compilers.ts). This function keeps
// only the rail operations: list a workflow's drafts, flag a draft published
// after the rep presses Publish, and discard.
//
//   GET    /live-draft?workflow_id=   list drafts for a workflow (admin only)
//   PATCH  /live-draft   { draft_id, published }   flip a draft's published flag
//   DELETE /live-draft?draft_id=               discard a draft
//
// The old POST (screen + GLM regeneration of the whole spec) is REMOVED: it
// regenerated the spec from rolling prose and produced duplicated modules.
// POST here returns 410 with a pointer to /live-facts.

import { handleOptions, jsonResponse } from '../_shared/cors.ts'
import { readSession } from '../_shared/jwt.ts'
import { restDelete, restSelect, restUpdate } from '../_shared/rest.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return handleOptions(request)

  const session = await readSession(request)
  if (!session) return jsonResponse(request, { error: 'Not authenticated' }, 401)
  if (session.app_role !== 'admin') return jsonResponse(request, { error: 'Admin session required' }, 403)

  const url = new URL(request.url)

  try {
    // ---------------------------------------------------------------
    // GET — list drafts (admin only)
    // ---------------------------------------------------------------
    if (request.method === 'GET') {
      const workflowId = url.searchParams.get('workflow_id') ?? ''
      if (!UUID_RE.test(workflowId)) {
        return jsonResponse(request, { error: 'workflow_id is required' }, 400)
      }
      const drafts = await restSelect<Record<string, unknown>>('spec_drafts', {
        workflow_id: `eq.${workflowId}`,
        select: 'id,client_id,workflow_id,version,spec,delta_summary,source,published,created_at',
        order: 'version.desc',
      })
      return jsonResponse(request, { drafts })
    }

    // ---------------------------------------------------------------
    // PATCH — flip the published flag after the existing publish path
    // ---------------------------------------------------------------
    if (request.method === 'PATCH') {
      const body = await request.json()
      const draftId = typeof body?.draft_id === 'string' ? body.draft_id : ''
      if (!UUID_RE.test(draftId)) return jsonResponse(request, { error: 'draft_id is required' }, 400)
      const updated = await restUpdate<{ id: string; published: boolean }>(
        'spec_drafts',
        { id: `eq.${draftId}` },
        { published: body?.published === true },
      )
      if (updated.length === 0) return jsonResponse(request, { error: 'Not found' }, 404)
      return jsonResponse(request, { draft: updated[0] })
    }

    // ---------------------------------------------------------------
    // DELETE — discard a draft
    // ---------------------------------------------------------------
    if (request.method === 'DELETE') {
      const draftId = url.searchParams.get('draft_id') ?? ''
      if (!UUID_RE.test(draftId)) return jsonResponse(request, { error: 'draft_id is required' }, 400)
      await restDelete('spec_drafts', { id: `eq.${draftId}` })
      return jsonResponse(request, { ok: true })
    }

    // ---------------------------------------------------------------
    // POST — removed (fact-ledger architecture drafts via /live-facts)
    // ---------------------------------------------------------------
    return jsonResponse(request, {
      error: 'live-draft POST moved to /live-facts (fact-ledger architecture)',
      moved_to: '/live-facts',
    }, 410)
  } catch (error) {
    console.error('[live-draft] error:', error instanceof Error ? error.message : error)
    return jsonResponse(request, { error: 'Internal error' }, 500)
  }
})
