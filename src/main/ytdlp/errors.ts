import type { ErrorCode, JobError } from '@shared/types'

/** Ordered rules: the first matching pattern decides the error code. */
const RULES: [RegExp, ErrorCode][] = [
  [/No space left on device|\[Errno 28\]|disk (is )?full/i, 'disk_full'],
  [/Permission denied|\[Errno 13\]|Access is denied|Operation not permitted/i, 'permission'],
  [/\bDRM\b|Widevine|PlayReady|FairPlay/i, 'drm'],
  [/confirm your age|age[- ]restricted|age verification|inappropriate for some users/i, 'age_restricted'],
  [/Private video|video is private|This video has been made private/i, 'private'],
  [/not a bot|login required|log ?in to|sign in to|requires? (an )?(account|authentication|login|subscription)|--cookies|members[- ]only|Join this channel/i, 'login_required'],
  [/(not|n't)\b.{0,40}available (in|from) your (country|location|region)|geo[- ]?(restrict|block)|blocked it in your country/i, 'geo_blocked'],
  [/Premieres in|live event will begin|is_upcoming|will begin in|scheduled to start|stream has not started/i, 'live_not_started'],
  [/HTTP Error 429|Too Many Requests|rate[- ]limit/i, 'rate_limited'],
  [/Video unavailable|video is unavailable|has been removed|no longer available|account .* terminated|content is not available/i, 'unavailable'],
  [/Unsupported URL/i, 'unsupported'],
  [/No video formats found|Requested format is not available|no formats|There's no video in this|No media found/i, 'no_media'],
  [/HTTP Error 404|\b404\b.*Not Found/i, 'not_found'],
  [/HTTP Error 403|\b403\b.*Forbidden/i, 'forbidden'],
  [
    /Unable to download (webpage|API page|JSON)|Failed to establish a new connection|Name or service not known|getaddrinfo failed|nodename nor servname|timed? ?out|Connection (reset|refused|aborted)|Network is unreachable|Temporary failure in name resolution|SSL: |CERTIFICATE_VERIFY_FAILED|IncompleteRead|RemoteDisconnected/i,
    'network'
  ],
  [/ffmpeg|ffprobe|Postprocessing|Conversion failed|Error opening output|Invalid data found/i, 'ffmpeg']
]

export function classifyError(message: string): ErrorCode {
  for (const [re, code] of RULES) if (re.test(message)) return code
  return 'unknown'
}

/**
 * Picks the most relevant yt-dlp error from its stderr output: the last
 * "ERROR:" line (yt-dlp prints the cause there), without the prefix.
 */
export function extractError(stderr: string, fallback = 'yt-dlp è terminato con un errore'): JobError {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const errors = lines.filter((l) => l.startsWith('ERROR:'))
  const raw = errors.at(-1) ?? lines.at(-1) ?? fallback
  const message = raw.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*/, '')
  return { code: classifyError(raw), message }
}
