import { z } from 'zod'

/** Every record `boundedRecord` made, so a test can prove each record a paired client may send is one of them. */
export const boundedRecords = new WeakSet<z.ZodType>()

/**
 * A record of at most `maxKeys` keys, counted before any key or value is parsed. A record parser reports every key and
 * value that fails, and a `.refine` on the count runs only after all of them, so one request with millions of keys made
 * millions of issues before the count could refuse it (#2273). Over the limit, the record is refused with one issue.
 */
export function boundedRecord<Key extends z.core.$ZodRecordKey, Value extends z.ZodType>(key: Key, value: Value, maxKeys: number) {
  const schema = z.preprocess((input, context) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
    let keys = 0
    for (const name in input) {
      if (!Object.hasOwn(input, name)) continue
      if (++keys > maxKeys) {
        context.addIssue({ code: 'too_big', origin: 'object', maximum: maxKeys, inclusive: true, input, message: `At most ${maxKeys} keys.` })
        return z.NEVER
      }
    }
    return input
  }, z.record(key, value))
  boundedRecords.add(schema)
  return schema
}
