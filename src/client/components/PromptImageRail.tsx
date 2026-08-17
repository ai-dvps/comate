import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { PromptImageDraft } from '../lib/image-input'

interface PromptImageRailProps {
  images: readonly PromptImageDraft[]
  busy: boolean
  error: string | null
  disabled: boolean
  onRemove: (id: string) => void
  onMove: (fromIndex: number, toIndex: number) => void
}

export default function PromptImageRail({
  images,
  busy,
  error,
  disabled,
  onRemove,
  onMove,
}: PromptImageRailProps) {
  const { t } = useTranslation('chat')
  const [preview, setPreview] = useState<PromptImageDraft | null>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const dragIndexRef = useRef<number | null>(null)

  const closePreview = () => {
    setPreview(null)
    requestAnimationFrame(() => previewTriggerRef.current?.focus())
  }

  useEffect(() => {
    if (preview && !images.some((image) => image.id === preview.id)) {
      closePreview()
    }
  }, [images, preview])

  if (images.length === 0 && !busy && !error) return null

  return (
    <div className="border-b border-border/70 px-3 pt-2">
      {images.length > 0 && (
        <div
          data-testid="prompt-image-rail"
          className="flex flex-nowrap gap-2 overflow-x-auto pb-2"
          aria-label={t('imageInput.attachments')}
        >
          {images.map((image, index) => (
            <div
              key={image.id}
              data-testid={`prompt-image-${image.id}`}
              draggable={!disabled}
              onDragStart={(event) => {
                dragIndexRef.current = index
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', String(index))
              }}
              onDragEnd={() => {
                dragIndexRef.current = null
              }}
              onDragOver={(event) => {
                if (!disabled) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (disabled) return
                const from = dragIndexRef.current ?? Number(event.dataTransfer.getData('text/plain'))
                dragIndexRef.current = null
                if (Number.isInteger(from) && from !== index) onMove(from, index)
              }}
              className="group relative flex h-20 w-24 flex-none items-center justify-center overflow-hidden rounded-lg border border-border bg-surface"
            >
              <button
                type="button"
                className="h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                aria-label={t('imageInput.preview', { name: image.name })}
                onClick={(event) => {
                  previewTriggerRef.current = event.currentTarget
                  setPreview(image)
                }}
              >
                <img
                  src={image.previewUrl}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover"
                />
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label={t('imageInput.remove', { name: image.name })}
                onClick={() => onRemove(image.id)}
                className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5 text-white opacity-90 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  disabled={disabled || index === 0}
                  aria-label={t('imageInput.moveLeft', { name: image.name })}
                  onClick={() => onMove(index, index - 1)}
                  className="rounded bg-black/65 p-0.5 text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={disabled || index === images.length - 1}
                  aria-label={t('imageInput.moveRight', { name: image.name })}
                  onClick={() => onMove(index, index + 1)}
                  className="rounded bg-black/65 p-0.5 text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {busy && (
        <div role="status" className="flex items-center gap-1.5 pb-2 text-xs text-text-secondary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('imageInput.processing')}
        </div>
      )}
      {error && (
        <div role="alert" className="pb-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={preview.name}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closePreview()
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePreview()
          }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-6 outline-none"
          ref={(element) => element?.focus()}
        >
          <img
            src={preview.previewUrl}
            alt={preview.name}
            className="max-h-full max-w-full object-contain"
          />
          <button
            type="button"
            onClick={closePreview}
            aria-label={t('imageInput.closePreview')}
            className="absolute right-5 top-5 rounded-full bg-black/70 p-2 text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  )
}
