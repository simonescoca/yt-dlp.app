import type { AudioFormat, DownloadOptions, VideoFormat } from '@shared/types'

/**
 * Pure helpers that turn the user's choices into yt-dlp arguments.
 *
 * Quality policy (agreed with the user): always the best available streams,
 * put in the requested container WITHOUT re-encoding when the container can
 * hold the codecs (mp4 and mkv hold everything). `preferCompatible` switches
 * to H.264 + AAC streams, which play everywhere (QuickTime, old players).
 */

const H264 = "vcodec~='^(avc|h264)'"
const AAC = "acodec~='^(mp4a|aac)'"
const H26X = "vcodec~='^(avc|h26[45]|hvc|hev)'"
const WEBM_V = "vcodec~='^(vp0?[89]|av0?1)'"
const WEBM_A = "acodec~='^(opus|vorbis)'"

/** yt-dlp `-f` expression for video downloads. */
export function videoFormatSelector(container: VideoFormat, preferCompatible: boolean): string {
  const best = 'bv*+ba/b'
  switch (container) {
    case 'mp4':
    case 'mkv':
      return preferCompatible ? `bv*[${H264}]+ba[${AAC}]/bv*[${H264}]+ba/b[${H264}]/${best}` : best
    case 'mov':
      // QuickTime containers only hold H.264/HEVC + AAC without re-encoding.
      return `bv*[${H26X}]+ba[${AAC}]/bv*[${H26X}]+ba/b[${H26X}]/${best}`
    case 'webm':
      // WebM only holds VP8/VP9/AV1 + Opus/Vorbis.
      return `bv*[${WEBM_V}]+ba[${WEBM_A}]/bv*[${WEBM_V}]+ba/b[ext=webm]/${best}`
  }
}

/** Final file extension produced for the chosen options. */
export function outputExtension(opts: Pick<DownloadOptions, 'mode' | 'videoFormat' | 'audioFormat'>): string {
  if (opts.mode === 'video') return opts.videoFormat
  return opts.audioFormat
}

/** yt-dlp's `--audio-format` value for each audio choice (".ogg" files hold Vorbis). */
function ytdlpAudioFormat(format: AudioFormat): string {
  return format === 'ogg' ? 'vorbis' : format
}

/** Containers yt-dlp can embed a cover image into. */
function canEmbedThumbnail(opts: Pick<DownloadOptions, 'mode' | 'videoFormat' | 'audioFormat'>): boolean {
  if (opts.mode === 'video') return opts.videoFormat !== 'webm'
  return opts.audioFormat !== 'wav'
}

/** Arguments that select, merge and convert the streams + embed extras. */
export function formatArgs(opts: DownloadOptions): string[] {
  const args: string[] = []
  if (opts.mode === 'video') {
    const c = opts.videoFormat
    args.push('-f', videoFormatSelector(c, opts.preferCompatible))
    switch (c) {
      case 'mp4':
      case 'mkv':
      case 'mov':
        // Remux (no re-encoding) also covers single-file formats that arrive in another container.
        args.push('--merge-output-format', c, '--remux-video', c)
        break
      case 'webm':
        // If no WebM-compatible streams exist, merge into mkv and convert as a last resort.
        args.push('--merge-output-format', 'webm/mkv', '--recode-video', 'webm')
        break
    }
  } else {
    args.push('-f', 'ba/b', '-x', '--audio-format', ytdlpAudioFormat(opts.audioFormat), '--audio-quality', '0')
  }
  if (opts.embedMetadata) args.push('--embed-metadata')
  if (opts.embedThumbnail && canEmbedThumbnail(opts)) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg')
  return args
}

// ---------------------------------------------------------------------------
// Machine-readable output
// ---------------------------------------------------------------------------

export const MARK = {
  progress: '@@P ',
  postprocess: '@@PP ',
  requested: '@@R ',
  file: '@@F '
} as const

/** Makes yt-dlp print progress and results as JSON lines we can parse reliably. */
export function reportingArgs(): string[] {
  return [
    '--newline',
    '--color',
    'never',
    '--progress',
    '--progress-template',
    'download:' +
      MARK.progress +
      '{"status":%(progress.status)j,"downloaded":%(progress.downloaded_bytes|null)s,' +
      '"total":%(progress.total_bytes|null)s,"estimate":%(progress.total_bytes_estimate|null)s,' +
      '"speed":%(progress.speed|null)s,"eta":%(progress.eta|null)s,' +
      '"fragment":%(progress.fragment_index|null)s,"fragments":%(progress.fragment_count|null)s,' +
      '"format":%(info.format_id|null)j}',
    '--progress-template',
    'postprocess:' + MARK.postprocess + '{"status":%(progress.status)j,"pp":%(progress.postprocessor)j}',
    '--print',
    'before_dl:' +
      MARK.requested +
      '{"ids":%(requested_formats.:.format_id|null)j,"sizes":%(requested_formats.:.filesize|null)j,' +
      '"approx":%(requested_formats.:.filesize_approx|null)j,"format":%(format_id|null)j,' +
      '"size":%(filesize|null)s,"sizeApprox":%(filesize_approx|null)s}',
    '--print',
    'after_move:' + MARK.file + '%(filepath)j'
  ]
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * Turns a title into a file name that is valid on Windows and macOS:
 * no reserved characters, no control characters, no trailing dots/spaces,
 * at most `maxBytes` UTF-8 bytes (without cutting a character in half).
 */
export function sanitizeFileName(title: string, maxBytes = 150): string {
  let name = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, (c) => ({ '<': '‹', '>': '›', ':': '꞉', '"': '”', '/': '⧸', '\\': '⧹', '|': '｜', '?': '？', '*': '＊' })[c]!)
    .replace(/\s+/g, ' ')
    .trim()
  const enc = new TextEncoder()
  if (enc.encode(name).length > maxBytes) {
    const chars = [...name]
    while (chars.length && enc.encode(chars.join('')).length > maxBytes) chars.pop()
    name = chars.join('').trim()
  }
  name = name.replace(/[. ]+$/, '')
  if (!name || WINDOWS_RESERVED.test(name)) name = `${name || 'video'}_`
  return name
}

/** Escapes a literal string for use inside a yt-dlp output template. */
export function escapeTemplate(s: string): string {
  return s.replace(/%/g, '%%')
}

/** Picks "name.ext", "name (2).ext", ... avoiding names for which `taken` returns true. */
export function uniqueFileName(base: string, ext: string, taken: (fileName: string) => boolean): string {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${base}.${ext}` : `${base} (${i}).${ext}`
    if (!taken(candidate)) return candidate.slice(0, -(ext.length + 1))
  }
}
