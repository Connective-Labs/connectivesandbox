// Registry entry for dashboard panel type "thread_preview" (module wave 1):
// the read-only joined view the corpus kept asking for — the photo, the
// clarifying question, the answer, and the quote all in ONE conversation.
// Entries are joined from named sources in the spec: `photo_slot_key` (intake
// state), `follow_up_judge_id` and `quote_judge_id` (decisions ledger). Only
// sources that produced something render; if nothing has, the card shows its
// empty state. Chat-style mini transcript, never editable.

import type { DashboardPanel } from '@/engine/types'
import { formatAnswerValue, formatTime } from '@/lib/format'
import { useWorkspace } from '@/state/workspace'

export type ThreadPreviewPanel = Extract<DashboardPanel, { type: 'thread_preview' }>

interface ThreadEntry {
  key: string
  side: 'customer' | 'connective'
  text: string
  thumbUrl?: string
  quote?: boolean
  at?: string
}

export default function ThreadPreview({ panel }: { panel: ThreadPreviewPanel }) {
  const { decisions, getIntakeValue } = useWorkspace()

  const entries: ThreadEntry[] = []

  const slotValue = panel.photo_slot_key !== undefined ? getIntakeValue(panel.photo_slot_key) : undefined
  if (Array.isArray(slotValue) && slotValue.length > 0) {
    const count = slotValue.length
    const firstImage = slotValue.find((file) => file instanceof File && file.type.startsWith('image/'))
    entries.push({
      key: 'photo',
      side: 'customer',
      text: `Photo — ${count} ${count === 1 ? 'file' : 'files'} attached`,
      // Object URL for the mini thumb; lives for the session like sent chat
      // images, never a base64 blob in the flow.
      thumbUrl:
        firstImage instanceof File && firstImage.type.startsWith('image/')
          ? URL.createObjectURL(firstImage)
          : undefined,
    })
  }

  const followUp =
    panel.follow_up_judge_id !== undefined
      ? decisions.find((row) => row.judge_id === panel.follow_up_judge_id)
      : undefined
  if (followUp !== undefined) {
    entries.push({
      key: 'follow-up-q',
      side: 'connective',
      text: followUp.question,
      at: followUp.created_at,
    })
    entries.push({
      key: 'follow-up-a',
      side: 'customer',
      text: formatAnswerValue(followUp.answer),
      at: followUp.created_at,
    })
  }

  const quote =
    panel.quote_judge_id !== undefined
      ? decisions.find((row) => row.judge_id === panel.quote_judge_id)
      : undefined
  if (quote !== undefined) {
    entries.push({
      key: 'quote',
      side: 'connective',
      text: `Quoted: ${formatAnswerValue(quote.answer)}`,
      quote: true,
      at: quote.created_at,
    })
  }

  return (
    <div className="space-y-3">
      <h3 className="font-semibold tracking-tight text-ink">{panel.title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">
          Nothing to join yet — send a photo and run the workflow; the thread assembles here.
        </p>
      ) : (
        <div className="flex max-w-xl flex-col gap-2.5">
          {entries.map((entry) => (
            <div key={entry.key} className={`flex ${entry.side === 'customer' ? 'justify-end' : ''}`}>
              <div
                className={[
                  'max-w-[85%] rounded-xl px-3.5 py-2 text-sm',
                  entry.side === 'customer'
                    ? 'bg-ink text-white'
                    : entry.quote
                      ? 'border border-accent/30 bg-accent-wash text-ink'
                      : 'bg-slate-100 text-ink',
                ].join(' ')}
              >
                {entry.at !== undefined && (
                  <span
                    className={`mb-0.5 block text-[11px] font-semibold ${entry.side === 'customer' ? 'text-slate-300' : 'text-slate-500'}`}
                  >
                    {entry.side === 'customer' ? 'Customer' : 'Connective'} · {formatTime(entry.at)}
                  </span>
                )}
                <span className="break-words [overflow-wrap:anywhere]">{entry.text}</span>
                {entry.thumbUrl !== undefined && (
                  <img
                    src={entry.thumbUrl}
                    alt="Customer photo"
                    className="mt-1.5 h-14 w-14 rounded-md object-cover"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
