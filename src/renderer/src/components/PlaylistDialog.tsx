import { Film, ListChecks, ListVideo } from 'lucide-react'
import { useState } from 'react'
import type { Job, PlaylistSummary } from '@shared/types'
import { formatDuration } from '../format'
import { useI18n } from '../i18n'
import { api } from '../store'
import { Modal } from './Modal'

export function PlaylistDialog({ job, playlist, onClose }: { job: Job; playlist: PlaylistSummary; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [picking, setPicking] = useState(false)
  const [selected, setSelected] = useState(() => new Set(playlist.entries.map((e) => e.url)))
  const count = playlist.entries.length

  const decide = (d: Parameters<Window['grabbit']['resolvePlaylist']>[1]): void => {
    void api().resolvePlaylist(job.id, d)
    onClose()
  }

  return (
    <Modal
      title={t('playlist.title')}
      subtitle={t('playlist.subtitle', { title: playlist.title, count })}
      icon={<ListVideo size={20} />}
      onClose={onClose}
      footer={
        picking ? (
          <>
            <button className="btn" onClick={() => setPicking(false)}>
              {t('action.cancel')}
            </button>
            <button
              className="btn btn-primary"
              disabled={!selected.size}
              onClick={() => decide({ choice: 'entries', urls: playlist.entries.filter((e) => selected.has(e.url)).map((e) => e.url) })}
            >
              {t('playlist.downloadSelected', { count: selected.size })}
            </button>
          </>
        ) : undefined
      }
    >
      {!picking ? (
        <div data-testid="playlist-options">
          {playlist.singleVideo && (
            <button className="option" onClick={() => decide({ choice: 'single' })} data-testid="playlist-single">
              <span className="option-icon">
                <Film size={18} />
              </span>
              <span className="grow">
                <div className="option-title">{t('playlist.single')}</div>
                <div className="option-hint">{t('playlist.singleHint', { title: playlist.singleVideo.title })}</div>
              </span>
            </button>
          )}
          <button
            className="option"
            onClick={() => decide({ choice: 'entries', urls: playlist.entries.map((e) => e.url) })}
            data-testid="playlist-all"
          >
            <span className="option-icon">
              <ListVideo size={18} />
            </span>
            <span className="grow">
              <div className="option-title">{t('playlist.all')}</div>
              <div className="option-hint">{t('playlist.allHint', { count })}</div>
            </span>
          </button>
          <button className="option" onClick={() => setPicking(true)} data-testid="playlist-pick">
            <span className="option-icon">
              <ListChecks size={18} />
            </span>
            <span className="grow">
              <div className="option-title">{t('playlist.pick')}</div>
            </span>
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button className="btn btn-sm" onClick={() => setSelected(new Set(playlist.entries.map((e) => e.url)))}>
              {t('playlist.selectAll')}
            </button>
            <button className="btn btn-sm" onClick={() => setSelected(new Set())}>
              {t('playlist.selectNone')}
            </button>
          </div>
          <div className="check-list">
            {playlist.entries.map((e, i) => (
              <label key={e.url} className="check-row">
                <input
                  type="checkbox"
                  checked={selected.has(e.url)}
                  onChange={(ev) => {
                    const next = new Set(selected)
                    if (ev.target.checked) next.add(e.url)
                    else next.delete(e.url)
                    setSelected(next)
                  }}
                />
                <span className="d">{String(i + 1).padStart(2, '0')}</span>
                <span className="t" title={e.title}>
                  {e.title}
                </span>
                <span className="d">{formatDuration(e.duration)}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
