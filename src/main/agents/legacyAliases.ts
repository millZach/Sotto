/** Keep retired personal records exactly as read when a project alias store is saved again. */
export function preserveLegacyAliases<T extends { kind?: 'personal' | undefined }>(parse: (value: unknown) => Record<string, T>): (value: unknown) => Record<string, T> {
  return value => {
    const aliases = parse(value)
    for (const [id, raw] of Object.entries(value as Record<string, T>)) {
      if (raw.kind === 'personal') aliases[id] = raw
    }
    return aliases
  }
}
