// Registry entry for intake component type "file_upload". Panel variant
// (polish 3): drag-and-drop zone, file chips with name/size/thumbnail and
// remove control, spec instructions inline — files land in the workspace
// intake state. Inline variant (polish 4): the spec component renders as a
// compact card inside the chat flow with NO standalone drop zone — its
// "Add" button feeds the chat's shared attachment tray (files are handed to
// the chat via onFiles, tagged with the component id, and the tray drop zone
// is the chat panel itself). Upload happens on send, as before.

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { FileText, Paperclip, Upload, X } from 'lucide-react'

import type { IntakeComponent } from '@/engine/types'
import type { IntakeComponentViewProps } from '@/engine/registry'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, Eyebrow } from '@/components/ui/Primitives'
import SpecText from '@/components/SpecText'
import { useWorkspace } from '@/state/workspace'

function matchesAccept(file: File, accept: string[]): boolean {
  return accept.some((pattern) => {
    if (pattern.endsWith('/*')) return file.type.startsWith(pattern.slice(0, -1))
    return file.type === pattern || file.name.toLowerCase().endsWith(pattern.toLowerCase())
  })
}

function FileChip({
  file,
  uploading,
  onRemove,
}: {
  file: File
  uploading: boolean
  onRemove: () => void
}) {
  const isImage = file.type.startsWith('image/')
  const [url] = useState(() => (isImage ? URL.createObjectURL(file) : null))
  useEffect(() => () => {
    if (url !== null) URL.revokeObjectURL(url)
  }, [url])

  return (
    <li className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5">
      {url !== null ? (
        <img src={url} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-400">
          <FileText size={18} aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{file.name}</span>
        <span className="text-xs text-slate-400">
          {uploading ? 'Uploading…' : formatBytes(file.size)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={uploading}
        aria-label={`Remove ${file.name}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </li>
  )
}

export type FileUploadComponent = Extract<IntakeComponent, { type: 'file_upload' }>

/** Panel variant: standalone upload card with its own drop zone (polish 3). */
function FileUploadPanel({ component }: { component: FileUploadComponent }) {
  const { getIntakeValue, setIntakeValue, runStatus } = useWorkspace()
  const files = (getIntakeValue(component.id) as File[] | undefined) ?? []
  const [dragging, setDragging] = useState(false)
  const [uploadingNames, setUploadingNames] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const disabled = runStatus === 'running'

  const addFiles = (incoming: FileList | File[]) => {
    const accepted = Array.from(incoming).filter((file) => matchesAccept(file, component.accept))
    if (accepted.length === 0) return
    setIntakeValue(component.id, component.multiple ? [...files, ...accepted] : accepted.slice(0, 1))
    const names = new Set(accepted.map((file) => `${file.name}:${file.size}`))
    setUploadingNames((previous) => {
      const next = new Set(previous)
      for (const name of names) next.add(name)
      return next
    })
    window.setTimeout(() => {
      setUploadingNames((previous) => {
        const next = new Set(previous)
        for (const name of names) next.delete(name)
        return next
      })
    }, 800)
  }

  const removeFile = (target: File) => {
    setIntakeValue(
      component.id,
      files.filter((file) => file !== target),
    )
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!disabled) addFiles(event.dataTransfer.files)
  }

  return (
    <Card className="space-y-4">
      <div>
        <Eyebrow>Upload</Eyebrow>
        <h3 className="mt-1 font-semibold tracking-tight text-ink"><SpecText value={component.label} /></h3>
      </div>

      {files.length === 0 ? (
        <p className="text-sm text-slate-400">No files uploaded yet.</p>
      ) : (
        <ul className="space-y-2">
          {files.map((file) => (
            <FileChip
              key={`${file.name}:${file.size}:${file.lastModified}`}
              file={file}
              uploading={uploadingNames.has(`${file.name}:${file.size}`)}
              onRemove={() => removeFile(file)}
            />
          ))}
        </ul>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-xl border-2 border-dashed p-6 text-center transition-colors',
          dragging ? 'border-accent bg-accent-tint' : 'border-slate-200 bg-slate-50',
          disabled && 'opacity-50',
        )}
      >
        <Upload size={20} aria-hidden="true" className="mx-auto text-slate-400" />
        <p className="mt-2 text-sm text-slate-600">
          Drag and drop {component.multiple ? 'files' : 'a file'} here, or{' '}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            className="font-semibold text-accent underline-offset-2 hover:underline disabled:opacity-50"
          >
            browse
          </button>
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Accepted: {component.accept.join(', ')}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={component.accept.join(',')}
          multiple={component.multiple}
          className="hidden"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>

      <p className="text-sm leading-relaxed text-slate-600"><SpecText value={component.instructions} /></p>
    </Card>
  )
}

/**
 * Inline variant (polish 4): compact in-chat attachment card. No drop zone —
 * files drop anywhere on the chat panel; this card's control feeds the same
 * attachment tray as the composer's paperclip, via onFiles.
 */
function FileUploadInline({
  component,
  onFiles,
}: {
  component: FileUploadComponent
  onFiles?: (files: File[], sourceId: string) => void
}) {
  const { runStatus } = useWorkspace()
  const inputRef = useRef<HTMLInputElement>(null)
  const disabled = runStatus === 'running'

  const addFiles = (incoming: FileList | File[]) => {
    if (onFiles === undefined) return
    const accepted = Array.from(incoming).filter((file) => matchesAccept(file, component.accept))
    if (accepted.length === 0) return
    onFiles(component.multiple ? accepted : accepted.slice(0, 1), component.id)
  }

  return (
    <div className="max-w-[85%] rounded-lg rounded-tl-none border border-slate-100 bg-white p-3 text-sm shadow-sm">
      <p className="font-semibold tracking-tight text-ink"><SpecText value={component.label} /></p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500"><SpecText value={component.instructions} /></p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-white px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent-tint disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Paperclip size={13} aria-hidden="true" />
          Add {component.multiple ? 'files' : 'a file'}
        </button>
        <span className="text-xs text-slate-400">{component.accept.join(', ')}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={component.accept.join(',')}
        multiple={component.multiple}
        className="hidden"
        onChange={(event) => {
          if (event.target.files !== null) addFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}

export default function FileUpload({
  component,
  variant,
  onFiles,
}: IntakeComponentViewProps) {
  if (variant === 'inline') {
    return <FileUploadInline component={component as FileUploadComponent} onFiles={onFiles} />
  }
  return <FileUploadPanel component={component as FileUploadComponent} />
}
