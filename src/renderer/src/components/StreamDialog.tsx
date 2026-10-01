import { AudioLines, Film, Radio, ShieldAlert } from 'lucide-react'
import type { Job, SniffResult, StreamCandidate } from '@shared/types'
import { formatBytes, formatDuration, hostOf } from '../format'
import { useI18n } from '../i18n'
import { api } from '../store'
import { Modal } from './Modal'

function describe(c: StreamCandidate): string {
  const parts: string[] = [c.kind === 'progressive' ? (c.mime?.split('/')[1] ?? 'video').toUpperCase() : c.kind.toUpperCase()]
  if (c.height) parts.push(`${c.height}p`)
  return parts.join(' · ')
}

export function StreamDialog({ job, sniff, onClose }: { job: Job; sniff: SniffResult; onClose: () => void }): React.JSX.Element {
  const { t, locale } = useI18n()
  const choose = (id: string): void => {
    void api().chooseStream(job.id, id)
    onClose()
  }
  return (
    <Modal title={t('stream.title')} subtitle={t('stream.subtitle')} icon={<Film size={20} />} onClose={onClose}>
      <div data-testid="stream-options">
        {sniff.candidates.map((c) => {
          const Icon = c.drm ? ShieldAlert : c.kind === 'audio' ? AudioLines : c.live ? Radio : Film
          return (
            <button key={c.id} className="option" disabled={c.drm} onClick={() => choose(c.id)} title={c.url} style={c.drm ? { opacity: 0.55 } : undefined}>
              <span className="option-icon">
                <Icon size={18} />
              </span>
              <span className="grow">
                <div className="option-title">
                  {describe(c)}
                  {c.duration != null ? ` · ${formatDuration(c.duration)}` : ''}
                  {c.size ? ` · ${formatBytes(c.size, locale)}` : ''}
                </div>
                <div className="option-hint">{hostOf(c.url)}</div>
              </span>
              {sniff.best?.id === c.id && <span className="tag accent">{t('stream.best')}</span>}
              {c.ad && <span className="tag warn">{t('stream.ad')}</span>}
              {c.live && <span className="tag">{t('stream.live')}</span>}
              {c.kind === 'audio' && <span className="tag">{t('stream.audioOnly')}</span>}
              {c.drm && <span className="tag err">{t('stream.drm')}</span>}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
