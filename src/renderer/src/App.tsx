import { ArrowDownToLine, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Job } from '@shared/types'
import { Composer, type ComposerHandle } from './components/Composer'
import { EngineBanner, Footer } from './components/EngineStatus'
import { JobList } from './components/JobList'
import { PlaylistDialog } from './components/PlaylistDialog'
import { SettingsDrawer } from './components/SettingsDrawer'
import { StreamDialog } from './components/StreamDialog'
import { I18nContext, makeTranslate, resolveLocale, useI18n } from './i18n'
import { StoreProvider } from './store'

const URL_RE = /https?:\/\/[^\s"'<>]+/i

function Main({ state }: { state: AppState }): React.JSX.Element {
  const { t } = useI18n()
  const composer = useRef<ComposerHandle>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [chosen, setChosen] = useState<string | null>(null)

  // Paste a link anywhere in the window (outside text fields) → fill the URL box.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      const url = URL_RE.exec(e.clipboardData?.getData('text') ?? '')?.[0]
      if (url) {
        e.preventDefault()
        composer.current?.setUrl(url)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  // Drag & drop of links (from the browser address bar or a page).
  useEffect(() => {
    let depth = 0
    const hasLink = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].some((x) => x === 'text/uri-list' || x === 'text/plain')
    const enter = (e: DragEvent): void => {
      if (!hasLink(e)) return
      depth++
      setDragging(true)
    }
    const leave = (): void => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent): void => {
      if (hasLink(e)) e.preventDefault()
    }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || ''
      const url = URL_RE.exec(text)?.[0]
      if (url) composer.current?.setUrl(url)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // A job that needs a decision opens its dialog automatically (once); "Choose" reopens it.
  const decisionJob: Job | undefined = useMemo(() => {
    const waiting = state.jobs.filter((j) => j.status === 'waiting' && j.pending)
    return waiting.find((j) => j.id === chosen) ?? waiting.sort((a, b) => a.createdAt - b.createdAt).find((j) => !dismissed.has(j.id))
  }, [state.jobs, dismissed, chosen])

  const closeDecision = (): void => {
    if (decisionJob) setDismissed((d) => new Set(d).add(decisionJob.id))
    setChosen(null)
  }

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand" aria-label="Grabbit">
          <span className="brand-mark">
            <ArrowDownToLine size={15} strokeWidth={2.5} />
          </span>
          Grabbit
        </div>
        <button className="icon-btn" aria-label={t('settings.title')} title={t('settings.title')} onClick={() => setSettingsOpen(true)} data-testid="open-settings">
          <SettingsIcon size={18} />
        </button>
      </header>
      <main className="content">
        <div className="container">
          <Composer ref={composer} settings={state.settings} />
          <EngineBanner components={state.components} />
          <JobList onChoose={(job) => setChosen(job.id)} />
        </div>
      </main>
      <Footer components={state.components} />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      {decisionJob?.pending?.type === 'playlist' && <PlaylistDialog job={decisionJob} playlist={decisionJob.pending.playlist} onClose={closeDecision} />}
      {decisionJob?.pending?.type === 'stream' && <StreamDialog job={decisionJob} sniff={decisionJob.pending.sniff} onClose={closeDecision} />}
      {dragging && <div className="drop-zone">{t('drop.here')}</div>}
    </div>
  )
}

export function App(): React.JSX.Element {
  return (
    <StoreProvider>
      {(state) => {
        const locale = resolveLocale(state.settings.language, navigator.language)
        document.documentElement.lang = locale
        if (state.settings.theme === 'system') delete document.documentElement.dataset['theme']
        else document.documentElement.dataset['theme'] = state.settings.theme
        document.body.className = `platform-${state.info.platform}`
        return (
          <I18nContext.Provider value={{ t: makeTranslate(locale), locale }}>
            <Main state={state} />
          </I18nContext.Provider>
        )
      }}
    </StoreProvider>
  )
}
