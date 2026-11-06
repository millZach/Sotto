import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

/**
 * Parse records only. Each reader keeps its own missing-file and read-error policy. Every fake ends a record with a
 * newline, so text after the last one is a record still being appended and is left for the next read; a finished
 * line that is not JSON still throws.
 */
export function parseProviderRecords<T = Record<string, unknown>>(text: string, options: { trim?: boolean; keepEmptyLines?: boolean } = {}): T[] {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1)
  const lines = (options.trim === false ? complete : complete.trim()).split('\n')
  return (options.keepEmptyLines ? lines : lines.filter(Boolean)).map(line => JSON.parse(line) as T)
}

export function providerArgument(args: unknown, name: string): string | undefined {
  const list = args as string[]
  return list.includes(name) ? list[list.indexOf(name) + 1] : undefined
}

/** The caller chooses the control file and provider identity; scripted values retain precedence. */
export async function writeProviderAction(path: string, value: Record<string, unknown>, identity: Record<string, unknown> = {}, id = randomUUID()): Promise<string> {
  await writeFile(path, JSON.stringify({ id, ...identity, ...value }))
  return id
}
