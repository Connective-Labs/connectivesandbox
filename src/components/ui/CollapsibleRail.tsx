// Collapsible sidebar rail: collapsed to a slim icon column by default,
// expands on hover as an overlay flyout (no reflow push), click pins it open
// in-flow. Open/close animate with framer-motion (width/opacity/translate,
// ease-out) under a MotionConfig reducedMotion="user" guard; a small close
// delay stops accidental mouse exits from slamming the flyout shut. The pin
// button is the keyboard/tap toggle — nothing depends on hover alone.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Pin, PinOff } from 'lucide-react'

import { cn } from '@/lib/utils'

export const RAIL_W = 56

const FLYOUT_TRANSITION = { duration: 0.18, ease: 'easeOut' as const }

export function CollapsibleRail({
  width,
  label,
  rail,
  children,
  className,
  pinned: pinnedProp,
  onPinnedChange,
}: {
  width: number
  label: string
  rail: ReactNode
  children: ReactNode
  className?: string
  /** Controlled pin state — pass together with onPinnedChange. */
  pinned?: boolean
  onPinnedChange?: (pinned: boolean) => void
}) {
  const [internalPinned, setInternalPinned] = useState(false)
  const pinned = pinnedProp ?? internalPinned
  const setPinned = (value: boolean) => {
    setInternalPinned(value)
    onPinnedChange?.(value)
  }
  const [hovered, setHovered] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const hoveredRef = useRef(false)

  const openHover = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    hoveredRef.current = true
    setHovered(true)
  }

  const closeHover = () => {
    hoveredRef.current = false
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    // Small delay: brushing past the rail edge must not slam the flyout shut.
    closeTimer.current = window.setTimeout(() => {
      if (!hoveredRef.current) setHovered(false)
      closeTimer.current = null
    }, 160)
  }

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  const open = pinned || hovered

  return (
    <motion.div
      className={cn('relative shrink-0', className)}
      animate={{ width: pinned ? width : RAIL_W }}
      transition={FLYOUT_TRANSITION}
      onMouseEnter={openHover}
      onMouseLeave={closeHover}
    >
      {/* Icon rail: always mounted underneath so hover-in never flickers. */}
      <div className={cn('flex h-full flex-col items-center justify-between py-3', open && 'invisible')}>
        <div className="flex flex-col items-center gap-2">{rail}</div>
        <button
          type="button"
          onClick={() => setPinned(true)}
          aria-label={`Pin ${label} open`}
          aria-expanded={false}
          title={`Pin ${label} open`}
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-white hover:text-accent"
        >
          <Pin size={16} aria-hidden="true" />
        </button>
      </div>

      {/* Pinned panel: in-flow, container width animates around it. */}
      {pinned && (
        <motion.div
          className="absolute inset-y-0 left-0 z-30 flex h-full flex-col overflow-hidden border-r border-slate-200 bg-slate-50"
          style={{ width }}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={FLYOUT_TRANSITION}
        >
          {children}
          <button
            type="button"
            onClick={() => setPinned(false)}
            aria-label={`Collapse ${label}`}
            aria-expanded={true}
            title={`Collapse ${label}`}
            className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-slate-50/90 text-slate-400 transition hover:bg-white hover:text-accent"
          >
            <PinOff size={16} aria-hidden="true" />
          </button>
        </motion.div>
      )}

      {/* Hover flyout: overlay, fades/slides in over the icon rail. */}
      <AnimatePresence>
        {hovered && !pinned && (
          <motion.div
            key="flyout"
            className="absolute inset-y-0 left-0 z-30 flex h-full flex-col overflow-hidden border-r border-slate-200 bg-slate-50 shadow-lg"
            style={{ width }}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={FLYOUT_TRANSITION}
          >
            {children}
            <button
              type="button"
              onClick={() => {
                setPinned(false)
                setHovered(false)
              }}
              aria-label={`Pin ${label} open`}
              aria-expanded={true}
              title={`Pin ${label} open`}
              className="absolute bottom-2 right-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-slate-50/90 text-slate-400 transition hover:bg-white hover:text-accent"
            >
              <Pin size={16} aria-hidden="true" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
