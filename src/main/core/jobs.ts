import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DownloadOptions,
  ErrorCode,
  Job,
  JobError,
  JobProgress,
  MediaSummary,
  PlaylistDecision,
  SniffResult,
  StreamCandidate
} from '@shared/types'
import { AnalyzeError, type AnalyzeResult } from '../ytdlp/analyze'
import { DownloadError, type DownloadRequest } from '../ytdlp/download'
import { outputExtension, sanitizeFileName, uniqueFileName } from '../ytdlp/options'
import type { ProgressSnapshot } from '../ytdlp/progress'
import type { EngineContext } from '../ytdlp/runner'

export interface SniffRequest {
  url: string
  signal: AbortSignal
  visible?: boolean
  onUpdate?: (r: SniffResult) => void
}

/** Everything the job manager needs from the outside world (injected, so it can be tested). */
export interface JobDeps {
  /** Root folder for per-job temporary files. */
  workDir: string
  /** Makes sure the engine is installed and fresh; returns its paths. */
  engine: () => Promise<EngineContext['paths']>
  /** Writes the in-app browser cookies to `file`; false when there are none. */
  exportCookies: (file: string) => Promise<boolean>
  analyze: (url: string, ctx: EngineContext, signal?: AbortSignal, opts?: { noPlaylist?: boolean }) => Promise<AnalyzeResult>
  download: (
    req: DownloadRequest,
    ctx: EngineContext,
    opts: { signal?: AbortSignal; onProgress?: (p: ProgressSnapshot) => void; onLog?: (line: string) => void }
  ) => Promise<string>
  sniff: (req: SniffRequest) => Promise<SniffResult>
  fileExists: (path: string) => boolean
  log?: (msg: string) => void
}

/** yt-dlp failures after which scanning the page may still find the video. */
const SNIFFABLE: ReadonlySet<ErrorCode> = new Set(['unsupported', 'no_media', 'forbidden', 'unknown'])
/** Download failures worth one more try with a fresh extraction (stale info JSON). */
const RETRY_FRESH: ReadonlySet<ErrorCode> = new Set(['forbidden', 'not_found', 'network', 'unknown'])
const ACTIVE: ReadonlySet<Job['status']> = new Set(['analyzing', 'scanning', 'downloading'])
const FINISHED: ReadonlySet<Job['status']> = new Set(['completed', 'failed', 'cancelled'])
const PROGRESS_INTERVAL_MS = 250
const MAX_HISTORY = 500

type Resume = { kind: 'info'; infoJson: string; media: MediaSummary } | { kind: 'stream'; candidate: StreamCandidate; title: string }

class JobFailure extends Error {
  constructor(readonly error: JobError) {
    super(error.message)
  }
}

export function newJob(url: string, options: DownloadOptions, extra: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    url,
    createdAt: Date.now(),
    finishedAt: null,
    options,
    status: 'queued',
    title: null,
    thumbnail: null,
    source: null,
    duration: null,
    progress: null,
    filePath: null,
    fileSize: null,
    error: null,
    pending: null,
    playlistTitle: null,
    playlistIndex: null,
    streamUrl: null,
    noPlaylist: false,
    ...extra
  }
}

/**
 * The download queue: runs each job through analysis → (playlist choice) →
 * (page scan) → download, at most `maxConcurrent` at a time.
 */
export class JobManager extends EventEmitter<{ job: [Job]; removed: [string]; changed: [] }> {
  private readonly jobs = new Map<string, Job>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly resume = new Map<string, Resume>()
  private readonly reservedNames = new Set<string>()
  private readonly lastEmit = new Map<string, number>()
  private runCounter = 0
  private readonly log: (msg: string) => void

  constructor(
    private readonly deps: JobDeps,
    private maxConcurrent = 2
  ) {
    super()
    this.log = deps.log ?? (() => undefined)
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Restores the persisted history. Jobs that were running when the app quit are marked as interrupted. */
  load(saved: Job[]): void {
    for (const j of saved) {
      const job: Job = { ...j, progress: null }
      if (ACTIVE.has(job.status)) {
        job.status = 'failed'
        job.error = { code: 'interrupted', message: 'Interrotto alla chiusura dell’app' }
        job.finishedAt = Date.now()
      }
      this.jobs.set(job.id, job)
    }
    this.schedule()
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** Jobs to persist: every unfinished job + the newest MAX_HISTORY finished ones. */
  snapshot(): Job[] {
    let finished = 0
    return this.list().filter((j) => !FINISHED.has(j.status) || ++finished <= MAX_HISTORY)
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n
    this.schedule()
  }

  add(url: string, options: DownloadOptions, extra: Partial<Job> = {}): Job {
    const job = newJob(url.trim(), options, extra)
    this.jobs.set(job.id, job)
    this.emitJob(job, true)
    this.schedule()
    return job
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || FINISHED.has(job.status)) return
    this.controllers.get(id)?.abort()
    this.resume.delete(id)
    this.finish(job, 'cancelled', { error: null })
  }

  retry(id: string): void {
    const job = this.jobs.get(id)
    if (!job || !FINISHED.has(job.status)) return
    this.patch(job, { status: 'queued', error: null, progress: null, pending: null, filePath: null, fileSize: null, finishedAt: null })
    this.schedule()
  }

  remove(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.controllers.get(id)?.abort()
    this.resume.delete(id)
    this.jobs.delete(id)
    this.emit('removed', id)
    this.emit('changed')
    this.schedule()
  }

  clearFinished(): void {
    for (const job of [...this.jobs.values()]) if (FINISHED.has(job.status)) this.remove(job.id)
  }

  resolvePlaylist(id: string, decision: PlaylistDecision): void {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'waiting' || job.pending?.type !== 'playlist') return
    const { playlist } = job.pending
    if (decision.choice === 'cancel') {
      this.finish(job, 'cancelled', { pending: null })
    } else if (decision.choice === 'single') {
      if (!playlist.singleVideo) return
      // The single-video info JSON kept by the analysis is reused when still in memory;
      // otherwise (e.g. after a restart) the analysis runs again with --no-playlist.
      this.patch(job, { status: 'queued', pending: null, noPlaylist: true, title: playlist.singleVideo.title, thumbnail: playlist.singleVideo.thumbnail })
      this.schedule()
    } else {
      const wanted = new Set(decision.urls)
      const entries = playlist.entries.filter((e) => wanted.has(e.url))
      entries.forEach((e) => {
        const index = playlist.entries.indexOf(e) + 1
        this.add(e.url, job.options, {
          title: e.title,
          thumbnail: e.thumbnail,
          duration: e.duration,
          playlistTitle: playlist.title,
          playlistIndex: index,
          noPlaylist: true
        })
      })
      this.remove(job.id)
    }
  }

  chooseStream(id: string, candidateId: string | null): void {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'waiting' || job.pending?.type !== 'stream') return
    const { sniff } = job.pending
    const candidate = sniff.candidates.find((c) => c.id === candidateId)
    if (!candidate) {
      this.finish(job, 'cancelled', { pending: null })
      return
    }
    this.resume.set(id, { kind: 'stream', candidate, title: sniff.pageTitle })
    this.patch(job, { status: 'queued', pending: null, streamUrl: candidate.url })
    this.schedule()
  }

  /** Opens the page in a visible window so the user can start the video; then lets them pick a stream. */
  async scanInteractively(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job || ACTIVE.has(job.status)) return
    const ac = new AbortController()
    this.controllers.set(id, ac)
    this.patch(job, { status: 'scanning', error: null, pending: null, progress: null, finishedAt: null })
    try {
      const result = await this.deps.sniff({ url: job.url, signal: ac.signal, visible: true })
      if (job.status !== 'scanning') return
      if (!result.candidates.some((c) => !c.drm)) {
        throw new JobFailure({ code: result.drmDetected ? 'drm' : 'no_media', message: 'Nessun video trovato nella pagina' })
      }
      this.patch(job, { status: 'waiting', pending: { type: 'stream', sniff: result }, title: job.title ?? result.pageTitle, thumbnail: job.thumbnail ?? result.thumbnail })
    } catch (err) {
      if (job.status === 'scanning') this.finish(job, 'failed', { error: toJobError(err) })
    } finally {
      this.controllers.delete(id)
    }
  }

  /** Aborts everything (app quit). */
  stopAll(): void {
    for (const c of this.controllers.values()) c.abort()
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private schedule(): void {
    let active = [...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length
    const queued = [...this.jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)
    for (const job of queued) {
      if (active >= this.maxConcurrent) break
      active++
      void this.run(job)
    }
  }

  private async run(job: Job): Promise<void> {
    const ac = new AbortController()
    this.controllers.set(job.id, ac)
    // Each run gets its own folder: a retry may start before the previous run has cleaned up.
    // Kept short: Windows paths are limited to 260 characters and yt-dlp adds ".fNNN.ext.part".
    const runDir = join(this.deps.workDir, `${job.id.slice(0, 8)}${++this.runCounter}`)
    this.patch(job, { status: 'analyzing', error: null, progress: null })
    try {
      await this.execute(job, ac.signal, runDir)
    } catch (err) {
      if (!ac.signal.aborted && this.jobs.get(job.id) === job && !FINISHED.has(job.status)) {
        const error = toJobError(err)
        this.log(`[job ${job.id}] ${error.code}: ${error.message}`)
        this.finish(job, error.code === 'cancelled' ? 'cancelled' : 'failed', { error: error.code === 'cancelled' ? null : error })
      }
    } finally {
      if (this.controllers.get(job.id) === ac) this.controllers.delete(job.id)
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
      this.schedule()
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  private async execute(job: Job, signal: AbortSignal, tempDir: string): Promise<void> {
    let paths: EngineContext['paths']
    try {
      paths = await this.deps.engine()
    } catch (err) {
      throw new JobFailure({ code: 'engine_missing', message: errMessage(err) })
    }
    await mkdir(tempDir, { recursive: true })
    const cookiesFile = join(tempDir, 'cookies.txt')
    const ctx: EngineContext = { paths, cookiesFile: (await this.deps.exportCookies(cookiesFile).catch(() => false)) ? cookiesFile : null }
    if (signal.aborted) return

    const resume = this.resume.get(job.id)
    this.resume.delete(job.id)
    if (resume?.kind === 'stream') return this.downloadStream(job, ctx, resume.candidate, resume.title, signal, tempDir)
    if (resume?.kind === 'info') return this.downloadMedia(job, ctx, signal, tempDir, resume.infoJson)

    let result: AnalyzeResult
    try {
      result = await this.deps.analyze(job.url, ctx, signal, { noPlaylist: job.noPlaylist })
    } catch (err) {
      if (err instanceof AnalyzeError && SNIFFABLE.has(err.error.code) && !signal.aborted) {
        this.log(`[job ${job.id}] yt-dlp: ${err.error.message} → scansione della pagina`)
        return this.scan(job, ctx, signal, err.error, tempDir)
      }
      throw err
    }
    if (signal.aborted) return

    if (result.kind === 'video') {
      const m = result.media
      this.patch(job, { title: job.playlistTitle ? (job.title ?? m.title) : m.title, thumbnail: m.thumbnail ?? job.thumbnail, source: m.extractor, duration: m.duration })
      return this.downloadMedia(job, ctx, signal, tempDir, result.infoJson)
    }

    const { playlist } = result
    if (result.singleInfoJson && playlist.singleVideo) {
      this.resume.set(job.id, { kind: 'info', infoJson: result.singleInfoJson, media: playlist.singleVideo })
    }
    this.patch(job, {
      status: 'waiting',
      pending: { type: 'playlist', playlist },
      title: playlist.title,
      thumbnail: playlist.thumbnail,
      source: null
    })
  }

  private async scan(job: Job, ctx: EngineContext, signal: AbortSignal, cause: JobError, tempDir: string): Promise<void> {
    this.patch(job, { status: 'scanning' })
    const result = await this.deps.sniff({ url: job.url, signal })
    if (signal.aborted) return
    // Even when nothing is found, the page title is a better label than the bare URL.
    if (!job.title && result.pageTitle && result.pageTitle !== job.url) this.patch(job, { title: result.pageTitle, thumbnail: result.thumbnail })
    if (!result.best) {
      if (result.drmDetected) throw new JobFailure({ code: 'drm', message: 'Il video è protetto da DRM' })
      throw new JobFailure({ code: cause.code === 'forbidden' ? 'forbidden' : 'no_media', message: cause.message })
    }
    this.patch(job, { title: result.pageTitle, thumbnail: result.thumbnail ?? job.thumbnail, source: 'sniffer', duration: result.best.duration })
    if (result.ambiguous) {
      this.patch(job, { status: 'waiting', pending: { type: 'stream', sniff: result } })
      return
    }
    return this.downloadStream(job, ctx, result.best, result.pageTitle, signal, tempDir)
  }

  private downloadStream(job: Job, ctx: EngineContext, c: StreamCandidate, title: string, signal: AbortSignal, tempDir: string): Promise<void> {
    this.patch(job, { title: job.title ?? title, source: 'sniffer', streamUrl: c.url, duration: c.duration ?? job.duration })
    return this.downloadMedia(job, ctx, signal, tempDir, null, { url: c.url, headers: { Referer: c.referer, ...c.headers } })
  }

  /** Runs yt-dlp for a page (with its saved info JSON) or for a scanned stream. */
  private async downloadMedia(
    job: Job,
    ctx: EngineContext,
    signal: AbortSignal,
    tempDir: string,
    infoJson: string | null,
    stream?: { url: string; headers: Record<string, string> }
  ): Promise<void> {
    const opts = job.options
    const dir = job.playlistTitle ? join(opts.folder, sanitizeFileName(job.playlistTitle, 120)) : opts.folder
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      throw new JobFailure({ code: 'permission', message: `Impossibile scrivere in ${dir}: ${errMessage(err)}` })
    }
    const ext = outputExtension(opts)
    const prefix = job.playlistIndex != null ? `${String(job.playlistIndex).padStart(2, '0')} - ` : ''
    const base = uniqueFileName(sanitizeFileName(prefix + (job.title ?? 'video'), 120), ext, (name) => {
      const full = join(dir, name)
      return this.reservedNames.has(full) || this.deps.fileExists(full)
    })
    const reserved = join(dir, `${base}.${ext}`)
    this.reservedNames.add(reserved)
    this.patch(job, { status: 'downloading', progress: { stage: 'downloading', fraction: 0, speed: null, eta: null, downloadedBytes: 0, totalBytes: null } })

    const request = async (useInfo: boolean): Promise<string> => {
      let infoJsonFile: string | null = null
      if (useInfo && infoJson) {
        infoJsonFile = join(tempDir, 'info.json')
        await writeFile(infoJsonFile, infoJson)
      }
      return this.deps.download(
        {
          url: stream?.url ?? job.url,
          infoJsonFile,
          options: opts,
          outputDir: dir,
          fileBase: base,
          tempDir: join(tempDir, useInfo ? 'p' : 'r'),
          headers: stream?.headers
        },
        ctx,
        { signal, onProgress: (p) => this.onProgress(job, p) }
      )
    }

    try {
      let file: string
      try {
        file = await request(true)
      } catch (err) {
        // URLs saved by the analysis can expire (queued for long): extract again once.
        if (!(infoJson && err instanceof DownloadError && RETRY_FRESH.has(err.error.code)) || signal.aborted) throw err
        this.log(`[job ${job.id}] nuovo tentativo con estrazione fresca: ${err.error.message}`)
        file = await request(false)
      }
      if (signal.aborted) return
      const size = await stat(file).then((s) => s.size).catch(() => null)
      this.finish(job, 'completed', { filePath: file, fileSize: size, progress: null, pending: null })
    } finally {
      this.reservedNames.delete(reserved)
    }
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private onProgress(job: Job, p: ProgressSnapshot): void {
    if (job.status !== 'downloading') return
    const prev = job.progress
    const progress: JobProgress = { ...p }
    job.progress = progress
    const now = Date.now()
    if (prev?.stage !== progress.stage || now - (this.lastEmit.get(job.id) ?? 0) >= PROGRESS_INTERVAL_MS) {
      this.emitJob(job, false)
    }
  }

  private finish(job: Job, status: 'completed' | 'failed' | 'cancelled', extra: Partial<Job>): void {
    this.patch(job, { status, finishedAt: Date.now(), progress: null, ...extra })
  }

  private patch(job: Job, partial: Partial<Job>): void {
    if (this.jobs.get(job.id) !== job) return
    Object.assign(job, partial)
    this.emitJob(job, true)
  }

  private emitJob(job: Job, persist: boolean): void {
    this.lastEmit.set(job.id, Date.now())
    this.emit('job', { ...job })
    if (persist) this.emit('changed')
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function toJobError(err: unknown): JobError {
  if (err instanceof JobFailure || err instanceof AnalyzeError || err instanceof DownloadError) return err.error
  return { code: 'unknown', message: errMessage(err) }
}
