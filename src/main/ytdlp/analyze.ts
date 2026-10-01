import type { JobError, MediaSummary, PlaylistEntry, PlaylistSummary } from '@shared/types'
import { extractError } from './errors'
import { baseArgs, runYtdlp, type EngineContext } from './runner'

/** The subset of yt-dlp's info dict we read. */
export interface InfoDict {
  _type?: string
  id?: string
  title?: string
  fulltitle?: string
  thumbnail?: string
  thumbnails?: { url?: string; width?: number; height?: number; preference?: number }[]
  duration?: number
  uploader?: string
  channel?: string
  extractor?: string
  extractor_key?: string
  webpage_url?: string
  original_url?: string
  url?: string
  is_live?: boolean
  live_status?: string
  entries?: (InfoDict | null)[]
  playlist_count?: number
  formats?: unknown[]
}

export type AnalyzeResult =
  | { kind: 'video'; media: MediaSummary; infoJson: string }
  | { kind: 'playlist'; playlist: PlaylistSummary; singleInfoJson: string | null }

export class AnalyzeError extends Error {
  constructor(readonly error: JobError) {
    super(error.message)
  }
}

export function pickThumbnail(info: InfoDict): string | null {
  if (info.thumbnail) return info.thumbnail
  const thumbs = (info.thumbnails ?? []).filter((t) => t.url && /^https?:/.test(t.url))
  if (!thumbs.length) return null
  const best = [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0) || (b.preference ?? 0) - (a.preference ?? 0))
  // The largest thumbnails can be several MB: prefer a reasonable size for the UI.
  return (best.find((t) => (t.width ?? 0) <= 720) ?? best[0])!.url!
}

export function toMediaSummary(info: InfoDict, inputUrl: string): MediaSummary {
  return {
    id: info.id ?? null,
    title: (info.title ?? info.fulltitle ?? '').trim() || info.id || 'video',
    thumbnail: pickThumbnail(info),
    duration: typeof info.duration === 'number' ? info.duration : null,
    uploader: info.uploader ?? info.channel ?? null,
    extractor: (info.extractor ?? info.extractor_key ?? 'generic').toLowerCase(),
    webpageUrl: info.webpage_url ?? info.original_url ?? inputUrl,
    isLive: info.is_live === true || info.live_status === 'is_live'
  }
}

export function toPlaylistEntries(info: InfoDict): PlaylistEntry[] {
  const out: PlaylistEntry[] = []
  const seen = new Set<string>()
  for (const e of info.entries ?? []) {
    if (!e) continue
    // Flat entries carry the video page in `url`; full entries of generic pages carry the media
    // URL there, while their `webpage_url` is the playlist page itself (same for every entry).
    const url = [e.url, e.webpage_url].find((u) => u && /^https?:/.test(u) && !seen.has(u))
    if (!url) continue
    seen.add(url)
    out.push({
      url,
      title: (e.title ?? '').trim() || e.id || url,
      duration: typeof e.duration === 'number' ? e.duration : null,
      thumbnail: pickThumbnail(e)
    })
  }
  return out
}

/** Parses `yt-dlp -J` output; returns null when yt-dlp printed "null" (failure). */
export function parseInfoJson(stdout: string): InfoDict | null {
  const text = stdout.trim()
  if (!text || text === 'null') return null
  try {
    const parsed = JSON.parse(text.split('\n').at(-1)!) as InfoDict | null
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const isPlaylist = (info: InfoDict): boolean => info._type === 'playlist' || info._type === 'multi_video'

async function dumpJson(url: string, ctx: EngineContext, extra: string[], signal?: AbortSignal): Promise<{ info: InfoDict; raw: string }> {
  const res = await runYtdlp(ctx.paths.ytdlp, [...baseArgs(ctx), '-J', '--flat-playlist', ...extra, '--', url], {
    signal,
    collectStdout: true
  })
  if (res.cancelled) throw new AnalyzeError({ code: 'cancelled', message: 'Annullato' })
  const info = parseInfoJson(res.stdout)
  if (res.code !== 0 || !info) throw new AnalyzeError(extractError(res.stderr))
  return { info, raw: res.stdout.trim() }
}

/**
 * Asks yt-dlp what is behind `url`. For playlists it also checks whether the
 * URL points to one specific video, so the UI can offer "only this video".
 */
export async function analyze(url: string, ctx: EngineContext, signal?: AbortSignal, opts: { noPlaylist?: boolean } = {}): Promise<AnalyzeResult> {
  const first = await dumpJson(url, ctx, opts.noPlaylist ? ['--no-playlist'] : [], signal)
  if (!isPlaylist(first.info)) {
    return { kind: 'video', media: toMediaSummary(first.info, url), infoJson: first.raw }
  }
  const entries = toPlaylistEntries(first.info)
  let singleVideo: MediaSummary | null = null
  let singleInfoJson: string | null = null
  try {
    const single = await dumpJson(url, ctx, ['--no-playlist'], signal)
    if (!isPlaylist(single.info)) {
      singleVideo = toMediaSummary(single.info, url)
      singleInfoJson = single.raw
    }
  } catch (err) {
    if (err instanceof AnalyzeError && err.error.code === 'cancelled') throw err
  }
  if (!entries.length && singleVideo) {
    return { kind: 'video', media: singleVideo, infoJson: singleInfoJson! }
  }
  if (!entries.length) throw new AnalyzeError({ code: 'no_media', message: 'La playlist è vuota' })
  return {
    kind: 'playlist',
    playlist: {
      title: (first.info.title ?? '').trim() || 'Playlist',
      thumbnail: pickThumbnail(first.info) ?? entries[0]?.thumbnail ?? null,
      entries,
      singleVideo
    },
    singleInfoJson
  }
}
