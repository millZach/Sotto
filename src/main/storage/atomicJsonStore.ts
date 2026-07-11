import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_CORRUPT_BACKUP_ATTEMPTS = 100

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

type ReadResult<T> =
  | { status: 'valid'; value: T }
  | { status: 'missing' }
  | { status: 'invalid' }

export class AtomicJsonStore<T> {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly parse: (input: unknown) => T,
    private readonly createDefault: () => T,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {}

  read(): Promise<T> {
    return this.enqueueOperation(() => this.readInternal(true))
  }

  peek(): Promise<T> {
    return this.enqueueOperation(() => this.readInternal(false))
  }

  write(value: T): Promise<void> {
    return this.enqueueOperation(() => this.writeImmediately(value))
  }

  exists(): Promise<boolean> {
    return this.enqueueOperation(() => this.pathExists(this.filePath))
  }

  private async readInternal(recover: boolean): Promise<T> {
    const result = await this.readValue()

    if (result.status === 'valid') {
      return result.value
    }
    if (result.status === 'invalid' && recover) {
      await this.backUpCorruptFile()
    }

    return this.createDefault()
  }

  private async readValue(): Promise<ReadResult<T>> {
    let contents: string

    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return { status: 'missing' }
      }

      throw error
    }

    try {
      return { status: 'valid', value: this.parse(JSON.parse(contents) as unknown) }
    } catch {
      return { status: 'invalid' }
    }
  }

  private async writeImmediately(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })

    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.createId()}`
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

  private async backUpCorruptFile(): Promise<void> {
    const timestamp = this.now()

    for (let attempt = 0; attempt < MAX_CORRUPT_BACKUP_ATTEMPTS; attempt += 1) {
      const backupPath = `${this.filePath}.corrupt-${timestamp}-${this.createId()}`
      if (await this.pathExists(backupPath)) {
        continue
      }

      await rename(this.filePath, backupPath)
      return
    }

    throw new Error(
      `Could not preserve corrupt JSON after ${MAX_CORRUPT_BACKUP_ATTEMPTS} backup attempts`,
    )
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return false
      }

      throw error
    }
  }

  private enqueueOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const queued = this.operationTail.then(operation)
    this.operationTail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }
}
