// Registry entry for intake component type "text_field": single-line input or
// multiline textarea. Value lands in the workspace intake state as a string.
// Inline variant (polish 4): compact card inside the chat flow — submitting
// posts the answer into the flow like a message via onSubmitted.

import { Send } from 'lucide-react'

import type { IntakeComponent } from '@/engine/types'
import type { IntakeComponentViewProps } from '@/engine/registry'
import { Card, Eyebrow } from '@/components/ui/Primitives'
import SpecText from '@/components/SpecText'
import { useWorkspace } from '@/state/workspace'

export type TextFieldComponent = Extract<IntakeComponent, { type: 'text_field' }>

/** Panel variant: standalone input card (polish 3). */
function TextFieldPanel({ component }: { component: TextFieldComponent }) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const value = (getIntakeValue(component.id) as string | undefined) ?? ''
  const disabled = runStatus === 'running'

  return (
    <Card className="space-y-4">
      <div>
        <Eyebrow>Input</Eyebrow>
        <h3 className="mt-1 font-semibold tracking-tight text-ink"><SpecText value={component.label} /></h3>
      </div>
      {component.multiline ? (
        <textarea
          value={value}
          onChange={(event) => setIntakeValue(component.id, event.target.value)}
          disabled={disabled}
          rows={4}
          placeholder="Type here…"
          aria-label={component.label}
          className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
        />
      ) : (
        <input
          value={value}
          onChange={(event) => setIntakeValue(component.id, event.target.value)}
          disabled={disabled}
          placeholder="Type here…"
          aria-label={component.label}
          className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
        />
      )}
    </Card>
  )
}

/** Inline variant (polish 4): compact in-chat card; submitting posts the answer. */
function TextFieldInline({
  component,
  onSubmitted,
}: {
  component: TextFieldComponent
  onSubmitted?: (summary: string) => void
}) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const value = (getIntakeValue(component.id) as string | undefined) ?? ''
  const disabled = runStatus === 'running'
  const canSubmit = value.trim().length > 0 && !disabled

  const submit = () => {
    if (!canSubmit || onSubmitted === undefined) return
    onSubmitted(value.trim())
  }

  return (
    <div className="max-w-[85%] rounded-lg rounded-tl-none border border-slate-100 bg-white p-3 text-sm shadow-sm">
      <p className="font-semibold tracking-tight text-ink"><SpecText value={component.label} /></p>
      <div className="mt-2 flex items-end gap-2">
        {component.multiline ? (
          <textarea
            value={value}
            onChange={(event) => setIntakeValue(component.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
            }}
            disabled={disabled}
            rows={2}
            placeholder="Type here…"
            aria-label={component.label}
            className="min-w-0 flex-1 resize-y rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm leading-relaxed text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
          />
        ) : (
          <input
            value={value}
            onChange={(event) => setIntakeValue(component.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
            disabled={disabled}
            placeholder="Type here…"
            aria-label={component.label}
            className="min-w-0 flex-1 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none disabled:opacity-50"
          />
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          aria-label={`Send ${component.label}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition enabled:border-accent enabled:bg-accent enabled:text-white enabled:hover:bg-accent-hover enabled:active:bg-accent-pressed disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-white disabled:text-slate-400 disabled:opacity-40"
        >
          <Send size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export default function TextField({ component, variant, onSubmitted }: IntakeComponentViewProps) {
  if (variant === 'inline') {
    return <TextFieldInline component={component as TextFieldComponent} onSubmitted={onSubmitted} />
  }
  return <TextFieldPanel component={component as TextFieldComponent} />
}
