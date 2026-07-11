import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class AtomicJsonStore<T> {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly parse: (input: unknown) => T,
    private readonly createDefault: () => T,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<T> {
    let contents: string

    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return this.createDefault()
      }

      throw error
    }

    try {
      return this.parse(JSON.parse(contents) as unknown)
    } catch {
      await rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`)
      return this.createDefault()
    }
  }

  write(value: T): Promise<void> {
    const operation = this.writeTail.then(() => this.writeImmediately(value))
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.filePath)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return false
      }

      throw error
    }
  }

  private async writeImmediately(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })

    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined)
      }
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}
