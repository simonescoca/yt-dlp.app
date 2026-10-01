/** Types shared between the main process, the preload script and the UI. */

export type ComponentId = 'yt-dlp' | 'deno' | 'ffmpeg'

export type ComponentPhase = 'missing' | 'ready' | 'checking' | 'downloading' | 'installing' | 'error'

export interface ComponentState {
  id: ComponentId
  phase: ComponentPhase
  /** Installed version, if any. */
  version: string | null
  /** Newest upstream version seen at the last check. */
  latestVersion: string | null
  /** Download progress 0..1 while `phase === 'downloading'`. */
  progress: number | null
  /** Last error (install or update check). */
  error: string | null
  lastCheck: number | null
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

export type Mode = 'video' | 'audio'
export const VIDEO_FORMATS = ['mp4', 'mkv', 'webm', 'mov'] as const
export const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'ogg'] as const
export type VideoFormat = (typeof VIDEO_FORMATS)[number]
export type AudioFormat = (typeof AUDIO_FORMATS)[number]

/** What the user asked for: everything needed to build the yt-dlp command. */
export interface DownloadOptions {
  mode: Mode
  videoFormat: VideoFormat
  audioFormat: AudioFormat
  /** Destination folder (absolute). */
  folder: string
  embedMetadata: boolean
  embedThumbnail: boolean
  /** Prefer H.264/AAC streams (plays everywhere) over the absolute best codecs. */
  preferCompatible: boolean
}

/** Why a download failed, so the UI can explain it in plain words. */
export type ErrorCode =
  | 'unsupported'
  | 'no_media'
  | 'drm'
  | 'login_required'
  | 'private'
  | 'age_restricted'
  | 'geo_blocked'
  | 'unavailable'
  | 'live_not_started'
  | 'not_found'
  | 'forbidden'
  | 'network'
  | 'rate_limited'
  | 'disk_full'
  | 'permission'
  | 'ffmpeg'
  | 'engine_missing'
  | 'cancelled'
  | 'unknown'

export interface JobError {
  code: ErrorCode
  /** Raw message (last yt-dlp "ERROR:" line or exception message). */
  message: string
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface MediaSummary {
  id: string | null
  title: string
  thumbnail: string | null
  /** Seconds. */
  duration: number | null
  uploader: string | null
  /** yt-dlp extractor name ("youtube", "vimeo", "generic"...) or "sniffer". */
  extractor: string
  webpageUrl: string
  isLive: boolean
}

export interface PlaylistEntry {
  url: string
  title: string
  duration: number | null
  thumbnail: string | null
}

export interface PlaylistSummary {
  title: string
  thumbnail: string | null
  entries: PlaylistEntry[]
  /** Set when the URL also points to one specific video (e.g. YouTube watch?v=…&list=…). */
  singleVideo: MediaSummary | null
}

// ---------------------------------------------------------------------------
// Page scanner ("Network tab" sniffer)
// ---------------------------------------------------------------------------

export type StreamKind = 'hls' | 'dash' | 'ism' | 'progressive' | 'audio'

export interface StreamCandidate {
  id: string
  url: string
  kind: StreamKind
  mime: string | null
  /** Bytes (progressive files). */
  size: number | null
  width: number | null
  height: number | null
  /** Seconds. */
  duration: number | null
  live: boolean
  drm: boolean
  ad: boolean
  /** Page / frame that requested it (sent as Referer). */
  referer: string
  /** Headers to replay when downloading (User-Agent, Origin...). */
  headers: Record<string, string>
  /** Ranking score (higher is better). */
  score: number
}

export interface SniffResult {
  pageUrl: string
  pageTitle: string
  thumbnail: string | null
  candidates: StreamCandidate[]
  /** Best candidate (null when nothing downloadable was found). */
  best: StreamCandidate | null
  /** True when several distinct plausible videos were found: the user should choose. */
  ambiguous: boolean
  /** DRM-protected playback was detected (license requests or protected manifests). */
  drmDetected: boolean
}
