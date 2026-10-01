import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, net, type BrowserWindow } from 'electron'
import type { AppEvent, AppState, DownloadOptions, Job, PlaylistDecision, Settings } from '@shared/types'
import { exportSessionCookies } from '../browser/cookies'
import { clearWebData, openLoginWindow, webSession } from '../browser/web'
import { ComponentManager } from '../engine/components'
import { createElectronHttp } from '../engine/http'
import { detectTarget, exeSuffix } from '../engine/sources'
import { ffprobeProber } from '../sniffer/probe'
import { browserUserAgent, sniffPage } from '../sniffer/sniffer'
import { analyze } from '../ytdlp/analyze'
import { download } from '../ytdlp/download'
import { JobManager } from './jobs'
import { defaultSettings, sanitizeSettings } from './settings'
import { JsonFile, readJson } from './store'

const HOUR = 3_600_000
/** "Always the latest yt-dlp": checked at every start, then at least once an hour before analysing. */
const YTDLP_MAX_AGE = HOUR
const DENO_MAX_AGE = 24 * HOUR
const FFMPEG_MAX_AGE = 7 * 24 * HOUR
const LOG_MAX_BYTES = 5 * 1024 * 1024

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])
}

/**
 * The main-process brain: owns settings, the engine (components), the job
 * queue and the saved logins, and turns their changes into UI events.
 */
export class AppCore {
  readonly userData = app.getPath('userData')
  readonly target = detectTarget()
  readonly userAgent = browserUserAgent(app.userAgentFallback)
  settings!: Settings
  components!: ComponentManager
  jobs!: JobManager
  private loginSites: string[] = []
  private readonly settingsFile = new JsonFile<Settings>(join(this.userData, 'settings.json'))
  private readonly historyFile = new JsonFile<Job[]>(join(this.userData, 'history.json'))
  private readonly loginsFile = new JsonFile<string[]>(join(this.userData, 'logins.json'))
  private readonly logFile = join(this.userData, 'logs', 'main.log')
  private readonly listeners = new Set<(e: AppEvent) => void>()
  private engineInstall: Promise<void> | null = null
  mainWindow: BrowserWindow | null = null

  async init(): Promise<void> {
    mkdirSync(join(this.userData, 'logs'), { recursive: true })
    this.rotateLog()
    this.log(`avvio ${app.getName()} ${app.getVersion()} (${this.target})`)

    const defaults = defaultSettings(app.getPath('downloads'))
    this.settings = sanitizeSettings(await readJson<unknown>(join(this.userData, 'settings.json'), {}), defaults)
    this.loginSites = await readJson<string[]>(join(this.userData, 'logins.json'), [])

    const workDir = join(this.userData, 'work')
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    mkdirSync(workDir, { recursive: true })

    this.components = new ComponentManager({
      binDir: join(this.userData, 'bin'),
      target: this.target,
      http: createElectronHttp(net),
      channel: () => this.settings.ytdlpChannel,
      log: (m) => this.log(m)
    })
    this.components.on('change', (components) => this.emit({ type: 'components', components }))
    await this.components.init()

    this.jobs = new JobManager(
      {
        workDir,
        engine: () => this.ensureEngine(),
        exportCookies: (file) => exportSessionCookies(webSession(), file),
        analyze,
        download,
        sniff: (req) =>
          sniffPage({
            url: req.url,
            session: webSession(),
            userAgent: this.userAgent,
            visible: req.visible,
            signal: req.signal,
            onUpdate: req.onUpdate,
            probe: this.components.isReady()
              ? ffprobeProber(join(this.components.getPaths().ffmpegDir, `ffprobe${exeSuffix(this.target)}`))
              : undefined,
            log: (m) => this.log(m)
          }),
        fileExists: (p) => existsSync(p),
        log: (m) => this.log(m)
      },
      this.settings.maxConcurrent
    )
    this.jobs.on('job', (job) => this.emit({ type: 'job', job }))
    this.jobs.on('removed', (id) => this.emit({ type: 'job-removed', id }))
    this.jobs.on('changed', () => this.historyFile.save(this.jobs.snapshot()))
    this.jobs.load(await readJson<Job[]>(join(this.userData, 'history.json'), []))

    // Engine: install what is missing, refresh what is old (in the background).
    if (!this.components.isReady()) void this.installEngine().catch(() => undefined)
    else void this.refreshEngine()
    setInterval(() => void this.refreshEngine(), 6 * HOUR).unref()
  }

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  installEngine(): Promise<void> {
    this.engineInstall ??= this.components.ensureInstalled().finally(() => {
      this.engineInstall = null
    })
    return this.engineInstall
  }

  async refreshEngine(force = false): Promise<void> {
    await Promise.allSettled([
      // yt-dlp: at every start and every 6 hours, as fresh as possible.
      this.components.checkForUpdates(['yt-dlp'], 0),
      this.components.checkForUpdates(['deno'], force ? 0 : DENO_MAX_AGE),
      this.components.checkForUpdates(['ffmpeg'], force ? 0 : FFMPEG_MAX_AGE)
    ])
  }

  /** Called before every job: the engine must be installed and yt-dlp fresh. */
  private async ensureEngine() {
    if (!this.components.isReady()) await this.installEngine()
    await withTimeout(this.components.checkForUpdates(['yt-dlp'], YTDLP_MAX_AGE).catch(() => undefined), 30_000)
    await this.components.whenIdle('yt-dlp')
    return this.components.getPaths()
  }

  // -------------------------------------------------------------------------
  // State & events
  // -------------------------------------------------------------------------

  state(): AppState {
    return {
      info: { version: app.getVersion(), platform: process.platform, arch: process.arch, defaultFolder: app.getPath('downloads') },
      settings: this.settings,
      jobs: this.jobs.list(),
      components: this.components.getStates(),
      loggedInSites: this.loginSites
    }
  }

  onEvent(listener: (e: AppEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: AppEvent): void {
    for (const l of this.listeners) l(e)
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  addDownload(url: string, partial: Partial<DownloadOptions> = {}): Job {
    const s = this.settings
    const options: DownloadOptions = {
      mode: partial.mode ?? s.mode,
      videoFormat: partial.videoFormat ?? s.videoFormat,
      audioFormat: partial.audioFormat ?? s.audioFormat,
      folder: partial.folder ?? s.folder,
      embedMetadata: partial.embedMetadata ?? s.embedMetadata,
      embedThumbnail: partial.embedThumbnail ?? s.embedThumbnail,
      preferCompatible: partial.preferCompatible ?? s.preferCompatible
    }
    if (!/^https?:\/\//i.test(url.trim())) throw new Error('URL non valido')
    return this.jobs.add(url, options)
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const prevChannel = this.settings.ytdlpChannel
    this.settings = sanitizeSettings({ ...this.settings, ...patch }, defaultSettings(app.getPath('downloads')))
    this.settingsFile.save(this.settings)
    this.jobs.setMaxConcurrent(this.settings.maxConcurrent)
    if (this.settings.ytdlpChannel !== prevChannel) void this.components.update('yt-dlp').catch(() => undefined)
    this.emit({ type: 'settings', settings: this.settings })
    return this.settings
  }

  resolvePlaylist(id: string, d: PlaylistDecision): void {
    this.jobs.resolvePlaylist(id, d)
  }

  openLogin(url: string): void {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`
    openLoginWindow(target, this.userAgent, (site) => {
      if (this.loginSites.includes(site)) return
      this.loginSites = [...this.loginSites, site].sort()
      this.loginsFile.save(this.loginSites)
      this.emit({ type: 'logins', sites: this.loginSites })
    })
  }

  async clearLogins(): Promise<void> {
    await clearWebData()
    this.loginSites = []
    this.loginsFile.save([])
    this.emit({ type: 'logins', sites: [] })
  }

  async shutdown(): Promise<void> {
    this.jobs.stopAll()
    this.historyFile.save(this.jobs.snapshot())
    await Promise.all([this.historyFile.flush(), this.settingsFile.flush(), this.loginsFile.flush()])
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}\n`
    if (!app.isPackaged) process.stdout.write(line)
    try {
      appendFileSync(this.logFile, line)
    } catch {
      /* logging must never break the app */
    }
  }

  private rotateLog(): void {
    try {
      if (statSync(this.logFile).size > LOG_MAX_BYTES) writeFileSync(this.logFile, '')
    } catch {
      /* no log yet */
    }
  }
}
