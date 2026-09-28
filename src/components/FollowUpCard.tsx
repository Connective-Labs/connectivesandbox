// Registry entry for intake component type "follow_up_card" (module wave 1):
// the pre-authored clarification picker — ONE question with choice chips
// (plus optional short text) and a Send control. A submission posts a
// summarised message through the same send path as every other inline card
// and collapses to a compact sent chip (Chat owns the collapse). The chosen
// value lands in the workspace intake state under the component id.

import { useState } from 'react'
import { Send } from 'lucide-react'

import type { IntakeComponent } from '@/engine/types'
import type { IntakeComponentViewProps } from '@/engine/registry'
import { cn } from '@/lib/utils'
import { Card, Eyebrow } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type FollowUpCardComponent = Extract<IntakeComponent, { type: 'follow_up_card' }>

function summaryFor(component: FollowUpCardComponent, value: string): string {
  const label = component.options.find((option) => option.value === value)?.label
  const answer = label ?? value
  return `${component.question} → ${answer}`
}

/** Panel variant: standalone clarification card. */
function FollowUpCardPanel({ component }: { component: FollowUpCardComponent }) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const disabled = runStatus === 'running'
  const selected = typeof getIntakeValue(component.id) === 'string' ? (getIntakeValue(component.id) as string) : undefined
  const [text, setText] = useState('')

  const send = () => {
    if (disabled) return
    const value = text.trim().length > 0 ? text.trim() : selected
    if (value === undefined || value === '') return
    setIntakeValue(component.id, value)
    setText('')
  }

  return (
    <Card className="space-y-4">
      <div>
        <Eyebrow>Follow-up</Eyebrow>
        <h3 className="mt-1 font-semibold tracking-tight text-ink">{component.label}</h3>
      </div>
      <p className="text-sm font-medium text-ink">{component.question}</p>
      <div role="group" aria-label={component.question} className="flex flex-wrap gap-1.5">
        {component.options.map((option) => {
          const active = selected === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setIntakeValue(component.id, active ? undefined : option.value)}
              disabled={disabled}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'border-ink bg-ink text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-ink hover:text-ink',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {component.allow_text && (
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          placeholder="Or type your own answer…"
          aria-label={`Own answer for ${component.question}`}
          className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
        />
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={send}
          disabled={disabled || (selected === undefined && text.trim().length === 0)}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={12} aria-hidden="true" />
          Send ask
        </button>
      </div>
    </Card>
  )
}

/** Inline variant: compact in-chat clarification card; Send posts the flow. */
function FollowUpCardInline({
  component,
  onSubmitted,
}: {
  component: FollowUpCardComponent
  onSubmitted?: (summary: string) => void
}) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const disabled = runStatus === 'running'
  const selected = typeof getIntakeValue(component.id) === 'string' ? (getIntakeValue(component.id) as string) : undefined
  const [text, setText] = useState('')

  const send = () => {
    if (disabled) return
    const value = text.trim().length > 0 ? text.trim() : selected
    if (value === undefined || value === '') return
    setIntakeValue(component.id, value)
    onSubmitted?.(summaryFor(component, value))
  }

  return (
    <div className="max-w-[85%] rounded-lg rounded-tl-none border border-slate-100 bg-white p-3 text-sm shadow-sm">
      <p className="font-semibold tracking-tight text-ink">{component.question}</p>
      <div role="group" aria-label={component.question} className="mt-2.5 flex flex-wrap gap-1">
        {component.options.map((option) => {
          const active = selected === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setText('')
                setIntakeValue(component.id, active ? undefined : option.value)
              }}
              disabled={disabled}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-ink bg-ink text-white shadow-sm'
                  : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-ink hover:text-ink',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {component.allow_text && (
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          placeholder="Or type your own answer…"
          aria-label={`Own answer for ${component.question}`}
          className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-ink placeholder:text-slate-400 focus:border-accent focus:outline-none"
        />
      )}
      <div className="mt-2.5 flex justify-end">
        <button
          type="button"
          onClick={send}
          disabled={disabled || (selected === undefined && text.trim().length === 0)}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send size={12} aria-hidden="true" />
          Send ask
        </button>
      </div>
    </div>
  )
}

export default function FollowUpCard({ component, variant, onSubmitted }: IntakeComponentViewProps) {
  if (variant === 'inline') {
    return <FollowUpCardInline component={component as FollowUpCardComponent} onSubmitted={onSubmitted} />
  }
  return <FollowUpCardPanel component={component as FollowUpCardComponent} />
}
