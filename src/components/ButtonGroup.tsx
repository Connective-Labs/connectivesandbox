// Registry entry for intake component type "button_group": segmented control
// with single- and multi-select modes. Selection lands in the workspace
// intake state as a string (single) or string[] (multi). Inline variant
// (polish 4): compact card inside the chat flow — a tap on a single-select
// option posts it immediately; multi-select posts via a Send control.

import type { IntakeComponent } from '@/engine/types'
import type { IntakeComponentViewProps } from '@/engine/registry'
import { cn } from '@/lib/utils'
import { Card, Eyebrow } from '@/components/ui/Primitives'
import SpecText from '@/components/SpecText'
import { useWorkspace } from '@/state/workspace'

export type ButtonGroupComponent = Extract<IntakeComponent, { type: 'button_group' }>

/** Panel variant: standalone options card (polish 3). */
function ButtonGroupPanel({ component }: { component: ButtonGroupComponent }) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const disabled = runStatus === 'running'
  const selected = getIntakeValue(component.id)

  const isSelected = (value: string): boolean => {
    if (component.multi) return Array.isArray(selected) && selected.includes(value)
    return selected === value
  }

  const toggle = (value: string) => {
    if (disabled) return
    if (component.multi) {
      const current = Array.isArray(selected) ? selected : []
      setIntakeValue(
        component.id,
        current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
      )
    } else {
      setIntakeValue(component.id, selected === value ? undefined : value)
    }
  }

  return (
    <Card className="space-y-4">
      <div>
        <Eyebrow>Select</Eyebrow>
        <h3 className="mt-1 font-semibold tracking-tight text-ink"><SpecText value={component.label} /></h3>
      </div>
      <div
        role="group"
        aria-label={component.label}
        className="flex flex-wrap gap-1 rounded-full border border-slate-200 bg-slate-50 p-1"
      >
        {component.options.map((option) => {
          const active = isSelected(option.value)
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              disabled={disabled}
              aria-pressed={active}
              className={cn(
                'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-slate-600 hover:bg-white hover:text-ink',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-sm text-slate-400">
        {component.multi ? 'Select every option that applies.' : 'Select one option.'}
      </p>
    </Card>
  )
}

/** Inline variant (polish 4): compact in-chat card; a selection posts into the flow. */
function ButtonGroupInline({
  component,
  onSubmitted,
}: {
  component: ButtonGroupComponent
  onSubmitted?: (summary: string) => void
}) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const disabled = runStatus === 'running'
  const selected = getIntakeValue(component.id)

  const labelFor = (value: string): string =>
    component.options.find((option) => option.value === value)?.label ?? value

  const isSelected = (value: string): boolean => {
    if (component.multi) return Array.isArray(selected) && selected.includes(value)
    return selected === value
  }

  const toggle = (value: string) => {
    if (disabled) return
    if (component.multi) {
      const current = Array.isArray(selected) ? selected : []
      setIntakeValue(
        component.id,
        current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
      )
    } else {
      setIntakeValue(component.id, value)
      // Single-select quick reply: the tap posts into the flow immediately.
      onSubmitted?.(labelFor(value))
    }
  }

  const multiSummary = (): string => {
    const current = Array.isArray(selected) ? selected : []
    return current.map(labelFor).join(', ')
  }

  return (
    <div className="max-w-[85%] rounded-lg rounded-tl-none border border-slate-100 bg-white p-3 text-sm shadow-sm">
      <p className="font-semibold tracking-tight text-ink"><SpecText value={component.label} /></p>
      <div
        role="group"
        aria-label={component.label}
        className="mt-2.5 flex flex-wrap gap-1"
      >
        {component.options.map((option) => {
          const active = isSelected(option.value)
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              disabled={disabled}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-accent bg-accent text-white shadow-sm'
                  : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-accent hover:text-accent',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {component.multi && Array.isArray(selected) && selected.length > 0 && (
        <div className="mt-2.5 flex justify-end">
          <button
            type="button"
            onClick={() => onSubmitted?.(multiSummary())}
            disabled={disabled}
            className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send {selected.length} {selected.length === 1 ? 'selection' : 'selections'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function ButtonGroup({ component, variant, onSubmitted }: IntakeComponentViewProps) {
  if (variant === 'inline') {
    return <ButtonGroupInline component={component as ButtonGroupComponent} onSubmitted={onSubmitted} />
  }
  return <ButtonGroupPanel component={component as ButtonGroupComponent} />
}
