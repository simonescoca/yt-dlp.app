import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Reads a JSON file, returning `fallback` when it is missing or corrupted. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Atomic JSON writer with debouncing: frequent changes (progress) cost one write. */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private latest: T | null = null

  constructor(
    private readonly file: string,
    private readonly delayMs = 400
  ) {}

  save(data: T): void {
    this.latest = data
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.delayMs)
  }

  /** Writes the latest data now (used on quit). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const data = this.latest
    if (data == null) return this.writing
    this.latest = null
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(data, null, 1))
      await rename(tmp, this.file)
    }
    this.writing = this.writing.then(write, write)
    return this.writing
  }
}
