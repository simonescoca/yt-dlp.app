import { AUDIO_FORMATS, VIDEO_FORMATS, type Settings } from '@shared/types'

export function defaultSettings(downloadsFolder: string): Settings {
  return {
    mode: 'video',
    videoFormat: 'mp4',
    audioFormat: 'mp3',
    folder: downloadsFolder,
    embedMetadata: true,
    embedThumbnail: true,
    preferCompatible: false,
    maxConcurrent: 2,
    language: 'auto',
    theme: 'system',
    ytdlpChannel: 'nightly'
  }
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback

/** Validates (possibly old or hand-edited) settings, falling back to defaults field by field. */
export function sanitizeSettings(raw: unknown, defaults: Settings): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (k: keyof Settings): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (defaults[k] as boolean))
  const n = Number(r['maxConcurrent'])
  return {
    mode: oneOf(r['mode'], ['video', 'audio'] as const, defaults.mode),
    videoFormat: oneOf(r['videoFormat'], VIDEO_FORMATS, defaults.videoFormat),
    audioFormat: oneOf(r['audioFormat'], AUDIO_FORMATS, defaults.audioFormat),
    folder: typeof r['folder'] === 'string' && r['folder'] ? (r['folder'] as string) : defaults.folder,
    embedMetadata: bool('embedMetadata'),
    embedThumbnail: bool('embedThumbnail'),
    preferCompatible: bool('preferCompatible'),
    maxConcurrent: Number.isInteger(n) && n >= 1 && n <= 5 ? n : defaults.maxConcurrent,
    language: oneOf(r['language'], ['auto', 'it', 'en'] as const, defaults.language),
    theme: oneOf(r['theme'], ['system', 'light', 'dark'] as const, defaults.theme),
    ytdlpChannel: oneOf(r['ytdlpChannel'], ['nightly', 'stable'] as const, defaults.ytdlpChannel)
  }
}
