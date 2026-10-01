/**
 * Pure helpers that decide whether a network request carries media, the way a
 * human would read the DevTools "Network" tab (by MIME type and URL shape).
 */

export type MediaKind = 'hls' | 'dash' | 'ism' | 'progressive' | 'audio'

export interface ObservedResponse {
  url: string
  method: string
  statusCode: number
  /** Lower-cased response headers (first value only). */
  headers: Record<string, string>
  resourceType?: string
}

export interface Classified {
  kind: MediaKind
  mime: string | null
  /** Total size of the resource when known (Content-Length / Content-Range). */
  size: number | null
}

const HLS_MIME = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(x-)?mpegurl|video\/(x-)?mpegurl)$/i
const DASH_MIME = /^application\/dash\+xml$/i
const SEGMENT_MIME = /^(video\/(mp2t|iso\.segment)|audio\/(aac|mp2t)|application\/(octet-stream))$/i
const SEGMENT_EXT = /\.(ts|m4s|m4f|cmfv|cmfa|aac|vtt|webvtt|srt|key|jpg|jpeg|png|webp|gif|js|css|json|woff2?)$/i
const PROGRESSIVE_EXT = /\.(mp4|m4v|webm|mov|mkv|flv|ogv|3gp|avi)$/i
const AUDIO_EXT = /\.(mp3|m4a|ogg|oga|opus|flac|wav)$/i

/** URL path without query/hash, lower-cased. */
export function urlPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase()
  } catch {
    return url.split(/[?#]/)[0]!.toLowerCase()
  }
}

/** Total size from Content-Range ("bytes 0-1/12345") or Content-Length. */
export function totalSize(headers: Record<string, string>): number | null {
  const range = /\/(\d+)\s*$/.exec(headers['content-range'] ?? '')
  if (range) return Number(range[1])
  const len = Number(headers['content-length'])
  return Number.isFinite(len) && len > 0 ? len : null
}

/** Returns what kind of media a response carries, or null for everything else (incl. segments). */
export function classifyResponse(r: ObservedResponse): Classified | null {
  // Redirects are followed by another request; 304 is a valid (cached) response.
  if (r.statusCode >= 400 || (r.statusCode >= 300 && r.statusCode !== 304) || r.method === 'OPTIONS') return null
  if (!/^https?:/i.test(r.url)) return null
  const mime = (r.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() || null
  const path = urlPath(r.url)
  const size = totalSize(r.headers)

  if ((mime && HLS_MIME.test(mime)) || path.endsWith('.m3u8') || path.endsWith('.m3u')) return { kind: 'hls', mime, size }
  if ((mime && DASH_MIME.test(mime)) || path.endsWith('.mpd')) return { kind: 'dash', mime, size }
  if (/\.ism(l)?\/manifest/i.test(path) || /\/manifest\(format=/i.test(r.url)) return { kind: 'ism', mime, size }

  if (SEGMENT_EXT.test(path)) return null
  // Loaded directly by a <video>/<audio> element: media whatever the MIME type says.
  if (r.resourceType === 'media') return { kind: mime?.startsWith('audio/') ? 'audio' : 'progressive', mime, size }
  if (mime && SEGMENT_MIME.test(mime) && !PROGRESSIVE_EXT.test(path) && !AUDIO_EXT.test(path)) return null
  // Byte-range sub-requests of fragmented streams often carry these hints.
  if (/[?&](range|bytestart|byterange)=/i.test(r.url) && !PROGRESSIVE_EXT.test(path)) return null

  if ((mime && /^video\//.test(mime)) || PROGRESSIVE_EXT.test(path)) return { kind: 'progressive', mime, size }
  if ((mime && /^audio\//.test(mime)) || AUDIO_EXT.test(path)) return { kind: 'audio', mime, size }
  return null
}

const AD_HOSTS =
  /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|imasdk\.googleapis\.com|adnxs\.com|adsrvr\.org|fwmrm\.net|spotxchange\.com|spotx\.tv|springserve\.com|moatads\.com|teads\.tv|adform\.net|smartadserver\.com|criteo\.com|pubmatic\.com|rubiconproject\.com|innovid\.com|serving-sys\.com|2mdn\.net|yieldmo\.com|adsafeprotected\.com|outbrain\.com|taboola\.com)$/i
const AD_PATH = /(^|[/_.-])(ads?|adserver|preroll|midroll|postroll|vast|vpaid|advert|sponsor|promo|commercial)([/_.-]|$)/i

/** Heuristic: does this URL look like an advertisement? */
export function looksLikeAd(url: string): boolean {
  try {
    const u = new URL(url)
    return AD_HOSTS.test(u.hostname) || AD_PATH.test(u.pathname)
  } catch {
    return false
  }
}

/** Heuristic: is this request a DRM license exchange? */
export function looksLikeDrmLicense(url: string, method: string): boolean {
  return /widevine|playready|fairplay|drm.*licen[cs]e|licen[cs]e.*(drm|widevine)|\/licen[cs]e(\?|$)|getlicense|clearkey/i.test(url) && method === 'POST'
}
