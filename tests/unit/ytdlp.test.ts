import { describe, expect, it } from 'vitest'
import type { DownloadOptions } from '../../src/shared/types'
import { parseInfoJson, pickThumbnail, toMediaSummary, toPlaylistEntries } from '../../src/main/ytdlp/analyze'
import { downloadArgs } from '../../src/main/ytdlp/download'
import { classifyError, extractError } from '../../src/main/ytdlp/errors'
import { escapeTemplate, formatArgs, outputExtension, sanitizeFileName, uniqueFileName, videoFormatSelector } from '../../src/main/ytdlp/options'
import { ProgressTracker } from '../../src/main/ytdlp/progress'

const base: DownloadOptions = {
  mode: 'video',
  videoFormat: 'mp4',
  audioFormat: 'mp3',
  folder: '/tmp',
  embedMetadata: true,
  embedThumbnail: true,
  preferCompatible: false
}

describe('formatArgs', () => {
  it('defaults to the absolute best streams remuxed into mp4', () => {
    const args = formatArgs(base)
    expect(args.slice(0, 2)).toEqual(['-f', 'bv*+ba/b'])
    expect(args).toContain('--merge-output-format')
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4')
    expect(args[args.indexOf('--remux-video') + 1]).toBe('mp4')
    expect(args).not.toContain('--recode-video')
    expect(args).toEqual(expect.arrayContaining(['--embed-metadata', '--embed-thumbnail']))
  })
  it('prefers H.264/AAC in compatibility mode', () => {
    expect(videoFormatSelector('mp4', true)).toMatch(/^bv\*\[vcodec~='\^\(avc\|h264\)'\]\+ba\[acodec~='\^\(mp4a\|aac\)'\]/)
    expect(videoFormatSelector('mp4', true).endsWith('/bv*+ba/b')).toBe(true)
  })
  it('selects WebM-compatible codecs for webm, with conversion only as last resort', () => {
    const args = formatArgs({ ...base, videoFormat: 'webm' })
    expect(args[1]).toContain('vp0?[89]|av0?1')
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('webm/mkv')
    expect(args[args.indexOf('--recode-video') + 1]).toBe('webm')
    expect(args).not.toContain('--embed-thumbnail')
  })
  it('extracts audio at the best quality in the chosen format', () => {
    const args = formatArgs({ ...base, mode: 'audio', audioFormat: 'mp3' })
    expect(args).toEqual(expect.arrayContaining(['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']))
    expect(formatArgs({ ...base, mode: 'audio', audioFormat: 'ogg' })).toContain('vorbis')
    expect(formatArgs({ ...base, mode: 'audio', audioFormat: 'wav' })).not.toContain('--embed-thumbnail')
  })
  it('honours disabled extras', () => {
    const args = formatArgs({ ...base, embedMetadata: false, embedThumbnail: false })
    expect(args).not.toContain('--embed-metadata')
    expect(args).not.toContain('--embed-thumbnail')
  })
  it('knows the output extension', () => {
    expect(outputExtension(base)).toBe('mp4')
    expect(outputExtension({ ...base, mode: 'audio', audioFormat: 'ogg' })).toBe('ogg')
  })
})

describe('downloadArgs', () => {
  const ctx = { paths: { ytdlp: '/bin/yt-dlp', deno: '/bin/deno', ffmpegDir: '/bin/ff' }, cookiesFile: '/c.txt' }
  it('isolates config, uses our runtimes and output template', () => {
    const args = downloadArgs(
      { url: 'https://x.test/v', options: base, outputDir: '/out', fileBase: '100% real', tempDir: '/tmp/j1', headers: { Referer: 'https://x.test/', 'User-Agent': 'UA' } },
      ctx
    )
    expect(args[0]).toBe('--ignore-config')
    expect(args).toEqual(expect.arrayContaining(['--no-js-runtimes', '--js-runtimes', 'deno:/bin/deno', '--ffmpeg-location', '/bin/ff', '--cookies', '/c.txt']))
    expect(args).toEqual(expect.arrayContaining(['--paths', 'home:/out', '--paths', 'temp:/tmp/j1', '--output', '100%% real.%(ext)s']))
    expect(args).toEqual(expect.arrayContaining(['--add-header', 'Referer:https://x.test/', '--user-agent', 'UA']))
    expect(args.slice(-2)).toEqual(['--', 'https://x.test/v'])
  })
  it('loads the saved info JSON instead of the URL', () => {
    const args = downloadArgs({ url: 'u', infoJsonFile: '/i.json', options: base, outputDir: '/o', fileBase: 'f', tempDir: '/t' }, ctx)
    expect(args.slice(-2)).toEqual(['--load-info-json', '/i.json'])
    expect(args).not.toContain('--')
  })
})

describe('ProgressTracker', () => {
  const P = (o: object) => '@@P ' + JSON.stringify({ status: 'downloading', downloaded: null, total: null, estimate: null, speed: null, eta: null, fragment: null, fragments: null, format: null, ...o })
  it('weights video + audio parts by size', () => {
    const t = new ProgressTracker()
    expect(t.feed('@@R {"ids":["137","140"],"sizes":[900,null],"approx":[null,100],"format":"137+140","size":null,"sizeApprox":null}')).toBeNull()
    expect(t.feed(P({ downloaded: 450, total: 900, format: '137', speed: 1000, eta: 5 }))!.fraction).toBeCloseTo(0.45)
    t.feed(P({ status: 'finished', downloaded: 900, total: 900, format: '137' }))
    const s = t.feed(P({ downloaded: 50, total: 100, format: '140' }))!
    expect(s.fraction).toBeCloseTo(0.95)
    expect(s.totalBytes).toBe(1000)
  })
  it('falls back to per-part fractions and fragments when sizes are unknown', () => {
    const t = new ProgressTracker()
    t.feed('@@R {"ids":[],"sizes":[],"approx":[],"format":"2628","size":null,"sizeApprox":null}')
    expect(t.feed(P({ downloaded: 10, fragment: 1, fragments: 4, format: '2628' }))!.fraction).toBeCloseTo(0.25)
    expect(t.feed(P({ downloaded: 20, estimate: 40, format: '2628' }))!.fraction).toBeCloseTo(0.5)
  })
  it('reports post-processing stages and the final path', () => {
    const t = new ProgressTracker()
    expect(t.feed('@@PP {"status":"started","pp":"Merger"}')!.stage).toBe('merging')
    expect(t.feed('@@PP {"status":"started","pp":"ExtractAudio"}')!.stage).toBe('converting')
    expect(t.feed('@@PP {"status":"started","pp":"MoveFiles"}')).toBeNull()
    expect(t.feed('@@F "/out/a b.mp4"')!.stage).toBe('finishing')
    expect(t.finalPath).toBe('/out/a b.mp4')
    expect(t.feed('[download] something else')).toBeNull()
    expect(t.feed('@@P {broken')).toBeNull()
  })
})

describe('errors', () => {
  it.each([
    ['ERROR: Unsupported URL: https://example.com/page', 'unsupported'],
    ['ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser', 'login_required'],
    ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'age_restricted'],
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access', 'private'],
    ['ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader', 'unavailable'],
    ['ERROR: [Netflix] 123: This video is DRM protected', 'drm'],
    ['ERROR: [generic] missing: Unable to download webpage: HTTP Error 404: File not found', 'not_found'],
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'forbidden'],
    ['ERROR: [generic] x: Unable to download webpage: Failed to establish a new connection: [Errno 111] Connection refused', 'network'],
    ['ERROR: [youtube] x: This live event will begin in 3 hours.', 'live_not_started'],
    ['ERROR: The uploader has not made this video available in your country', 'geo_blocked'],
    ['ERROR: Postprocessing: Conversion failed!', 'ffmpeg'],
    ['ERROR: [Errno 28] No space left on device', 'disk_full'],
    ['ERROR: something odd', 'unknown']
  ])('classifies %s', (msg, code) => {
    expect(classifyError(msg)).toBe(code)
  })
  it('extracts the last ERROR line without prefixes', () => {
    const e = extractError('WARNING: foo\nERROR: first\nsome trace\nERROR: [generic] x: Unsupported URL: http://a\n')
    expect(e).toEqual({ code: 'unsupported', message: 'x: Unsupported URL: http://a' })
  })
})

describe('file names', () => {
  it('replaces characters forbidden on Windows/macOS', () => {
    expect(sanitizeFileName('AC/DC: Live? <2024> | "best" *')).toBe('AC⧸DC꞉ Live？ ‹2024› ｜ ”best” ＊')
    expect(sanitizeFileName('  trailing dots... ')).toBe('trailing dots')
    expect(sanitizeFileName('CON')).toBe('CON_')
    expect(sanitizeFileName('')).toBe('video_')
    expect(sanitizeFileName('a\u0000b\nc')).toBe('a b c')
  })
  it('limits length in UTF-8 bytes without splitting characters', () => {
    const s = sanitizeFileName('è'.repeat(200), 150)
    expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(150)
    expect(s).toBe('è'.repeat(75))
  })
  it('escapes % for output templates', () => {
    expect(escapeTemplate('100% (live)')).toBe('100%% (live)')
  })
  it('finds a free name', () => {
    const taken = new Set(['song.mp3', 'song (2).mp3'])
    expect(uniqueFileName('song', 'mp3', (n) => taken.has(n))).toBe('song (3)')
    expect(uniqueFileName('new', 'mp3', (n) => taken.has(n))).toBe('new')
  })
})

describe('analysis parsing', () => {
  it('parses -J output and summarises a video', () => {
    const info = parseInfoJson('{"id":"jNQXAC9IVRw","title":"Me at the zoo","duration":19,"extractor":"youtube","webpage_url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","thumbnails":[{"url":"https://i/1.jpg","width":120},{"url":"https://i/2.jpg","width":480},{"url":"https://i/3.jpg","width":1920}],"uploader":"jawed"}')!
    const m = toMediaSummary(info, 'https://youtu.be/jNQXAC9IVRw')
    expect(m).toMatchObject({ id: 'jNQXAC9IVRw', title: 'Me at the zoo', duration: 19, extractor: 'youtube', uploader: 'jawed', isLive: false })
    expect(m.thumbnail).toBe('https://i/2.jpg')
    expect(parseInfoJson('null')).toBeNull()
    expect(parseInfoJson('')).toBeNull()
  })
  it('lists playlist entries with usable URLs', () => {
    const entries = toPlaylistEntries({
      entries: [
        { _type: 'url', id: 'a', title: 'A', url: 'https://www.youtube.com/watch?v=a', duration: 10 },
        null,
        { _type: 'url', id: 'b', url: 'b' },
        { _type: 'url', id: 'c', webpage_url: 'https://x/c' }
      ]
    })
    expect(entries).toEqual([
      { url: 'https://www.youtube.com/watch?v=a', title: 'A', duration: 10, thumbnail: null },
      { url: 'https://x/c', title: 'c', duration: null, thumbnail: null }
    ])
    expect(pickThumbnail({ thumbnails: [] })).toBeNull()
  })
  it('keeps distinct URLs for videos found in the same page (generic playlists)', () => {
    const page = 'http://site/two.html'
    const entries = toPlaylistEntries({
      entries: [
        { id: '1', title: 'Due video (1)', url: 'http://site/long.mp4', webpage_url: page },
        { id: '2', title: 'Due video (2)', url: 'http://site/long2.mp4', webpage_url: page }
      ]
    })
    expect(entries.map((e) => e.url)).toEqual(['http://site/long.mp4', 'http://site/long2.mp4'])
  })
})
