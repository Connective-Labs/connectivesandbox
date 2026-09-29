// "What can I build?" — the in-product capabilities guide (polish 6).
// A collapsible card set in plain Singapore English for the non-technical
// user: the named recipes, the module list grouped as Collect and Show, and
// the short "Good to know" ground rules. The same content (plus current
// limits) lives in docs/capabilities.md — keep the two in step.

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Eyebrow } from '@/components/ui/Primitives'
import { cn } from '@/lib/utils'

interface CapabilityCard {
  heading: string
  blurb: string
  items: { name: string; line: string }[]
}

const RECIPES: { name: string; line: string }[] = [
  { name: 'Photo triage', line: 'Photos in, triage out, human escalation.' },
  { name: 'Document intake review', line: 'Claims and compliance packs, reviewed on arrival.' },
  { name: 'Operations desk', line: 'Tickets and orders on one queue, two buttons.' },
  { name: 'Approval desk', line: 'Applications judged for eligibility and risk.' },
]

const CARDS: CapabilityCard[] = [
  {
    heading: 'Collect',
    blurb: 'How your customers hand over information.',
    items: [
      { name: 'Photos', line: 'Customers upload photos straight from their phone.' },
      { name: 'Forms', line: 'Structured fields for the details you always need.' },
      { name: 'Chat', line: 'A message thread, like WhatsApp, with attachments.' },
      { name: 'Choices', line: 'Taps, not typing — clear options for common answers.' },
    ],
  },
  {
    heading: 'Show',
    blurb: 'What your team sees once the AI has judged a submission.',
    items: [
      { name: 'Verdicts', line: 'One big verdict chip: quotable, needs a visit, and so on.' },
      { name: 'Quotes', line: 'A draft quote with price bands, ready for your check.' },
      { name: 'Queues', line: 'Every job on one sortable list with two clear buttons.' },
      { name: 'Alerts', line: 'What is overdue or going wrong, flagged in one feed.' },
      { name: 'Pipelines', line: 'Where each order stands, from received to done.' },
      { name: 'Meters', line: 'How confident the AI was, next to every decision.' },
    ],
  },
]

const GOOD_TO_KNOW = [
  'Workflows are assembled from approved modules. A brand-new module goes through the engineering backlog first.',
  'Client data stays scoped to that client — one client never sees another’s anything.',
  'Every AI change passes through you (the rep) before it reaches the client. Nothing ships itself.',
  'Live transcription builds as you talk: record the discovery call and the draft takes shape while you speak.',
]

export function CapabilitiesGuide() {
  const [open, setOpen] = useState(false)

  return (
    <section
      aria-label="What can I build"
      className="shrink-0 border-b border-slate-200 bg-slate-50"
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-5 py-2 text-left"
      >
        <span className="text-sm font-semibold text-ink">What can I build?</span>
        <span className="flex items-center gap-1 text-xs font-medium text-slate-500">
          {open ? 'Hide' : 'Show'}
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn('transition-transform duration-200', open && 'rotate-180')}
          />
        </span>
      </button>
      {open && (
        <div className="grid gap-3 px-5 pb-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <Eyebrow>Start from a recipe</Eyebrow>
            <ul className="mt-2 space-y-2">
              {RECIPES.map((recipe) => (
                <li key={recipe.name} className="text-xs leading-relaxed">
                  <span className="font-semibold text-ink">{recipe.name}</span>
                  <span className="text-slate-500"> — {recipe.line}</span>
                </li>
              ))}
            </ul>
          </div>
          {CARDS.map((card) => (
            <div key={card.heading} className="rounded-xl border border-slate-200 bg-white p-4">
              <Eyebrow>{card.heading}</Eyebrow>
              <p className="mt-1 text-xs text-slate-500">{card.blurb}</p>
              <ul className="mt-2 space-y-2">
                {card.items.map((item) => (
                  <li key={item.name} className="text-xs leading-relaxed">
                    <span className="font-semibold text-ink">{item.name}</span>
                    <span className="text-slate-500"> — {item.line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="rounded-xl border border-accent/30 bg-accent-wash p-4 md:col-span-3">
            <Eyebrow>Good to know</Eyebrow>
            <ul className="mt-2 grid gap-2 md:grid-cols-2">
              {GOOD_TO_KNOW.map((line) => (
                <li key={line} className="text-xs leading-relaxed text-slate-600">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
