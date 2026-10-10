import { readFileSync } from 'node:fs'

/** Field 2 can contain spaces and parentheses; field 3 starts after the last ). */
export function parseLinuxProcessStart(stat: string): number {
  const end = stat.lastIndexOf(')')
  const start = end < 0 ? undefined : stat.slice(end + 1).trim().split(/\s+/)[19]
  if (start === undefined || !/^\d+$/.test(start) || !Number.isSafeInteger(Number(start))) {
    throw new Error('Process start time is unavailable')
  }
  return Number(start)
}

/** Called once by the Linux shell owner during startup, never at module load. */
export function readLinuxProcessStart(log: (event: 'native-dictation-pid-start-unavailable') => void): number | undefined {
  try {
    return parseLinuxProcessStart(readFileSync('/proc/self/stat', 'utf8'))
  } catch {
    log('native-dictation-pid-start-unavailable')
    return undefined
  }
}
