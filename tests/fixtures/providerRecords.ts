import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

/** Parse records only. Each reader keeps its own missing-file and read-error policy. */
export function parseProviderRecords<T = Record<string, unknown>>(text: string, options: { trim?: boolean; keepEmptyLines?: boolean } = {}): T[] {
  const lines = (options.trim === false ? text : text.trim()).split('\n')
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
