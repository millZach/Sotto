import { setTimeout as delay } from 'node:timers/promises'

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const

/** Retry short Windows file locks without changing the operation or its target. */
export async function retryWindowsFileOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      const retryDelay = RETRY_DELAYS_MS[attempt]
      if (process.platform !== 'win32' || retryDelay === undefined
        || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      await delay(retryDelay)
    }
  }
}
