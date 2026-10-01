import { describe, expect, it } from 'vitest'
import type { StreamCandidate } from '../../src/shared/types'
import { toNetscape } from '../../src/main/browser/cookies'
import { classifyResponse, looksLikeAd, looksLikeDrmLicense, looksLikeMediaUrl, totalSize } from '../../src/main/sniffer/classify'
import { parseAttributes, parseDash, parseHls, parseIsoDuration } from '../../src/main/sniffer/manifest'
import { isPlausibleMain, rankCandidates, scoreCandidate } from '../../src/main/sniffer/rank'

const resp = (url: string, headers: Record<string, string> = {}, extra: Partial<{ statusCode: number; method: string; resourceType: string }> = {}) => ({
  url,
  method: 'GET',
  statusCode: 200,
  headers,
  ...extra
})

describe('classifyResponse', () => {
  it('recognises manifests by MIME type or extension', () => {
    expect(classifyResponse(resp('https://cdn.x/a/master.m3u8?token=1'))?.kind).toBe('hls')
    expect(classifyResponse(resp('https://cdn.x/playlist', { 'content-type': 'application/vnd.apple.mpegurl' }))?.kind).toBe('hls')
    expect(classifyResponse(resp('https://cdn.x/p', { 'content-type': 'application/x-mpegURL; charset=utf-8' }))?.kind).toBe('hls')
    expect(classifyResponse(resp('https://cdn.x/v/manifest.mpd'))?.kind).toBe('dash')
    expect(classifyResponse(resp('https://cdn.x/v', { 'content-type': 'application/dash+xml' }))?.kind).toBe('dash')
    expect(classifyResponse(resp('https://cdn.x/v.ism/Manifest'))?.kind).toBe('ism')
  })
  it('recognises progressive files and their full size', () => {
    const c = classifyResponse(resp('https://cdn.x/movie.mp4', { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1023/52428800' }))
    expect(c).toEqual({ kind: 'progressive', mime: 'video/mp4', size: 52428800 })
    expect(classifyResponse(resp('https://cdn.x/stream?id=1', { 'content-type': 'video/webm', 'content-length': '999' }))?.kind).toBe('progressive')
    expect(classifyResponse(resp('https://cdn.x/song.mp3'))?.kind).toBe('audio')
    expect(classifyResponse(resp('https://cdn.x/blob', { 'content-type': 'application/octet-stream' }, { resourceType: 'media' }))?.kind).toBe('progressive')
  })
  it('ignores segments, errors, redirects and everything else', () => {
    expect(classifyResponse(resp('https://cdn.x/seg_001.ts', { 'content-type': 'video/mp2t' }))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/chunk-stream0-00001.m4s', { 'content-type': 'video/iso.segment' }))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/frag', { 'content-type': 'video/mp2t' }))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/a.mp4', {}, { statusCode: 404 }))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/a.mp4', {}, { statusCode: 302 }))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/a.mp4', {}, { statusCode: 304 }))?.kind).toBe('progressive')
    expect(classifyResponse(resp('https://cdn.x/app.js', { 'content-type': 'text/javascript' }))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/thumb.jpg', { 'content-type': 'image/jpeg' }))).toBeNull()
    expect(classifyResponse(resp('blob:https://x/123'))).toBeNull()
    expect(classifyResponse(resp('https://cdn.x/videoplayback?range=0-1000', { 'content-type': 'application/octet-stream' }))).toBeNull()
  })
  it('reads sizes', () => {
    expect(totalSize({ 'content-length': '42' })).toBe(42)
    expect(totalSize({ 'content-range': 'bytes 0-1/*' })).toBeNull()
    expect(totalSize({})).toBeNull()
  })
})

describe('heuristics', () => {
  it('spots ads', () => {
    expect(looksLikeAd('https://pubads.g.doubleclick.net/x.mp4')).toBe(true)
    expect(looksLikeAd('https://cdn.site.com/ads/preroll.mp4')).toBe(true)
    expect(looksLikeAd('https://cdn.site.com/vast/clip.m3u8')).toBe(true)
    expect(looksLikeAd('https://cdn.site.com/uploads/movie.mp4')).toBe(false)
    expect(looksLikeAd('https://cdn.site.com/videos/roadster.mp4')).toBe(false)
  })
  it('spots DRM license requests', () => {
    expect(looksLikeDrmLicense('https://lic.site.com/widevine/license', 'POST')).toBe(true)
    expect(looksLikeDrmLicense('https://x.com/drm/license?id=1', 'POST')).toBe(true)
    expect(looksLikeDrmLicense('https://x.com/license.txt', 'GET')).toBe(false)
  })
})

describe('HLS', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240,CODECS="avc1.64001e,mp4a.40.2"',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
    'https://other.cdn/hi.m3u8?sig=1'
  ].join('\n')
  it('parses master playlists', () => {
    const info = parseHls(master, 'https://cdn.x/v/master.m3u8')
    expect(info?.type).toBe('master')
    if (info?.type !== 'master') return
    expect(info.variants).toEqual([
      { url: 'https://cdn.x/v/low.m3u8', bandwidth: 528000, width: 426, height: 240 },
      { url: 'https://other.cdn/hi.m3u8?sig=1', bandwidth: 5000000, width: 1920, height: 1080 }
    ])
    expect(info.audioUrls).toEqual(['https://cdn.x/v/audio/en.m3u8'])
    expect(info.drm).toBe(false)
  })
  it('parses media playlists, live and DRM', () => {
    const vod = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4.0,\na.ts\n#EXTINF:3.5,\nb.ts\n#EXT-X-ENDLIST\n'
    expect(parseHls(vod, 'https://x/')).toEqual({ type: 'media', duration: 7.5, live: false, drm: false, segments: 2 })
    const live = '#EXTM3U\n#EXTINF:6,\na.ts\n'
    expect(parseHls(live, 'https://x/')).toMatchObject({ live: true })
    const fairplay = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://id",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST'
    expect(parseHls(fairplay, 'https://x/')).toMatchObject({ drm: true })
    expect(parseHls('<html>', 'https://x/')).toBeNull()
  })
  it('parses attribute lists with quoted commas', () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="a,b",RESOLUTION=1x2')).toEqual({ BANDWIDTH: '1', CODECS: 'a,b', RESOLUTION: '1x2' })
  })
})

describe('DASH', () => {
  it('parses durations, best resolution and DRM', () => {
    const mpd = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1H2M3.5S">
      <Period><AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
        <Representation id="1" bandwidth="800000" width="854" height="480"/>
        <Representation id="2" bandwidth="4000000" width="1920" height="1080"/>
      </AdaptationSet></Period></MPD>`
    expect(parseDash(mpd)).toEqual({ duration: 3723.5, live: false, width: 1920, height: 1080, bandwidth: 4000000, drm: true })
    expect(parseDash('<MPD type="dynamic"></MPD>')).toMatchObject({ live: true, drm: false, duration: null })
    expect(parseDash('not xml')).toBeNull()
  })
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT8S')).toBe(8)
    expect(parseIsoDuration('PT0H1M0.000S')).toBe(60)
    expect(parseIsoDuration('P1DT1S')).toBe(86401)
    expect(parseIsoDuration('nope')).toBeNull()
  })
})

describe('ranking', () => {
  const cand = (o: Partial<StreamCandidate>): StreamCandidate => {
    const base = {
      url: 'https://x/' + Math.random(),
      kind: 'progressive' as const,
      mime: null,
      size: null,
      width: null,
      height: null,
      duration: null,
      live: false,
      drm: false,
      ad: false,
      referer: 'https://x/',
      headers: {},
      ...o
    }
    return { ...base, id: base.url, score: scoreCandidate(base) }
  }
  it('prefers the long HD main video over ads, previews and audio', () => {
    const main = cand({ kind: 'hls', height: 1080, duration: 1800 })
    const ad = cand({ kind: 'progressive', ad: true, duration: 20, size: 3_000_000 })
    const preview = cand({ kind: 'progressive', duration: 10, height: 1080, size: 4_000_000 })
    const audio = cand({ kind: 'audio', duration: 1800 })
    const r = rankCandidates([ad, preview, audio, main])
    expect(r.best).toBe(main)
    expect(r.ambiguous).toBe(false)
    expect(isPlausibleMain(preview)).toBe(false)
  })
  it('flags two different long videos as ambiguous, but not two copies of the same one', () => {
    const a = cand({ kind: 'hls', height: 720, duration: 600 })
    const b = cand({ kind: 'progressive', height: 720, duration: 300, size: 50_000_000 })
    expect(rankCandidates([a, b]).ambiguous).toBe(true)
    const sameAsA = cand({ kind: 'dash', height: 720, duration: 600.4 })
    expect(rankCandidates([a, sameAsA]).ambiguous).toBe(false)
  })
  it('never picks DRM streams', () => {
    const drm = cand({ kind: 'dash', height: 2160, duration: 5000, drm: true })
    expect(rankCandidates([drm]).best).toBeNull()
  })
  it('a sharp short clip never beats a plausible main video, whatever its resolution', () => {
    const teaser = cand({ kind: 'progressive', height: 4320, duration: 2, size: 900_000 })
    const main = cand({ kind: 'progressive', height: 360, duration: 3900, size: 400_000_000 })
    expect(teaser.score).toBeGreaterThan(main.score) // by points alone the teaser would win
    const r = rankCandidates([teaser, main])
    expect(r.best).toBe(main)
    expect(r.sorted).toEqual([main, teaser])
    expect(r.doubtful).toBe(false)
    expect(r.ambiguous).toBe(false)
  })
  it('only short clips, tiny files or ads: doubtful (never downloaded without asking)', () => {
    const teaser = cand({ kind: 'progressive', duration: 2, height: 720, size: 800_000 })
    const r = rankCandidates([teaser])
    expect(r.best).toBe(teaser)
    expect(r.doubtful).toBe(true)
    expect(rankCandidates([cand({ kind: 'progressive', size: 200_000 })]).doubtful).toBe(true)
    expect(rankCandidates([cand({ kind: 'progressive', ad: true, duration: 600 })]).doubtful).toBe(true)
    expect(rankCandidates([]).doubtful).toBe(false)
    // Unknown duration (live, or not probed): not doubtful.
    expect(rankCandidates([cand({ kind: 'hls', height: 720 })]).doubtful).toBe(false)
  })
})

describe('direct media links', () => {
  it('tells media files and manifests from web pages', () => {
    expect(looksLikeMediaUrl('https://cdn/v/video.mp4?token=1')).toBe(true)
    expect(looksLikeMediaUrl('https://cdn/hls/master.m3u8')).toBe(true)
    expect(looksLikeMediaUrl('https://cdn/dash/manifest.mpd')).toBe(true)
    expect(looksLikeMediaUrl('https://cdn/a/song.mp3')).toBe(true)
    expect(looksLikeMediaUrl('https://site/episodes/some-title-episode-1/')).toBe(false)
    expect(looksLikeMediaUrl('https://site/watch?v=mp4')).toBe(false)
  })
})

describe('cookies.txt export', () => {
  it('writes the Netscape format read by yt-dlp', () => {
    const txt = toNetscape([
      { name: 'session', value: 'ok', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 1893456000.5 },
      { name: 'host', value: 'v', domain: 'example.com', hostOnly: true, path: '/a', session: true },
      { name: 'bad', value: 'x\ty', domain: 'example.com' }
    ])
    const lines = txt.trim().split('\n')
    expect(lines[0]).toBe('# Netscape HTTP Cookie File')
    expect(lines).toContain('#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\tsession\tok')
    expect(lines).toContain('example.com\tFALSE\t/a\tFALSE\t0\thost\tv')
    expect(txt).not.toContain('bad')
  })
})

describe('siteOf (sites list of the login window)', async () => {
  // web.ts imports electron only for types and BrowserWindow at call time.
  const { siteOf } = await import('../../src/main/browser/web')
  it('groups sub-domains under the site', () => {
    expect(siteOf('accounts.google.com')).toBe('google.com')
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(siteOf('.youtube.com')).toBe('youtube.com')
    expect(siteOf('vimeo.com')).toBe('vimeo.com')
  })
  it('keeps IP addresses and localhost as they are', () => {
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1')
    expect(siteOf('localhost')).toBe('localhost')
    expect(siteOf('[::1]')).toBe('[::1]')
  })
})
