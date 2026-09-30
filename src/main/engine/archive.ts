import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import extractZip from 'extract-zip'

const execFileAsync = promisify(execFile)

/** Extracts a .zip (all platforms) or .tar.xz (Linux dev builds only) archive into `dest`. */
export async function extractArchive(file: string, dest: string, kind: 'zip' | 'tar.xz'): Promise<void> {
  await mkdir(dest, { recursive: true })
  if (kind === 'zip') {
    await extractZip(file, { dir: dest })
    return
  }
  await execFileAsync('tar', ['-xJf', file, '-C', dest])
}
