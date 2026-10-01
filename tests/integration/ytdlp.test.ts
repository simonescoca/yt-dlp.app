import { mkdtempSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DownloadOptions } from '../../src/shared/types'
import { analyze, AnalyzeError } from '../../src/main/ytdlp/analyze'
import { download, DownloadError } from '../../src/main/ytdlp/download'
import type { ProgressSnapshot } from '../../src/main/ytdlp/progress'
import type { EngineContext } from '../../src/main/ytdlp/runner'
import { ensureMedia, MEDIA_DIR } from '../fixtures/media'
import { startFixtureServer, type FixtureServer } from '../fixtures/server'
import { devEnginePaths, ffprobe } from './env'

const paths = devEnginePaths()
const ctx: EngineContext = { paths }
let server: FixtureServer
let out: string

const opts = (o: Partial<DownloadOptions> = {}): DownloadOptions => ({
  mode: 'video',
  videoFormat: 'mp4',
  audioFormat: 'mp3',
  folder: out,
  embedMetadata: true,
  embedThumbnail: true,
  preferCompatible: false,
  ...o
})

async function run(url: string, o: DownloadOptions, fileBase: string, extra: { signal?: AbortSignal } = {}) {
  const progress: ProgressSnapshot[] = []
  const file = await download(
    { url, options: o, outputDir: out, fileBase, tempDir: mkdtempSync(join(tmpdir(), 'grabbit-tmp-')) },
    ctx,
    { signal: extra.signal, onProgress: (p) => progress.push(p) }
  )
  return { file, progress }
}

beforeAll(async () => {
  ensureMedia(join(paths.ffmpegDir, 'ffmpeg'))
  // Serves the media slowly under /slow/ (to test cancellation mid-download).
  server = await startFixtureServer([MEDIA_DIR], (req, res) => {
    if (!req.url?.startsWith('/slow/')) return false
    const file = join(MEDIA_DIR, req.url.slice('/slow/'.length))
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': statSync(file).size })
    const stream = createReadStream(file, { highWaterMark: 16 * 1024 })
    stream.on('data', () => {
      stream.pause()
      setTimeout(() => stream.resume(), 100)
    })
    stream.pipe(res)
    return true
  })
  out = mkdtempSync(join(tmpdir(), 'grabbit-out-'))
})

afterAll(async () => {
  await server?.close()
})

describe('analyze', () => {
  it('reads a direct mp4, an HLS master and a DASH manifest', async () => {
    for (const path of ['/video.mp4', '/hls/master.m3u8', '/dash/manifest.mpd']) {
      const r = await analyze(server.origin + path, ctx)
      expect(r.kind).toBe('video')
      if (r.kind === 'video') {
        expect(r.media.extractor).toBe('generic')
        expect(JSON.parse(r.infoJson).formats.length).toBeGreaterThan(0)
      }
    }
  })
  it('reports unsupported pages and missing pages', async () => {
    await expect(analyze(server.origin + '/nothing-here.mp4x', ctx)).rejects.toMatchObject({ error: { code: 'not_found' } })
    const html = await analyze(`${server.origin}/`, ctx).catch((e: AnalyzeError) => e)
    expect(html).toBeInstanceOf(AnalyzeError)
  })
})

describe('download (local fixtures)', () => {
  it('picks the best HLS variant (720p) and remuxes into mp4 with progress', async () => {
    const { file, progress } = await run(server.origin + '/hls/master.m3u8', opts(), 'hls best')
    expect(basename(file)).toBe('hls best.mp4')
    const p = ffprobe(paths, file)
    const v = p.streams.find((s) => s.codec_type === 'video')!
    expect([v.width, v.height]).toEqual([1280, 720])
    expect(p.streams.some((s) => s.codec_type === 'audio')).toBe(true)
    expect(progress.some((s) => s.stage === 'downloading' && (s.fraction ?? 0) > 0 && (s.fraction ?? 0) < 1)).toBe(true)
    expect(progress.at(-1)!.stage).toBe('finishing')
  })

  it('merges DASH video + audio into mp4, mkv and mov without re-encoding', async () => {
    for (const fmt of ['mp4', 'mkv', 'mov'] as const) {
      const { file, progress } = await run(server.origin + '/dash/manifest.mpd', opts({ videoFormat: fmt }), `dash ${fmt}`)
      expect(file.endsWith(`.${fmt}`)).toBe(true)
      const p = ffprobe(paths, file)
      expect(p.streams.map((s) => s.codec_name).sort()).toEqual(['aac', 'h264'])
      expect(progress.some((s) => s.stage === 'merging')).toBe(true)
    }
  })

  it('produces a real WebM (VP8/VP9/AV1 + Opus/Vorbis) even from H.264 sources', async () => {
    const { file } = await run(server.origin + '/video.mp4', opts({ videoFormat: 'webm' }), 'to webm')
    expect(file.endsWith('.webm')).toBe(true)
    const codecs = ffprobe(paths, file).streams.map((s) => s.codec_name)
    expect(codecs.some((c) => ['vp8', 'vp9', 'av1'].includes(c))).toBe(true)
    expect(codecs.some((c) => ['opus', 'vorbis'].includes(c))).toBe(true)
  }, 300_000)

  it.each([
    ['mp3', 'mp3'],
    ['m4a', 'aac'],
    ['opus', 'opus'],
    ['flac', 'flac'],
    ['wav', 'pcm_s16le'],
    ['ogg', 'vorbis']
  ] as const)('extracts audio as %s', async (fmt, codec) => {
    const { file } = await run(server.origin + '/dash/manifest.mpd', opts({ mode: 'audio', audioFormat: fmt }), `audio ${fmt}`)
    expect(file.endsWith(`.${fmt}`)).toBe(true)
    const p = ffprobe(paths, file)
    expect(p.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name)).toEqual([codec])
    if (fmt === 'mp3') expect(p.format.tags?.title).toBe('manifest')
  })

  it('cancels a running download', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const pending = run(server.origin + '/slow/video.mp4', opts(), 'cancel me', { signal: ac.signal })
    setTimeout(() => ac.abort(), 2500)
    await expect(pending).rejects.toMatchObject({ error: { code: 'cancelled' } })
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(readdirSync(out).some((f) => f.startsWith('cancel me'))).toBe(false)
  })

  it('reports HTTP errors', async () => {
    const err = await run(server.origin + '/missing.mp4', opts(), 'missing').catch((e: DownloadError) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect((err as DownloadError).error.code).toBe('not_found')
  })
})

describe.runIf(process.env['GRABBIT_NET_TESTS'] === '1')('YouTube (network)', () => {
  const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
  it('analyzes a video (Deno solves the JS challenge)', async () => {
    const r = await analyze(url, ctx)
    expect(r.kind).toBe('video')
    if (r.kind !== 'video') return
    expect(r.media).toMatchObject({ title: 'Me at the zoo', extractor: 'youtube', duration: 19 })
    expect(JSON.parse(r.infoJson).formats.length).toBeGreaterThan(5)
  })

  // YouTube answers 403 to downloads from datacenter IPs without a PO token:
  // run this on a residential connection (GRABBIT_YT_DOWNLOAD=1).
  it.runIf(process.env['GRABBIT_YT_DOWNLOAD'] === '1')('downloads the best video as mp4 and the best audio as mp3', async () => {
    const r = await analyze(url, ctx)
    if (r.kind !== 'video') throw new Error('expected a video')
    const formats = JSON.parse(r.infoJson).formats as { height?: number; vcodec?: string }[]
    const maxHeight = Math.max(...formats.filter((f) => f.vcodec && f.vcodec !== 'none').map((f) => f.height ?? 0))

    const v = await run(url, opts(), 'zoo')
    const vs = ffprobe(paths, v.file).streams.find((s) => s.codec_type === 'video')!
    expect(vs.height).toBe(maxHeight)

    const a = await run(url, opts({ mode: 'audio' }), 'zoo')
    expect(a.file.endsWith('zoo.mp3')).toBe(true)
    expect(ffprobe(paths, a.file).streams.map((s) => s.codec_name)).toContain('mp3')
  })
})
