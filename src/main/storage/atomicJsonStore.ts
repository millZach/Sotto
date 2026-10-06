import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { retryWindowsFileOperation } from './windowsFileRetry'

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

/**
 * How a store lays its JSON out. `pretty` indents it for a person reading the file; `compact` is for the large
 * stores rewritten around a send and while a reply streams, where indentation only adds bytes to serialize and
 * write. Every reader parses either.
 */
export type AtomicJsonFormat = 'pretty' | 'compact'

export class AtomicJsonStore<T> {
  private operationTail: Promise<void> = Promise.resolve()
  /** The `writeLatest` write that is queued and has not started yet, which later calls share. */
  private queuedLatest: Promise<void> | undefined

  constructor(
    private readonly filePath: string,
    private readonly parse: (input: unknown) => T,
    private readonly createDefault: () => T,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly onRecovery?: (event: AtomicJsonRecoveryEvent) => void,
    private readonly format: AtomicJsonFormat = 'pretty',
  ) {}

  read(): Promise<T> {
    return this.enqueueOperation(() => this.readInternal(true))
  }

  peek(): Promise<T> {
    return this.enqueueOperation(() => this.readInternal(false))
  }

  /**
   * Writes `value` as it is now: it is serialized before this returns, so the caller may change it at once
   * and need not hand over a copy.
   */
  write(value: T): Promise<void> {
    let serialized: string
    try { serialized = this.serialize(value) } catch (error) { return Promise.reject(error) }
    return this.enqueueOperation(() => this.writeImmediately(serialized))
  }

  /**
   * Writes JSON the caller already serialized from a `T`, as it is. A caller that compares serialized states to
   * decide whether to write at all hands that same text here rather than serializing it twice.
   */
  writeSerialized(serialized: string): Promise<void> {
    return this.enqueueOperation(() => this.writeImmediately(serialized))
  }

  /**
   * Writes whatever `latest` returns when the write starts, sharing one write among every call made before it
   * does. A call made while a write is running queues one more, so the file always ends at a state no older than
   * the newest call, and a burst of calls costs at most the write in flight and one more.
   */
  writeLatest(latest: () => T): Promise<void> {
    if (this.queuedLatest) return this.queuedLatest
    const queued = this.enqueueOperation(async () => {
      if (this.queuedLatest === queued) this.queuedLatest = undefined
      await this.writeImmediately(this.serialize(latest()))
    })
    this.queuedLatest = queued
    return queued
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

  private serialize(value: T): string {
    return this.format === 'compact' ? JSON.stringify(value) : JSON.stringify(value, null, 2)
  }

  private async writeImmediately(serialized: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })

    let temporaryPath: string | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      const temporaryFile = await this.openUniqueTemporaryFile()
      temporaryPath = temporaryFile.path
      handle = temporaryFile.handle
      await handle.writeFile(`${serialized}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.replaceFile(temporaryPath)
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

  private async replaceFile(temporaryPath: string): Promise<void> {
    // Retry only the atomic rename of the already-synced file, never unlink
    // the destination. Permanent Windows denial fails after 310 ms of backoff.
    await retryWindowsFileOperation(() => rename(temporaryPath, this.filePath))
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
