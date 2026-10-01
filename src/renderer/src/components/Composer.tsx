import { ArrowDownToLine, ClipboardPaste, Film, FolderOpen, Link2, Music } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { AudioFormat, Mode, Settings, VideoFormat } from '@shared/types'
import { folderName } from '../format'
import { useI18n } from '../i18n'
import { api } from '../store'
import { FormatPicker } from './FormatPicker'

export interface ComposerHandle {
  setUrl: (url: string) => void
}

const isUrl = (s: string): boolean => /^https?:\/\/\S+\.\S+/i.test(s.trim()) || /^https?:\/\/localhost|127\.0\.0\.1/i.test(s.trim())

export const Composer = forwardRef<ComposerHandle, { settings: Settings }>(function Composer({ settings }, ref) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    setUrl: (u: string) => {
      setUrl(u)
      setError(null)
      input.current?.focus()
    }
  }))

  const mode = settings.mode
  const format = mode === 'video' ? settings.videoFormat : settings.audioFormat
  const remember = (patch: Partial<Settings>): void => void api().updateSettings(patch)

  const submit = async (): Promise<void> => {
    const value = url.trim()
    if (!value) return
    if (!isUrl(value)) {
      setError(t('url.invalid'))
      return
    }
    setBusy(true)
    try {
      await api().addDownload(value, {
        mode,
        videoFormat: settings.videoFormat,
        audioFormat: settings.audioFormat,
        folder: settings.folder
      })
      setUrl('')
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  const paste = async (): Promise<void> => {
    const found = await api().readClipboardUrl()
    if (found) {
      setUrl(found)
      setError(null)
    }
    input.current?.focus()
  }

  const chooseFolder = async (): Promise<void> => {
    const folder = await api().chooseFolder()
    if (folder) remember({ folder })
  }

  return (
    <section className="composer" aria-label="Nuovo download">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="url-field">
          <Link2 size={19} />
          <input
            ref={input}
            className="url-input"
            type="url"
            inputMode="url"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={t('url.placeholder')}
            value={url}
            aria-invalid={!!error}
            aria-label={t('url.placeholder')}
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            data-testid="url-input"
          />
          <button type="button" className="btn btn-sm paste-btn" onClick={() => void paste()}>
            <ClipboardPaste size={15} />
            {t('url.paste')}
          </button>
        </div>
        {error && (
          <p className="url-error" role="alert">
            {error}
          </p>
        )}
        <div className="composer-row">
          <div className="segmented" role="group" aria-label="Modalità">
            <button type="button" aria-pressed={mode === 'video'} onClick={() => remember({ mode: 'video' as Mode })} data-testid="mode-video">
              <Film size={15} />
              {t('mode.video')}
            </button>
            <button type="button" aria-pressed={mode === 'audio'} onClick={() => remember({ mode: 'audio' as Mode })} data-testid="mode-audio">
              <Music size={15} />
              {t('mode.audio')}
            </button>
          </div>
          <FormatPicker
            mode={mode}
            value={format}
            onChange={(f) => remember(mode === 'video' ? { videoFormat: f as VideoFormat } : { audioFormat: f as AudioFormat })}
          />
          <button type="button" className="chip" title={settings.folder} onClick={() => void chooseFolder()} data-testid="folder-picker">
            <FolderOpen size={16} />
            <span className="chip-label">{folderName(settings.folder)}</span>
          </button>
          <span className="spacer" />
          <button type="submit" className="btn btn-primary btn-lg" disabled={!url.trim() || busy} data-testid="download-button">
            <ArrowDownToLine size={18} strokeWidth={2.4} />
            {t('action.download')}
          </button>
        </div>
      </form>
    </section>
  )
})
