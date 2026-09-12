/** One dictionary word per line; blank, oversized, and duplicate entries are dropped. */
export function parseDictionary(
  dictionary: string,
  options: { readonly maxLength?: number; readonly maxEntries?: number } = {},
): readonly string[] {
  const seen = new Set<string>()
  for (const line of dictionary.split(/\r?\n/)) {
    const word = line.trim()
    if (word.length > 0 && word.length <= (options.maxLength ?? 64)) seen.add(word)
    if (seen.size >= (options.maxEntries ?? Number.POSITIVE_INFINITY)) break
  }
  return [...seen]
}
