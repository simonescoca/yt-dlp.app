import { ExternalLink, LogIn, LogOut, Minus, Plus, RefreshCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ComponentState, Settings } from '@shared/types'
import { useI18n, type Translate } from '../i18n'
import { api, useAppState } from '../store'

const QUICK_SITES = [
  ['YouTube', 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/'],
  ['Vimeo', 'https://vimeo.com/log_in'],
  ['Instagram', 'https://www.instagram.com/accounts/login/'],
  ['Facebook', 'https://www.facebook.com/login'],
  ['X', 'https://x.com/i/flow/login'],
  ['TikTok', 'https://www.tiktok.com/login']
] as const

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): React.JSX.Element {
  return <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
}

function relative(ts: number | null, t: Translate): string {
  if (!ts) return '—'
  const min = Math.round((Date.now() - ts) / 60_000)
  if (min < 1) return t('time.justNow')
  if (min < 60) return t('time.minutesAgo', { n: min })
  return t('time.hoursAgo', { n: Math.round(min / 60) })
}

function componentStatus(c: ComponentState, t: Translate): string {
  switch (c.phase) {
    case 'ready':
      return c.version ?? ''
    case 'downloading':
      return t('component.downloading', { percent: `${Math.round((c.progress ?? 0) * 100)}%` })
    case 'missing':
    case 'checking':
    case 'installing':
    case 'error':
      return t(`component.${c.phase}`)
  }
}

export function SettingsDrawer({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const { settings, components, loggedInSites, info } = useAppState()
  const [loginUrl, setLoginUrl] = useState('')
  const [checking, setChecking] = useState(false)
  const set = (patch: Partial<Settings>): void => void api().updateSettings(patch)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ytdlp = components.find((c) => c.id === 'yt-dlp')

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={t('settings.title')} data-testid="settings">
        <div className="drawer-head">
          <h2>{t('settings.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('action.close')}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="section">
            <h3>{t('settings.general')}</h3>
            <div className="card">
              <div className="row">
                <div className="grow label">{t('settings.language')}</div>
                <select className="input" value={settings.language} onChange={(e) => set({ language: e.target.value as Settings['language'] })} aria-label={t('settings.language')}>
                  <option value="auto">{t('settings.language.auto')}</option>
                  <option value="it">Italiano</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div className="row">
                <div className="grow label">{t('settings.theme')}</div>
                <select className="input" value={settings.theme} onChange={(e) => set({ theme: e.target.value as Settings['theme'] })} aria-label={t('settings.theme')}>
                  <option value="system">{t('settings.theme.system')}</option>
                  <option value="light">{t('settings.theme.light')}</option>
                  <option value="dark">{t('settings.theme.dark')}</option>
                </select>
              </div>
              <div className="row">
                <div className="grow label">{t('settings.concurrent')}</div>
                <div className="stepper">
                  <button className="icon-btn" aria-label="−" disabled={settings.maxConcurrent <= 1} onClick={() => set({ maxConcurrent: settings.maxConcurrent - 1 })}>
                    <Minus size={15} />
                  </button>
                  <output>{settings.maxConcurrent}</output>
                  <button className="icon-btn" aria-label="+" disabled={settings.maxConcurrent >= 5} onClick={() => set({ maxConcurrent: settings.maxConcurrent + 1 })}>
                    <Plus size={15} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="section">
            <h3>{t('settings.quality')}</h3>
            <div className="card">
              <div className="row">
                <div className="grow">
                  <div className="label">{t('settings.compatible')}</div>
                  <div className="hint">{t('settings.compatibleHint')}</div>
                </div>
                <Switch checked={settings.preferCompatible} onChange={(v) => set({ preferCompatible: v })} label={t('settings.compatible')} />
              </div>
              <div className="row">
                <div className="grow">
                  <div className="label">{t('settings.metadata')}</div>
                  <div className="hint">{t('settings.metadataHint')}</div>
                </div>
                <Switch checked={settings.embedMetadata} onChange={(v) => set({ embedMetadata: v })} label={t('settings.metadata')} />
              </div>
              <div className="row">
                <div className="grow">
                  <div className="label">{t('settings.thumbnail')}</div>
                  <div className="hint">{t('settings.thumbnailHint')}</div>
                </div>
                <Switch checked={settings.embedThumbnail} onChange={(v) => set({ embedThumbnail: v })} label={t('settings.thumbnail')} />
              </div>
            </div>
          </div>

          <div className="section">
            <h3>{t('settings.logins')}</h3>
            <div className="card">
              <div className="row" style={{ display: 'block' }}>
                <div className="hint" style={{ marginBottom: 10 }}>
                  {t('settings.loginsHint')}
                </div>
                <div className="label" style={{ marginBottom: 6 }}>
                  {t('settings.loginTo')}
                </div>
                <div className="sites">
                  {QUICK_SITES.map(([name, url]) => (
                    <button key={name} className="btn btn-sm" onClick={() => void api().openLoginWindow(url)}>
                      {name}
                    </button>
                  ))}
                </div>
                <form
                  style={{ display: 'flex', gap: 6, marginTop: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (loginUrl.trim()) void api().openLoginWindow(loginUrl.trim())
                    setLoginUrl('')
                  }}
                >
                  <input className="input" placeholder={t('settings.loginUrl')} value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} />
                  <button className="btn" type="submit" aria-label={t('settings.loginTo')}>
                    <LogIn size={15} />
                  </button>
                </form>
              </div>
              <div className="row" style={{ display: 'block' }}>
                <div className="label" style={{ marginBottom: 6 }}>
                  {t('settings.loggedIn')}
                </div>
                {loggedInSites.length ? (
                  <div className="sites">
                    {loggedInSites.map((s) => (
                      <span key={s} className="tag">
                        {s}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="muted">{t('settings.noLogins')}</div>
                )}
                {loggedInSites.length > 0 && (
                  <button className="btn btn-sm btn-danger" style={{ marginTop: 10 }} onClick={() => void api().clearLogins()}>
                    <LogOut size={14} />
                    {t('settings.logoutAll')}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="section">
            <h3>{t('settings.engine')}</h3>
            <div className="card">
              <div className="row">
                <div className="grow label">{t('settings.channel')}</div>
                <select className="input" value={settings.ytdlpChannel} onChange={(e) => set({ ytdlpChannel: e.target.value as Settings['ytdlpChannel'] })} aria-label={t('settings.channel')}>
                  <option value="nightly">{t('settings.channel.nightly')}</option>
                  <option value="stable">{t('settings.channel.stable')}</option>
                </select>
              </div>
              {components.map((c) => (
                <div className="row" key={c.id} data-testid={`component-${c.id}`}>
                  <div className="grow">
                    <div className="label">{c.id}</div>
                    {c.error && <div className="hint" style={{ color: 'var(--danger)' }}>{c.error}</div>}
                  </div>
                  <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {componentStatus(c, t)}
                  </span>
                </div>
              ))}
              <div className="row">
                <div className="grow muted">{t('settings.lastCheck', { time: relative(ytdlp?.lastCheck ?? null, t) })}</div>
                <button
                  className="btn btn-sm"
                  disabled={checking}
                  onClick={() => {
                    setChecking(true)
                    void api()
                      .checkEngineUpdates()
                      .finally(() => setChecking(false))
                  }}
                >
                  <RefreshCw size={14} className={checking ? 'spin' : undefined} />
                  {t('settings.checkUpdates')}
                </button>
              </div>
            </div>
          </div>

          <div className="section">
            <h3>{t('settings.about')}</h3>
            <div className="card">
              <div className="row">
                <div className="grow">
                  <div className="label">Grabbit</div>
                  <div className="hint">{t('settings.version', { version: info.version })}</div>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => void api().openExternal('https://github.com/simonescoca/yt-dlp.app')}>
                  GitHub
                  <ExternalLink size={13} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
