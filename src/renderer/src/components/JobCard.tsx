import {
  CircleAlert,
  CircleCheck,
  Film,
  FolderOpen,
  ListVideo,
  LoaderCircle,
  LogIn,
  Music,
  Play,
  RotateCw,
  ScanSearch,
  Trash2,
  X
} from 'lucide-react'
import { useState } from 'react'
import type { Job } from '@shared/types'
import { errorInfo } from '../errors'
import { formatBytes, formatDuration, formatEta, formatSpeed, hostOf } from '../format'
import { useI18n } from '../i18n'
import { api } from '../store'

interface Props {
  job: Job
  onChoose: (job: Job) => void
}

const ACTIVE = new Set(['queued', 'analyzing', 'scanning', 'downloading'])

function Thumb({ job }: { job: Job }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const Icon = job.pending?.type === 'playlist' ? ListVideo : job.options.mode === 'audio' ? Music : Film
  return (
    <div className="thumb">
      <Icon size={22} />
      {job.thumbnail && !broken && <img src={job.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
      {job.duration != null && <span className="badge">{formatDuration(job.duration)}</span>}
    </div>
  )
}

export function JobCard({ job, onChoose }: Props): React.JSX.Element {
  const { t, locale } = useI18n()
  const [showRaw, setShowRaw] = useState(false)
  const [interactive, setInteractive] = useState(false)
  const active = ACTIVE.has(job.status)
  const fmt = job.options.mode === 'video' ? job.options.videoFormat : job.options.audioFormat
  const title = job.title ?? hostOf(job.url)
  const source = job.source === 'sniffer' ? `${hostOf(job.url)} · ${t('source.sniffer')}` : hostOf(job.url)

  let status: React.ReactNode
  let statusClass = ''
  let bar: React.ReactNode = null
  switch (job.status) {
    case 'queued':
    case 'analyzing':
    case 'scanning':
      status = (
        <>
          <LoaderCircle size={14} className="spin" />
          {t(`status.${job.status}`)}
        </>
      )
      bar = (
        <div className="progress indeterminate" aria-hidden>
          <span />
        </div>
      )
      if (job.status === 'queued') bar = null
      break
    case 'waiting':
      status = t('status.waiting')
      break
    case 'downloading': {
      const p = job.progress
      const pct = p?.fraction != null ? Math.floor(p.fraction * 100) : null
      if (p && p.stage !== 'downloading') {
        status = (
          <>
            <LoaderCircle size={14} className="spin" />
            {t(`stage.${p.stage}`)}
          </>
        )
        bar = (
          <div className="progress indeterminate" aria-hidden>
            <span />
          </div>
        )
      } else {
        const parts = [
          pct != null ? `${pct}%` : t('status.downloading'),
          p?.totalBytes ? `${formatBytes(p.downloadedBytes, locale)} / ${formatBytes(p.totalBytes, locale)}` : formatBytes(p?.downloadedBytes, locale),
          formatSpeed(p?.speed, locale),
          p?.eta != null ? t('progress.remaining', { time: formatEta(p.eta) }) : ''
        ].filter(Boolean)
        status = parts.map((s, i) => (
          <span key={i}>
            {i > 0 && <span className="sep">· </span>}
            {s}
          </span>
        ))
        bar = (
          <div
            className={`progress${pct == null ? ' indeterminate' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <span style={{ width: `${pct ?? 0}%` }} />
          </div>
        )
      }
      break
    }
    case 'completed':
      statusClass = 'ok'
      status = (
        <>
          <CircleCheck size={14} />
          {t('status.completed')}
          {job.fileSize ? <span className="sep">· {formatBytes(job.fileSize, locale)}</span> : null}
        </>
      )
      break
    case 'cancelled':
      status = t('status.cancelled')
      break
    case 'failed': {
      statusClass = 'err'
      const info = errorInfo(job.error?.code ?? 'unknown')
      status = (
        <>
          <CircleAlert size={14} />
          {t(info.message)}
        </>
      )
      break
    }
  }

  const err = job.status === 'failed' && job.error ? errorInfo(job.error.code) : null
  const loginUrl = (() => {
    try {
      return new URL(job.url).origin
    } catch {
      return job.url
    }
  })()

  return (
    <li className={`job${job.status === 'waiting' ? ' waiting' : ''}`} data-testid="job" data-status={job.status}>
      <Thumb job={job} />
      <div className="job-body">
        <div className="job-title" title={title}>
          {title}
        </div>
        <div className="job-meta">
          <span className="fmt">{fmt}</span>
          <span>{source}</span>
        </div>
        <div className={`job-status ${statusClass}`} aria-live="polite">
          {status}
        </div>
        {bar}
        {interactive && job.status === 'scanning' && <div className="job-error-hint">{t('interactive.hint')}</div>}
        {err?.hint && <div className="job-error-hint">{t(err.hint)}</div>}
        {(job.status === 'waiting' || (err && err.actions.some((a) => a !== 'retry')) || (job.status === 'failed' && job.error)) && (
          <div className="job-inline-actions">
            {job.status === 'waiting' && (
              <button className="btn btn-primary btn-sm" onClick={() => onChoose(job)}>
                {t('action.choose')}
              </button>
            )}
            {err?.actions.includes('openPage') && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  setInteractive(true)
                  void api().scanInteractively(job.id)
                }}
              >
                <ScanSearch size={14} />
                {t('action.openPage')}
              </button>
            )}
            {err?.actions.includes('login') && (
              <button className="btn btn-sm" onClick={() => void api().openLoginWindow(loginUrl)}>
                <LogIn size={14} />
                {t('action.login')}
              </button>
            )}
            {job.status === 'failed' && job.error && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowRaw((s) => !s)} aria-expanded={showRaw}>
                {t('action.details')}
              </button>
            )}
          </div>
        )}
        {showRaw && job.error && <div className="job-error-raw">{job.error.message}</div>}
      </div>
      <div className="job-actions">
        {job.status === 'completed' && (
          <>
            <button className="icon-btn" title={t('action.open')} aria-label={t('action.open')} onClick={() => void api().openFile(job.id)}>
              <Play size={17} />
            </button>
            <button className="icon-btn" title={t('action.showInFolder')} aria-label={t('action.showInFolder')} onClick={() => void api().showInFolder(job.id)}>
              <FolderOpen size={17} />
            </button>
          </>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <button className="icon-btn" title={t('action.retry')} aria-label={t('action.retry')} onClick={() => void api().retryJob(job.id)}>
            <RotateCw size={17} />
          </button>
        )}
        {active || job.status === 'waiting' ? (
          <button className="icon-btn danger" title={t('action.cancel')} aria-label={t('action.cancel')} onClick={() => void api().cancelJob(job.id)}>
            <X size={18} />
          </button>
        ) : (
          <button className="icon-btn danger" title={t('action.remove')} aria-label={t('action.remove')} onClick={() => void api().removeJob(job.id)}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </li>
  )
}
