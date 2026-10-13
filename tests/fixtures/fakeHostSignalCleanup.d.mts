export const FAKE_HOST_MARKER: 'sotto-fake-ssh-host'

/** The fixture exposes the explicit signal calls used by its launcher and unit manager. */
export function fakeHostKill(
  dataDirectory: string,
  nativeKill: (pid: number, signal: string | number) => boolean,
  platform?: NodeJS.Platform,
): (pid: number, signal: string | number) => boolean

export function installFakeHostSignalCleanup(dataDirectory: string): void
