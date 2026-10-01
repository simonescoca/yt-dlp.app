/**
 * Minimal HLS (m3u8) and DASH (mpd) readers: just what is needed to rank
 * streams (resolution, duration), recognise variant playlists and DRM.
 */

export interface HlsVariant {
  url: string
  bandwidth: number | null
  width: number | null
  height: number | null
}

export type HlsInfo =
  | { type: 'master'; variants: HlsVariant[]; audioUrls: string[]; drm: boolean }
  | { type: 'media'; duration: number; live: boolean; drm: boolean; segments: number }

const resolve = (ref: string, base: string): string => {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

/** Parses an attribute list: KEY=VALUE,KEY="quoted, value",... */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1]!] = m[2]!.replace(/^"|"$/g, '')
  return out
}

/** SAMPLE-AES with a key system (Widevine/FairPlay/PlayReady) is DRM; plain AES-128 is not. */
function hlsKeyIsDrm(line: string): boolean {
  const a = parseAttributes(line.slice(line.indexOf(':') + 1))
  if (!a['METHOD'] || a['METHOD'] === 'NONE' || a['METHOD'] === 'AES-128') return false
  return /streamingkeydelivery|widevine|playready|edef8ba9|9a04f079|com\.microsoft/i.test(`${a['KEYFORMAT'] ?? ''} ${a['URI'] ?? ''}`) || a['METHOD'] === 'SAMPLE-AES'
}

export function parseHls(text: string, baseUrl: string): HlsInfo | null {
  if (!text.trimStart().startsWith('#EXTM3U')) return null
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  let drm = false
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: HlsVariant[] = []
    const audioUrls: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line.startsWith('#EXT-X-SESSION-KEY') && hlsKeyIsDrm(line)) drm = true
      if (line.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(line)) {
        const uri = parseAttributes(line.slice(13))['URI']
        if (uri) audioUrls.push(resolve(uri, baseUrl))
      }
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue
      const attrs = parseAttributes(line.slice(18))
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'))
      if (!uri) continue
      const res = /^(\d+)x(\d+)$/.exec(attrs['RESOLUTION'] ?? '')
      variants.push({
        url: resolve(uri, baseUrl),
        bandwidth: attrs['BANDWIDTH'] ? Number(attrs['BANDWIDTH']) : null,
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null
      })
    }
    return { type: 'master', variants, audioUrls, drm }
  }
  let duration = 0
  let segments = 0
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration += parseFloat(line.slice(8)) || 0
      segments++
    } else if (line.startsWith('#EXT-X-KEY') && hlsKeyIsDrm(line)) {
      drm = true
    }
  }
  const live = !lines.includes('#EXT-X-ENDLIST') && !lines.some((l) => /#EXT-X-PLAYLIST-TYPE:VOD/.test(l))
  return { type: 'media', duration, live, drm, segments }
}

/** ISO-8601 duration (PT1H2M3.5S) → seconds. */
export function parseIsoDuration(s: string | null | undefined): number | null {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec((s ?? '').trim())
  if (!m) return null
  const [, d, h, min, sec] = m
  return (Number(d ?? 0) * 24 + Number(h ?? 0)) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0)
}

export interface DashInfo {
  duration: number | null
  live: boolean
  width: number | null
  height: number | null
  bandwidth: number | null
  drm: boolean
}

/** DRM systems: Widevine, PlayReady, FairPlay (ClearKey/"mp4protection" alone is not enough to block). */
const DASH_DRM = /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|9a04f079-9840-4286-ab92-e65be0885f95|94ce86fb-07ff-4f43-adb8-93d2fa968ca2/i

export function parseDash(text: string): DashInfo | null {
  if (!/<MPD[\s>]/.test(text)) return null
  const mpd = /<MPD\b([^>]*)>/.exec(text)?.[1] ?? ''
  const attr = (src: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(src)?.[1] ?? null
  let width: number | null = null
  let height: number | null = null
  let bandwidth: number | null = null
  for (const m of text.matchAll(/<Representation\b([^>]*)>/g)) {
    const a = m[1]!
    const h = Number(attr(a, 'height'))
    if (h && h > (height ?? 0)) {
      height = h
      width = Number(attr(a, 'width')) || null
    }
    const bw = Number(attr(a, 'bandwidth'))
    if (bw && bw > (bandwidth ?? 0)) bandwidth = bw
  }
  // AdaptationSet-level size (some packagers put it there).
  if (!height) {
    for (const m of text.matchAll(/<AdaptationSet\b([^>]*)>/g)) {
      const h = Number(attr(m[1]!, 'maxHeight') ?? attr(m[1]!, 'height'))
      if (h && h > (height ?? 0)) {
        height = h
        width = Number(attr(m[1]!, 'maxWidth') ?? attr(m[1]!, 'width')) || null
      }
    }
  }
  return {
    duration: parseIsoDuration(attr(mpd, 'mediaPresentationDuration')),
    live: attr(mpd, 'type') === 'dynamic',
    width,
    height,
    bandwidth,
    drm: DASH_DRM.test(text)
  }
}
