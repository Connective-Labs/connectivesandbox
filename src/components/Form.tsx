// Registry entry for intake component type "form": labelled field stack with
// text, textarea, and select fields. Values land in the workspace intake
// state as Record<fieldId, string> under the form component id. Inline
// variant (polish 4): compact card inside the chat flow — submitting posts
// the answers into the flow like a message via onSubmitted.

import { Loader2, Send } from 'lucide-react'

import type { IntakeComponent } from '@/engine/types'
import type { IntakeComponentViewProps } from '@/engine/registry'
import { Card, Eyebrow } from '@/components/ui/Primitives'
import SpecText from '@/components/SpecText'
import { useWorkspace } from '@/state/workspace'

export type FormComponent = Extract<IntakeComponent, { type: 'form' }>

const controlClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50'

function fieldsSummary(
  component: FormComponent,
  values: Record<string, string>,
): string {
  return component.fields
    .map((field) => `${field.label}: ${values[field.id]?.trim() || '—'}`)
    .join(' · ')
}

function FormFields({
  component,
  values,
  disabled,
  compact,
  onEnter,
}: {
  component: FormComponent
  values: Record<string, string>
  disabled: boolean
  compact?: boolean
  onEnter?: () => void
}) {
  const { setIntakeValue } = useWorkspace()
  const setValue = (fieldId: string, value: string) => {
    setIntakeValue(component.id, { ...values, [fieldId]: value })
  }
  return (
    <div className={compact ? 'space-y-2.5' : 'space-y-4'}>
      {component.fields.map((field) => (
        <div key={field.id}>
          <label
            htmlFor={`field-${component.id}-${field.id}`}
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            <SpecText value={field.label} />
            {field.required === true && (
              <span aria-hidden="true" className="ml-0.5 text-accent">
                *
              </span>
            )}
          </label>
          {field.type === 'textarea' ? (
            <textarea
              id={`field-${component.id}-${field.id}`}
              value={values[field.id] ?? ''}
              onChange={(event) => setValue(field.id, event.target.value)}
              onKeyDown={(event) => {
                if (onEnter !== undefined && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  onEnter()
                }
              }}
              disabled={disabled}
              rows={compact ? 2 : 3}
              placeholder="Type here…"
              className={`${controlClass} resize-y leading-relaxed`}
            />
          ) : field.type === 'select' ? (
            <select
              id={`field-${component.id}-${field.id}`}
              value={values[field.id] ?? ''}
              onChange={(event) => setValue(field.id, event.target.value)}
              disabled={disabled}
              className={controlClass}
            >
              <option value="">Select…</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={`field-${component.id}-${field.id}`}
              value={values[field.id] ?? ''}
              onChange={(event) => setValue(field.id, event.target.value)}
              onKeyDown={(event) => {
                if (onEnter !== undefined && event.key === 'Enter') {
                  event.preventDefault()
                  onEnter()
                }
              }}
              disabled={disabled}
              placeholder="Type here…"
              className={controlClass}
            />
          )}
        </div>
      ))}
    </div>
  )
}

/** Panel variant: standalone form card (polish 3). */
function FormPanel({ component }: { component: FormComponent }) {
  const { getIntakeValue, runStatus } = useWorkspace()
  const values = (getIntakeValue(component.id) as Record<string, string> | undefined) ?? {}
  const disabled = runStatus === 'running'

  return (
    <Card className="space-y-4">
      <div>
        <Eyebrow>Details</Eyebrow>
        <h3 className="mt-1 font-semibold tracking-tight text-ink">Job details</h3>
      </div>
      <FormFields component={component} values={values} disabled={disabled} />
      <p className="text-xs text-slate-400">
        <span aria-hidden="true" className="text-accent">
          *
        </span>{' '}
        Required
      </p>
    </Card>
  )
}

/** Inline variant (polish 4): compact in-chat card; submitting posts the answers. */
function FormInline({
  component,
  onSubmitted,
}: {
  component: FormComponent
  onSubmitted?: (summary: string) => void
}) {
  const { getIntakeValue, runStatus } = useWorkspace()
  const values = (getIntakeValue(component.id) as Record<string, string> | undefined) ?? {}
  const disabled = runStatus === 'running'
  const complete = component.fields.every(
    (field) => !field.required || String(values[field.id] ?? '').trim().length > 0,
  )
  const submit = () => {
    if (disabled || !complete || onSubmitted === undefined) return
    onSubmitted(fieldsSummary(component, values))
  }

  return (
    <div className="max-w-[85%] rounded-lg rounded-tl-none border border-slate-100 bg-white p-3 text-sm shadow-sm">
      <p className="font-semibold tracking-tight text-ink">Job details</p>
      <div className="mt-2.5">
        <FormFields component={component} values={values} disabled={disabled} compact onEnter={submit} />
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <p className="text-[10px] text-slate-400">
          <span aria-hidden="true" className="text-accent">
            *
          </span>{' '}
          Required
        </p>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !complete}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:opacity-40"
        >
          {runStatus === 'running' && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
          <Send size={12} aria-hidden="true" />
          Send
        </button>
      </div>
    </div>
  )
}

export default function Form({ component, variant, onSubmitted }: IntakeComponentViewProps) {
  if (variant === 'inline') {
    return <FormInline component={component as FormComponent} onSubmitted={onSubmitted} />
  }
  return <FormPanel component={component as FormComponent} />
}
