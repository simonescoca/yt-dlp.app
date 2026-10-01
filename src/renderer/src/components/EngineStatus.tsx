import { CircleAlert, LoaderCircle } from 'lucide-react'
import type { ComponentState } from '@shared/types'
import { useI18n } from '../i18n'
import { api } from '../store'

/** First-run banner while yt-dlp / ffmpeg / Deno are being downloaded (or failed to). */
export function EngineBanner({ components }: { components: ComponentState[] }): React.JSX.Element | null {
  const { t } = useI18n()
  const missing = components.filter((c) => !c.version)
  if (!missing.length) return null
  const failed = missing.some((c) => c.phase === 'error')
  const progress = missing.reduce((a, c) => a + (c.phase === 'downloading' ? (c.progress ?? 0) : c.phase === 'installing' ? 1 : 0), 0) / missing.length
  if (failed) {
    return (
      <div className="banner error" role="alert" data-testid="engine-banner">
        <CircleAlert size={20} />
        <div className="banner-text">
          <div>{t('engine.failed')}</div>
          <div className="banner-hint">{t('engine.failedHint')}</div>
        </div>
        <button className="btn btn-sm" onClick={() => void api().installEngine()}>
          {t('action.retry')}
        </button>
      </div>
    )
  }
  return (
    <div className="banner" role="status" data-testid="engine-banner">
      <LoaderCircle size={20} className="spin" />
      <div className="banner-text">
        <div>{t('engine.preparing')}</div>
        <div className="banner-hint">{t('engine.preparingHint', { percent: `${Math.round(progress * 100)}%` })}</div>
        <div className="progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}

export function Footer({ components }: { components: ComponentState[] }): React.JSX.Element {
  const { t } = useI18n()
  const y = components.find((c) => c.id === 'yt-dlp')
  const busy = components.some((c) => ['checking', 'downloading', 'installing'].includes(c.phase))
  const err = components.some((c) => c.phase === 'error')
  return (
    <footer className="footer" data-testid="footer">
      <span className={`dot${busy ? ' busy' : err ? ' err' : ''}`} />
      {y?.phase === 'downloading' || (y?.phase === 'installing' && y.version) ? t('engine.updating') : y?.version ? t('engine.ready', { version: y.version }) : t('engine.preparing')}
    </footer>
  )
}
