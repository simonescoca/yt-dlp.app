import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadOptions, Job, SniffResult, StreamCandidate } from '../../src/shared/types'
import { JobManager, newJob, type JobDeps } from '../../src/main/core/jobs'
import { AnalyzeError, type AnalyzeResult } from '../../src/main/ytdlp/analyze'
import { DownloadError, type DownloadRequest } from '../../src/main/ytdlp/download'

const options: DownloadOptions = {
  mode: 'video',
  videoFormat: 'mp4',
  audioFormat: 'mp3',
  folder: '/downloads',
  embedMetadata: true,
  embedThumbnail: true,
  preferCompatible: false
}

const media = (title: string) => ({
  id: title,
  title,
  thumbnail: `https://img/${title}.jpg`,
  duration: 60,
  uploader: null,
  extractor: 'youtube',
  webpageUrl: `https://site/${title}`,
  isLive: false
})

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const candidate = (url: string, o: Partial<StreamCandidate> = {}): StreamCandidate => ({
  id: url,
  url,
  kind: 'hls',
  mime: null,
  size: null,
  width: 1280,
  height: 720,
  duration: 300,
  live: false,
  drm: false,
  ad: false,
  referer: 'https://page/',
  headers: { 'User-Agent': 'UA' },
  score: 50,
  ...o
})

const sniffResult = (cands: StreamCandidate[], o: Partial<SniffResult> = {}): SniffResult => ({
  pageUrl: 'https://page/',
  pageTitle: 'Titolo pagina',
  thumbnail: null,
  candidates: cands,
  best: cands[0] ?? null,
  ambiguous: false,
  drmDetected: false,
  ...o
})

function setup(over: Partial<JobDeps> = {}, maxConcurrent = 2) {
  const downloads: DownloadRequest[] = []
  const deps: JobDeps = {
    workDir: mkdtempSync(join(tmpdir(), 'grabbit-jobs-')),
    engine: async () => ({ ytdlp: 'y', deno: 'd', ffmpegDir: 'f' }),
    exportCookies: async () => false,
    analyze: async (url): Promise<AnalyzeResult> => ({ kind: 'video', media: media(url.split('/').pop()!), infoJson: '{"id":"x"}' }),
    download: async (req) => {
      downloads.push(req)
      return join(req.outputDir, `${req.fileBase}.mp4`)
    },
    sniff: async () => sniffResult([]),
    fileExists: () => false,
    ...over
  }
  const m = new JobManager(deps, maxConcurrent)
  const settled = (id: string) =>
    new Promise<Job>((resolve) => {
      const check = (j: Job) => {
        if (j.id === id && ['completed', 'failed', 'cancelled', 'waiting'].includes(j.status)) {
          m.off('job', check)
          resolve(j)
        }
      }
      m.on('job', check)
    })
  return { m, deps, downloads, settled }
}

describe('JobManager', () => {
  it('analyzes and downloads a video, reusing the info JSON', async () => {
    const { m, downloads, settled } = setup()
    const statuses: string[] = []
    m.on('job', (j) => statuses.push(j.status))
    const job = m.add('https://site/Video bello', options)
    const done = await settled(job.id)
    expect(done.status).toBe('completed')
    expect(done.filePath).toBe(join('/downloads', 'Video bello.mp4'))
    expect(done.title).toBe('Video bello')
    expect(done.source).toBe('youtube')
    expect(downloads[0]!.infoJsonFile).toMatch(/info\.json$/)
    expect(statuses).toEqual(expect.arrayContaining(['queued', 'analyzing', 'downloading', 'completed']))
  })

  it('never overwrites: picks "title (2)" when the file exists', async () => {
    const { m, downloads, settled } = setup({ fileExists: (p) => p === join('/downloads', 'Clip.mp4') })
    await settled(m.add('https://site/Clip', options).id)
    expect(downloads[0]!.fileBase).toBe('Clip (2)')
  })

  it('runs at most maxConcurrent jobs at a time', async () => {
    const gates = [deferred(), deferred(), deferred()]
    let running = 0
    let peak = 0
    const { m, settled } = setup({
      download: async (req) => {
        running++
        peak = Math.max(peak, running)
        await gates[Number(req.url.slice(-1))]!.promise
        running--
        return '/x.mp4'
      }
    })
    const jobs = [0, 1, 2].map((i) => m.add(`https://site/v${i}`, options))
    await vi.waitFor(() => expect(running).toBe(2))
    expect(m.get(jobs[2]!.id)!.status).toBe('queued')
    gates[0]!.resolve()
    await settled(jobs[0]!.id)
    await vi.waitFor(() => expect(m.get(jobs[2]!.id)!.status).toBe('downloading'))
    gates[1]!.resolve()
    gates[2]!.resolve()
    await Promise.all([settled(jobs[1]!.id), settled(jobs[2]!.id)])
    expect(peak).toBe(2)
  })

  it('asks what to do with playlists: only this video', async () => {
    const { m, downloads, settled } = setup({
      analyze: async () => ({
        kind: 'playlist',
        playlist: { title: 'Mix', thumbnail: null, entries: [{ url: 'https://site/a', title: 'A', duration: 1, thumbnail: null }], singleVideo: media('Solo') },
        singleInfoJson: '{"id":"solo"}'
      })
    })
    const job = m.add('https://site/watch?v=solo&list=mix', options)
    const waiting = await settled(job.id)
    expect(waiting.status).toBe('waiting')
    expect(waiting.pending?.type).toBe('playlist')
    m.resolvePlaylist(job.id, { choice: 'single' })
    const done = await settled(job.id)
    expect(done.status).toBe('completed')
    expect(downloads).toHaveLength(1)
    expect(downloads[0]!.fileBase).toBe('Solo')
    expect(done.noPlaylist).toBe(true)
  })

  it('asks what to do with playlists: selected entries become jobs in a sub-folder', async () => {
    const entries = ['a', 'b', 'c'].map((x) => ({ url: `https://site/${x}`, title: x.toUpperCase(), duration: 1, thumbnail: null }))
    let calls = 0
    const { m, downloads } = setup({
      analyze: async (url, _ctx, _s, opts) => {
        calls++
        if (calls === 1) return { kind: 'playlist', playlist: { title: 'Mia: lista', thumbnail: null, entries, singleVideo: null }, singleInfoJson: null }
        expect(opts?.noPlaylist).toBe(true)
        return { kind: 'video', media: media(url.split('/').pop()!.toUpperCase()), infoJson: '{}' }
      }
    })
    const removed: string[] = []
    m.on('removed', (id) => removed.push(id))
    const job = m.add('https://site/playlist', options)
    await vi.waitFor(() => expect(m.get(job.id)?.status).toBe('waiting'))
    m.resolvePlaylist(job.id, { choice: 'entries', urls: ['https://site/a', 'https://site/c'] })
    expect(removed).toEqual([job.id])
    await vi.waitFor(() => expect(m.list().every((j) => j.status === 'completed')).toBe(true))
    expect(downloads.map((d) => d.fileBase).sort()).toEqual(['01 - A', '03 - C'])
    expect(downloads[0]!.outputDir).toBe(join('/downloads', 'Mia꞉ lista'))
  })

  it('falls back to the page scanner when yt-dlp does not support the site', async () => {
    const sniff = vi.fn(async () => sniffResult([candidate('https://cdn/master.m3u8')]))
    const { m, downloads, settled } = setup({
      analyze: async () => {
        throw new AnalyzeError({ code: 'unsupported', message: 'Unsupported URL' })
      },
      sniff
    })
    const statuses: string[] = []
    m.on('job', (j) => statuses.push(j.status))
    const done = await settled(m.add('https://page/', options).id)
    expect(statuses).toContain('scanning')
    expect(done.status).toBe('completed')
    expect(done.source).toBe('sniffer')
    expect(done.title).toBe('Titolo pagina')
    expect(downloads[0]).toMatchObject({ url: 'https://cdn/master.m3u8', infoJsonFile: null, headers: { Referer: 'https://page/', 'User-Agent': 'UA' } })
  })

  it('lets the user choose when the scan is ambiguous', async () => {
    const cands = [candidate('https://cdn/a.m3u8'), candidate('https://cdn/b.mp4', { kind: 'progressive', duration: 90 })]
    const { m, downloads, settled } = setup({
      analyze: async () => {
        throw new AnalyzeError({ code: 'unsupported', message: 'x' })
      },
      sniff: async () => sniffResult(cands, { ambiguous: true })
    })
    const job = m.add('https://page/', options)
    const waiting = await settled(job.id)
    expect(waiting.pending?.type).toBe('stream')
    m.chooseStream(job.id, 'https://cdn/b.mp4')
    const done = await settled(job.id)
    expect(done.status).toBe('completed')
    expect(downloads[0]!.url).toBe('https://cdn/b.mp4')
  })

  it('reports DRM and missing media', async () => {
    const fail = async () => {
      throw new AnalyzeError({ code: 'unsupported', message: 'Unsupported URL' })
    }
    const drm = setup({ analyze: fail, sniff: async () => sniffResult([], { drmDetected: true }) })
    expect((await drm.settled(drm.m.add('https://a/', options).id)).error?.code).toBe('drm')
    const none = setup({ analyze: fail })
    expect((await none.settled(none.m.add('https://a/', options).id)).error?.code).toBe('no_media')
    const login = setup({
      analyze: async () => {
        throw new AnalyzeError({ code: 'login_required', message: 'Sign in' })
      }
    })
    const j = await login.settled(login.m.add('https://a/', options).id)
    expect(j.error?.code).toBe('login_required')
  })

  it('cancels a running download', async () => {
    let aborted = false
    const { m, settled } = setup({
      download: (_req, _ctx, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DownloadError({ code: 'cancelled', message: 'x' }))
          })
        })
    })
    const job = m.add('https://site/long', options)
    await vi.waitFor(() => expect(m.get(job.id)!.status).toBe('downloading'))
    m.cancel(job.id)
    expect(m.get(job.id)!.status).toBe('cancelled')
    await vi.waitFor(() => expect(aborted).toBe(true))
  })

  it('retries once with a fresh extraction when the saved info is stale', async () => {
    const reqs: DownloadRequest[] = []
    const { m, settled } = setup({
      download: async (req) => {
        reqs.push(req)
        if (req.infoJsonFile) throw new DownloadError({ code: 'forbidden', message: 'HTTP Error 403' })
        return '/ok.mp4'
      }
    })
    const done = await settled(m.add('https://site/x', options).id)
    expect(done.status).toBe('completed')
    expect(reqs.map((r) => !!r.infoJsonFile)).toEqual([true, false])
  })

  it('fails clearly when the engine cannot be installed, and can be retried', async () => {
    let ok = false
    const { m, settled } = setup({
      engine: async () => {
        if (!ok) throw new Error('offline')
        return { ytdlp: 'y', deno: 'd', ffmpegDir: 'f' }
      }
    })
    const job = m.add('https://site/x', options)
    expect((await settled(job.id)).error?.code).toBe('engine_missing')
    ok = true
    m.retry(job.id)
    expect((await settled(job.id)).status).toBe('completed')
  })

  it('restores history: running jobs become "interrupted", queued ones restart', async () => {
    const { m, settled } = setup()
    const running = { ...newJob('https://site/r', options), status: 'downloading' as const }
    const queued = newJob('https://site/q', options)
    const p = settled(queued.id)
    m.load([running, queued])
    expect(m.get(running.id)!.error?.code).toBe('interrupted')
    expect((await p).status).toBe('completed')
  })
})
