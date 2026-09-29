// Draft-aware spec text (polish 6, render-first): inside the admin live
// preview, compiled strings that still hold catalogue placeholders render in
// an unmistakable draft style (muted italic, dashed accent underline), and
// every string change — the GLM wording landing in parallel — fades in place.
// Outside a DraftSpecProvider this is a plain span, so client surfaces and
// published workflows are untouched. Motion honours the app-wide
// MotionConfig reducedMotion="user" guard.

import { createContext, useContext, type ReactNode } from 'react'
import { motion } from 'framer-motion'

import { DEFAULT_STRINGS } from '@/engine/catalogue'
import { cn } from '@/lib/utils'

const DraftSpecContext = createContext(false)

/** Marks a preview subtree as draft-rendered (admin live preview only). */
export function DraftSpecProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <DraftSpecContext.Provider value={value}>{children}</DraftSpecContext.Provider>
}

// Every catalogue placeholder string — a compiled string equal to one of
// these is a slot the GLM pass has not filled yet.
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_STRINGS).flatMap((slots) => Object.values(slots)),
)

export function isPlaceholderString(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value)
}

interface SpecTextProps {
  value: string
  className?: string
}

export default function SpecText({ value, className }: SpecTextProps) {
  const draft = useContext(DraftSpecContext)
  if (!draft) return <span className={className}>{value}</span>
  const placeholder = isPlaceholderString(value)
  return (
    <motion.span
      key={value}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={cn(
        className,
        placeholder &&
          'italic text-slate-400 underline decoration-accent/50 decoration-dashed underline-offset-4',
      )}
      title={placeholder ? 'Draft wording — the builder is still writing this' : undefined}
    >
      {value}
    </motion.span>
  )
}
