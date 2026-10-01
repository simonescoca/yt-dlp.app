import { ArrowDownToLine } from 'lucide-react'
import type { Job } from '@shared/types'
import { useI18n } from '../i18n'
import { api, useSortedJobs } from '../store'
import { JobCard } from './JobCard'

export function JobList({ onChoose }: { onChoose: (job: Job) => void }): React.JSX.Element {
  const { t } = useI18n()
  const jobs = useSortedJobs()
  const hasFinished = jobs.some((j) => ['completed', 'failed', 'cancelled'].includes(j.status))
  const pasteKey = navigator.platform.toLowerCase().includes('mac') ? '⌘V' : 'Ctrl+V'

  if (!jobs.length) {
    const [before, after] = t('empty.hint').split('{key}')
    return (
      <div className="empty">
        <div className="empty-art">
          <ArrowDownToLine size={30} />
        </div>
        <h3>{t('empty.title')}</h3>
        <p>{t('empty.body')}</p>
        <p className="muted">
          {before}
          <span className="kbd">{pasteKey}</span>
          {after}
        </p>
      </div>
    )
  }

  return (
    <section aria-label={t('list.title')}>
      <div className="list-header">
        <h2>
          {t('list.title')}
          <span className="count">{jobs.length}</span>
        </h2>
        {hasFinished && (
          <button className="btn btn-ghost btn-sm" onClick={() => void api().clearHistory()}>
            {t('list.clear')}
          </button>
        )}
      </div>
      <ul className="jobs">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} onChoose={onChoose} />
        ))}
      </ul>
    </section>
  )
}
