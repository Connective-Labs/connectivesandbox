// Registry entry for intake component type "photo_slot" (module wave 1 —
// Clean Shades flagship): keyed per-item photo capture with a capture hint
// and camera-capable picker, thumbnail grid after pick. Picked files land in
// the workspace intake state under the component's `key` — that is the key
// judges read (`state_from`) — never under the render id. Inline variant:
// the pick button feeds the chat's shared attachment tray tagged with the
// component id; Chat routes the files to the `key` slot on send.

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Camera, Plus, X } from 'lucide-react'

import type { IntakeComponent } from '@/engine/types'
import type { IntakeComponentViewProps } from '@/engine/registry'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, Eyebrow } from '@/components/ui/Primitives'
import { useWorkspace } from '@/state/workspace'

export type PhotoSlotComponent = Extract<IntakeComponent, { type: 'photo_slot' }>

function isImageAccept(accept: string[]): boolean {
  return accept.some((pattern) => pattern.startsWith('image/'))
}

/** Thumbnail with a self-revoking object URL — sent URLs stay alive (Chat). */
function Thumb({ file, onRemove }: { file: File; onRemove?: () => void }) {
  const [url] = useState(() =>
    file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
  )
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url)
    },
    [url],
  )
  return (
    <div className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
      {url !== null ? (
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full items-center justify-center px-1 text-center text-[10px] text-slate-400">
          {file.name}
        </span>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ink/80 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
      <span className="block truncate border-t border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500">
        {formatBytes(file.size)}
      </span>
    </div>
  )
}

/** Panel variant: standalone keyed capture card. */
function PhotoSlotPanel({ component }: { component: PhotoSlotComponent }) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const disabled = runStatus === 'running'

  const files = isFileList(getIntakeValue(component.key)) ? (getIntakeValue(component.key) as File[]) : []

  const setFiles = (next: File[]) => {
    setIntakeValue(component.key, next)
  }

  const addFiles = (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming)
    setFiles([...files, ...accepted])
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!disabled && event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files)
  }

  return (
    <Card className="space-y-4">
      <div>
        <Eyebrow>Photo</Eyebrow>
        <h3 className="mt-1 font-semibold tracking-tight text-ink">
          {component.label}{' '}
          <span
            className={cn(
              'ml-1.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
              files.length > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500',
            )}
          >
            {files.length > 0 ? 'received' : 'awaiting'}
          </span>
        </h3>
        <p className="mt-1 text-sm text-slate-500">{component.capture_hint}</p>
      </div>

      {files.length === 0 ? (
        <p className="text-sm text-slate-400">No photo picked yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2.5">
          {files.map((file) => (
            <Thumb
              key={`${file.name}:${file.size}:${file.lastModified}`}
              file={file}
              onRemove={() => setFiles(files.filter((entry) => entry !== file))}
            />
          ))}
        </div>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-xl border-2 border-dashed p-4 text-center transition-colors',
          dragging ? 'border-accent bg-accent-tint' : 'border-slate-300 bg-slate-50',
          disabled && 'opacity-50',
        )}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="mx-auto flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Camera size={15} aria-hidden="true" />
          Take photo
        </button>
        <p className="mt-2 text-xs text-slate-400">
          or drop an image here · {component.accept.join(', ')}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={component.accept.join(',')}
          // Camera-capable picker: environment camera on mobile devices.
          capture={isImageAccept(component.accept) ? 'environment' : undefined}
          className="hidden"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </Card>
  )
}

/** Inline variant: compact in-chat capture card feeding the attachment tray. */
function PhotoSlotInline({
  component,
  onFiles,
}: {
  component: PhotoSlotComponent
  onFiles?: (files: File[], sourceId: string) => void
}) {
  const { runStatus } = useWorkspace()
  const inputRef = useRef<HTMLInputElement>(null)
  const disabled = runStatus === 'running'
  // Local thumbnails only — the files themselves ride the tray.
  const [picked, setPicked] = useState<File[]>([])

  const addFiles = (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming)
    if (accepted.length === 0 || onFiles === undefined) return
    setPicked((previous) => [...previous, ...accepted])
    onFiles(accepted, component.id)
  }

  return (
    <div className="max-w-[85%] rounded-lg rounded-tl-none border border-slate-100 bg-white p-3 text-sm shadow-sm">
      <p className="font-semibold tracking-tight text-ink">{component.label}</p>
      <p className="mt-0.5 text-xs text-slate-500">{component.capture_hint}</p>
      {picked.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {picked.map((file) => (
            <Thumb key={`${file.name}:${file.size}:${file.lastModified}`} file={file} />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Plus size={13} aria-hidden="true" />
        {picked.length > 0 ? 'Add another' : 'Take photo'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={component.accept.join(',')}
        capture={isImageAccept(component.accept) ? 'environment' : undefined}
        className="hidden"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}

function isFileList(value: unknown): value is File[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => entry instanceof File)
}

export default function PhotoSlot({ component, variant, onFiles }: IntakeComponentViewProps) {
  if (variant === 'inline') {
    return <PhotoSlotInline component={component as PhotoSlotComponent} onFiles={onFiles} />
  }
  return <PhotoSlotPanel component={component as PhotoSlotComponent} />
}
