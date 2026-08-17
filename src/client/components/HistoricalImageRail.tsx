import { useRef, useState } from 'react'
import { ImageOff, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { RenderablePart } from './chat-message-adapter'

type HistoricalImage = Extract<RenderablePart, { type: 'image' }>

function imageUrl(image: HistoricalImage): string | undefined {
  if (image.source.type === 'base64') {
    return `data:${image.mediaType};base64,${image.source.data}`
  }
  if (image.source.type === 'url') return image.source.url
  return undefined
}

export default function HistoricalImageRail({ images }: { images: HistoricalImage[] }) {
  const { t } = useTranslation('chat')
  const [preview, setPreview] = useState<HistoricalImage | null>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)

  const closePreview = () => {
    setPreview(null)
    requestAnimationFrame(() => previewTriggerRef.current?.focus())
  }

  return (
    <>
      <div
        data-testid="historical-image-rail"
        className="flex max-w-full flex-nowrap gap-2 overflow-x-auto py-1"
        aria-label={t('imageInput.attachments')}
      >
        {images.map((image, index) => {
          const src = imageUrl(image)
          const name = image.name ?? `${t('imageInput.image')} ${index + 1}`
          if (!src) {
            return (
              <div
                key={`${image.sourcePartIndex ?? index}-unavailable`}
                role="status"
                aria-label={name}
                className="flex h-20 w-24 flex-none flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-surface px-2 text-center text-xs text-text-tertiary"
              >
                <ImageOff className="h-5 w-5" aria-hidden="true" />
                <span>{image.source.type === 'unavailable' && image.source.reason
                  ? image.source.reason
                  : t('imageInput.unavailable')}</span>
              </div>
            )
          }
          return (
            <button
              key={`${image.sourcePartIndex ?? index}-${src}`}
              type="button"
              aria-label={t('imageInput.preview', { name })}
              onClick={(event) => {
                previewTriggerRef.current = event.currentTarget
                setPreview(image)
              }}
              className="h-20 w-24 flex-none overflow-hidden rounded-lg border border-border bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <img src={src} alt="" className="h-full w-full object-cover" />
            </button>
          )
        })}
      </div>
      {preview && imageUrl(preview) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={preview.name ?? t('imageInput.previewTitle')}
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
            src={imageUrl(preview)}
            alt={preview.name ?? t('imageInput.previewTitle')}
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
    </>
  )
}
