import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_CORRUPT_BACKUP_ATTEMPTS = 100
const MAX_TEMPORARY_FILE_ATTEMPTS = 100

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

type ReadResult<T> =
  | { status: 'valid'; value: T }
  | { status: 'missing' }
  | { status: 'invalid' }

export interface AtomicJsonRecoveryEvent {
  readonly kind: 'corrupt-json-recovered'
}

export class AtomicJsonStore<T> {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly parse: (input: unknown) => T,
    private readonly createDefault: () => T,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly onRecovery?: (event: AtomicJsonRecoveryEvent) => void,
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
      try {
        this.onRecovery?.({ kind: 'corrupt-json-recovered' })
      } catch {
        // A presentation-only notice cannot make durable recovery fail.
      }
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

    let temporaryPath: string | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      const temporaryFile = await this.openUniqueTemporaryFile()
      temporaryPath = temporaryFile.path
      handle = temporaryFile.handle
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
      temporaryPath = undefined
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined)
      }
      if (temporaryPath !== undefined) {
        await unlink(temporaryPath).catch(() => undefined)
      }
      throw error
    }
  }

  private async openUniqueTemporaryFile(): Promise<{
    path: string
    handle: Awaited<ReturnType<typeof open>>
  }> {
    for (let attempt = 0; attempt < MAX_TEMPORARY_FILE_ATTEMPTS; attempt += 1) {
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.createId()}`

      try {
        return {
          path: temporaryPath,
          handle: await open(temporaryPath, 'wx', 0o600),
        }
      } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) {
          continue
        }

        throw error
      }
    }

    throw new Error(
      `Could not create temporary JSON file after ${MAX_TEMPORARY_FILE_ATTEMPTS} attempts`,
    )
  }

  private async backUpCorruptFile(): Promise<void> {
    const timestamp = this.now()

    for (let attempt = 0; attempt < MAX_CORRUPT_BACKUP_ATTEMPTS; attempt += 1) {
      const backupPath = `${this.filePath}.corrupt-${timestamp}-${this.createId()}`

      try {
        await copyFile(this.filePath, backupPath, fsConstants.COPYFILE_EXCL)
      } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) {
          if (await this.corruptSourceStillExists()) {
            continue
          }
          return
        }
        if (hasErrorCode(error, 'ENOENT')) {
          if (await this.corruptSourceStillExists()) {
            continue
          }
          return
        }

        throw error
      }

      try {
        await unlink(this.filePath)
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          if (await this.corruptSourceStillExists()) {
            continue
          }
          return
        }

        throw error
      }

      return
    }

    throw new Error(
      `Could not preserve corrupt JSON after ${MAX_CORRUPT_BACKUP_ATTEMPTS} backup attempts`,
    )
  }

  private async corruptSourceStillExists(): Promise<boolean> {
    return (await this.readValue()).status === 'invalid'
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
