// Template library UI (Phase 2): the library grid and the instantiation
// slot form embedded in the workflow picker. A template card shows name,
// version, category, and usage; the instantiate form pre-fills every slot
// with the template's example so the rep only edits the client-specific
// copy — the identity (name/description) is always required fresh, so one
// client's identity never ships to another.

import { useMemo, useState } from 'react'
import { Layers, Users } from 'lucide-react'

import { GhostButton, PrimaryButton } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'
import type { TemplateSlot, WorkflowTemplate } from '@/data/adapters/templates'

const GROUP_LABELS: Record<string, string> = {
  identity: 'Identity',
  intake: 'Intake copy',
  judges: 'Judges',
  dashboard: 'Dashboard copy',
}

const GROUP_ORDER = ['identity', 'intake', 'judges', 'dashboard'] as const

export function TemplateLibraryGrid({
  templates,
  onPick,
}: {
  templates: WorkflowTemplate[]
  onPick: (template: WorkflowTemplate) => void
}) {
  if (templates.length === 0) return null
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <Layers size={13} aria-hidden="true" className="text-slate-400" />
        Your library
      </p>
      <p className="mt-0.5 text-xs text-slate-400">
        Saved builds — pick one and customise the copy for the new client.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onPick(template)}
            className="group rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-accent hover:shadow-sm focus:border-accent focus:outline-none"
          >
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-ink">{template.name}</span>
              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-500">
                v{template.version}
              </span>
              {template.is_curated && (
                <span className="shrink-0 rounded-full bg-accent-wash px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                  recipe
                </span>
              )}
            </span>
            <span className="mt-1 block truncate text-xs text-slate-500">
              {template.description ?? template.category}
            </span>
            <span className="mt-1.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
              <Users size={10} aria-hidden="true" />
              used by {template.usage_count} {template.usage_count === 1 ? 'workflow' : 'workflows'}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Grouped slot list minus the identity pair (rendered separately above). */
function slotsByGroup(slots: TemplateSlot[]): [string, TemplateSlot[]][] {
  const groups = new Map<string, TemplateSlot[]>()
  for (const slot of slots) {
    if (slot.group === 'identity') continue
    const list = groups.get(slot.group) ?? []
    list.push(slot)
    groups.set(slot.group, list)
  }
  return GROUP_ORDER.filter((group) => groups.has(group)).map((group) => [
    group,
    groups.get(group) as TemplateSlot[],
  ])
}

export function TemplateInstantiateForm({
  template,
  clientName,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  template: WorkflowTemplate
  clientName: string | null
  busy: boolean
  error: string | null
  onBack: () => void
  onConfirm: (result: { templateId: string; name: string; description: string; slotValues: Record<string, string | number> }) => void
}) {
  const identity = useMemo(
    () => template.slots.filter((slot) => slot.group === 'identity'),
    [template],
  )
  const nameSlot = identity.find((slot) => slot.key === 'name')
  const descriptionSlot = identity.find((slot) => slot.key === 'description')
  const grouped = useMemo(() => slotsByGroup(template.slots), [template])

  const [name, setName] = useState(() => defaultFor(nameSlot, clientName))
  const [description, setDescription] = useState(() => defaultFor(descriptionSlot, clientName))
  const [values, setValues] = useState<Record<string, string | number>>(() =>
    Object.fromEntries(
      template.slots
        .filter((slot) => slot.group !== 'identity')
        .map((slot) => [slot.key, slot.example]),
    ),
  )

  const nameReady = name.trim().length > 0

  const confirm = () => {
    if (!nameReady || busy) return
    // Only changed slots travel — untouched copy keeps the template's example.
    const slotValues: Record<string, string | number> = {}
    for (const slot of template.slots) {
      if (slot.group === 'identity') continue
      const value = values[slot.key]
      if (value !== undefined && value !== slot.example) slotValues[slot.key] = value
    }
    onConfirm({
      templateId: template.id,
      name: name.trim(),
      description: description.trim(),
      slotValues,
    })
  }

  return (
    <>
      <p className="text-sm font-semibold text-ink">{template.name}</p>
      <p className="mt-0.5 text-xs text-slate-400">
        Customise the copy for {clientName ?? 'the new client'} — everything starts from the template's example.
      </p>
      <div className="scroll-slim mt-3 max-h-[46vh] space-y-3 overflow-y-auto pr-1">
        <div>
          <label htmlFor="template-name" className="text-xs font-semibold text-ink">
            Workflow name
          </label>
          <input
            id="template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Workflow name"
            autoFocus
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="template-description" className="text-xs font-semibold text-ink">
            Description
          </label>
          <textarea
            id="template-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </div>
        {grouped.map(([group, slots]) => (
          <fieldset key={group} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
            <legend className="px-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
              {GROUP_LABELS[group] ?? group}
            </legend>
            <div className="space-y-2">
              {slots.map((slot) => (
                <SlotInput
                  key={slot.key}
                  slot={slot}
                  value={values[slot.key]}
                  onChange={(value) => setValues((previous) => ({ ...previous, [slot.key]: value }))}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-2">
        <GhostButton onClick={onBack}>Back</GhostButton>
        <PrimaryButton
          onClick={confirm}
          disabled={!nameReady || busy}
          className={cn(!nameReady || busy && 'opacity-50')}
        >
          {busy ? 'Creating…' : 'Create workflow'}
        </PrimaryButton>
      </div>
    </>
  )
}

function defaultFor(slot: TemplateSlot | undefined, clientName: string | null): string {
  if (slot === undefined || typeof slot.example !== 'string') return ''
  // Identity defaults never carry another client's name into the new build.
  if (clientName !== null && slot.key === 'name') return `${clientName} workflow`
  return slot.example
}

function SlotInput({
  slot,
  value,
  onChange,
}: {
  slot: TemplateSlot
  value: string | number | undefined
  onChange: (value: string | number) => void
}) {
  const isThreshold = slot.type !== 'string'
  const id = `slot-${slot.key.replace(/[._]/g, '-')}`
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">
        {slot.label}
      </label>
      {isThreshold ? (
        <input
          id={id}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={typeof value === 'number' ? value : Number(value ?? 0)}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-0.5 w-28 rounded-md border border-slate-200 bg-white px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
        />
      ) : (
        <input
          id={id}
          value={typeof value === 'string' ? value : String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className="mt-0.5 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
        />
      )}
    </div>
  )
}
