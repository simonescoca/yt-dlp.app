import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const MEDIA_DIR = resolve(__dirname, 'media')

/**
 * Generates the test media (once): a progressive MP4, an HLS stream with two
 * qualities (master playlist), a DASH stream and a short "ad" clip.
 */
export function ensureMedia(ffmpeg = 'ffmpeg'): string {
  const marker = join(MEDIA_DIR, '.ready-v2')
  if (existsSync(marker)) return MEDIA_DIR
  mkdirSync(join(MEDIA_DIR, 'hls'), { recursive: true })
  mkdirSync(join(MEDIA_DIR, 'dash'), { recursive: true })
  const run = (args: string[]) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  const src = (seconds: number, size: string, freq = 440) => [
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`
  ]
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-b:a', '128k']

  // Progressive MP4 (main video) and a 3 s "ad".
  run([...src(8, '1280x720'), ...h264, '-movflags', '+faststart', join(MEDIA_DIR, 'video.mp4')])
  run([...src(3, '640x360', 880), ...h264, '-movflags', '+faststart', join(MEDIA_DIR, 'ad.mp4')])

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
  run([...src(8, '854x480'), '-map', '0:v', '-map', '1:a', ...h264, '-f', 'dash', '-seg_duration', '2',
    '-use_template', '1', '-use_timeline', '0', join(MEDIA_DIR, 'dash', 'manifest.mpd')])

  writeFileSync(marker, new Date().toISOString())
  return MEDIA_DIR
}
