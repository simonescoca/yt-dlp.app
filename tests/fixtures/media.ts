import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const MEDIA_DIR = resolve(__dirname, 'media')

/** ffmpeg installed by tests/integration/engine-install.test.ts, else the one on PATH. */
function defaultFfmpeg(): string {
  try {
    const bin = resolve(__dirname, '../../.dev-data/bin')
    const manifest = JSON.parse(readFileSync(join(bin, 'manifest.json'), 'utf8')) as { components: { ffmpeg?: { folder: string } } }
    const folder = manifest.components.ffmpeg?.folder
    if (folder) return join(bin, 'ffmpeg', folder, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  } catch {
    /* not installed */
  }
  return 'ffmpeg'
}

/**
 * Generates the test media (once): a progressive MP4, an HLS stream with two
 * qualities (master playlist), a DASH stream and a short "ad" clip.
 */
export function ensureMedia(ffmpeg = defaultFfmpeg()): string {
  const marker = join(MEDIA_DIR, '.ready-v4')
  if (existsSync(marker)) return MEDIA_DIR
  mkdirSync(join(MEDIA_DIR, 'hls'), { recursive: true })
  mkdirSync(join(MEDIA_DIR, 'dash'), { recursive: true })
  mkdirSync(join(MEDIA_DIR, 'ads'), { recursive: true })
  mkdirSync(join(MEDIA_DIR, 'drm'), { recursive: true })
  const run = (args: string[], cwd?: string) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd })
  const src = (seconds: number, size: string, freq = 440) => [
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`
  ]
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-b:a', '128k']

  // Progressive MP4 (main video) and a 3 s "ad".
  run([...src(8, '1280x720'), ...h264, '-movflags', '+faststart', join(MEDIA_DIR, 'video.mp4')])
  run([...src(3, '640x360', 880), ...h264, '-movflags', '+faststart', join(MEDIA_DIR, 'ad.mp4')])
  run([...src(3, '640x360', 880), ...h264, '-movflags', '+faststart', join(MEDIA_DIR, 'ads', 'preroll.mp4')])
  // Two long, low-resolution videos (the scanner treats < 30 s clips as previews/ads).
  run([...src(45, '640x360', 330), ...h264, '-b:v', '150k', '-movflags', '+faststart', join(MEDIA_DIR, 'long.mp4')])
  run([...src(70, '640x360', 550), ...h264, '-b:v', '150k', '-movflags', '+faststart', join(MEDIA_DIR, 'long2.mp4')])

  // HLS: two variants + master playlist.
  for (const [name, size, bw] of [['low', '426x240', '400000'], ['high', '1280x720', '2500000']] as const) {
    run([...src(8, size), ...h264, '-b:v', bw, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(MEDIA_DIR, 'hls', `${name}_%03d.ts`), join(MEDIA_DIR, 'hls', `${name}.m3u8`)])
  }
  writeFileSync(join(MEDIA_DIR, 'hls', 'master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=528000,RESOLUTION=426x240,CODECS="avc1.64001e,mp4a.40.2"',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
    'high.m3u8',
    ''
  ].join('\n'))

  // DASH: one video + one audio representation.
  // Relative output inside the folder: on Windows the DASH muxer misplaces segments given a backslash path.
  run([...src(8, '854x480'), '-map', '0:v', '-map', '1:a', ...h264, '-f', 'dash', '-seg_duration', '2',
    '-use_template', '1', '-use_timeline', '0', 'manifest.mpd'], join(MEDIA_DIR, 'dash'))

  // A DASH manifest protected by Widevine (never playable, only detected).
  writeFileSync(join(MEDIA_DIR, 'drm', 'manifest.mpd'), `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1H30M0S" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period><AdaptationSet mimeType="video/mp4">
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
    <Representation id="v" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
  </AdaptationSet></Period>
</MPD>
`)

  writeFileSync(marker, new Date().toISOString())
  return MEDIA_DIR
}
