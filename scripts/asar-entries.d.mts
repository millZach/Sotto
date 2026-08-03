export function toPosix(entryPath: string): string

export function toNative(entryPath: string): string

export function listAsarEntries(asarPath: string): string[]

export function readAsarFile(asarPath: string, entryPath: string): Buffer

export function readAsarText(asarPath: string, entryPath: string): string

export function isAsarDirectory(asarPath: string, entryPath: string): boolean
