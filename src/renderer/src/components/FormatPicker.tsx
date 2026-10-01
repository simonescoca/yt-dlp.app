import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AUDIO_FORMATS, VIDEO_FORMATS, type AudioFormat, type Mode, type VideoFormat } from '@shared/types'
import { useI18n } from '../i18n'

interface Props {
  mode: Mode
  value: VideoFormat | AudioFormat
  onChange: (v: VideoFormat | AudioFormat) => void
}

export function FormatPicker({ mode, value, onChange }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const formats = mode === 'video' ? VIDEO_FORMATS : AUDIO_FORMATS

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="popover-anchor" ref={ref}>
      <button
        className="chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('format.label')}: ${value.toUpperCase()}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="format-picker"
      >
        <span className="chip-label">{value.toUpperCase()}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="popover" role="menu">
          {formats.map((f) => (
            <button
              key={f}
              role="menuitemradio"
              aria-checked={f === value}
              className="menu-item"
              onClick={() => {
                onChange(f)
                setOpen(false)
              }}
            >
              <span className="menu-title">{f.toUpperCase()}</span>
              <span className="menu-hint">{t(`format.${f}`)}</span>
              {f === value && <Check size={16} className="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
