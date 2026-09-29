// Shared brand primitives: cards, eyebrows, badges, buttons, skeletons,
// sparkline. One place so radii, borders, and the single accent stay
// consistent across the workspace and admin screens.

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentPropsWithoutRef, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * Skeleton discipline (polish 6): a loading skeleton never flashes. The hook
 * holds the skeleton on screen for a minimum dwell (default 300ms) once it
 * has appeared, and swaps to content exactly once when data resolves — no
 * back-and-forth flicker between empty and populated states.
 */
export function useGraceSkeleton(loading: boolean, minimumMs = 300): boolean {
  const shownAtRef = useRef<number | null>(null)
  const [hold, setHold] = useState(loading)

  useEffect(() => {
    if (loading) {
      if (shownAtRef.current === null) shownAtRef.current = Date.now()
      setHold(true)
      return
    }
    if (shownAtRef.current === null) {
      setHold(false)
      return
    }
    const elapsed = Date.now() - shownAtRef.current
    const remaining = Math.max(0, minimumMs - elapsed)
    const timer = window.setTimeout(() => {
      shownAtRef.current = null
      setHold(false)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [loading, minimumMs])

  return hold
}

export function Card({ children, className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div className={cn('rounded-xl border border-slate-200 bg-white p-5 shadow-sm', className)} {...rest}>
      {children}
    </div>
  )
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('text-xs font-semibold uppercase tracking-widest text-slate-400', className)}>
      {children}
    </p>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/80', className)} />
}

type BadgeTone = 'neutral' | 'auto' | 'review' | 'escalated' | 'valid' | 'invalid'

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  auto: 'bg-emerald-50 text-emerald-700',
  review: 'bg-amber-50 text-amber-700',
  escalated: 'bg-red-50 text-red-700',
  valid: 'bg-emerald-50 text-emerald-700',
  invalid: 'bg-red-50 text-red-700',
}

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryButton({ className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:bg-accent-pressed disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export function GhostButton({ className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

/** Horizontal 0-100% meter bar with threshold tick marks. */
export function MeterBar({
  confidence,
  tone,
  review,
  auto,
}: {
  confidence: number
  tone: 'auto' | 'review' | 'escalated'
  review: number
  auto: number
}) {
  const toneClass =
    tone === 'auto' ? 'bg-emerald-500' : tone === 'review' ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="relative h-2 w-full rounded-full bg-slate-100">
      <div
        className={cn('h-2 rounded-full transition-[width] duration-500', toneClass)}
        style={{ width: `${Math.round(confidence * 100)}%` }}
      />
      <span
        aria-hidden="true"
        className="absolute top-[-3px] h-3.5 w-px bg-slate-300"
        style={{ left: `${Math.round(review * 100)}%` }}
      />
      <span
        aria-hidden="true"
        className="absolute top-[-3px] h-3.5 w-px bg-slate-400"
        style={{ left: `${Math.round(auto * 100)}%` }}
      />
    </div>
  )
}

/** Tiny inline SVG sparkline — no chart dependency. */
export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  const width = 96
  const height = 28
  const max = Math.max(...points)
  const min = Math.min(...points)
  const range = max - min || 1
  const step = points.length > 1 ? width / (points.length - 1) : width
  const path = points
    .map((value, index) => {
      const x = index * step
      const y = height - 2 - ((value - min) / range) * (height - 4)
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label="Trend for the last 12 periods"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
