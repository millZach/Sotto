/**
 * A date formatter for one set of options in the default locale and time zone, built once rather than on every call.
 *
 * `Date.prototype.toLocaleTimeString(undefined, options)` builds a new `Intl.DateTimeFormat` each time it is called,
 * and the Threads page asks for a clock label for every message and every sidebar row on every render: in a profile of
 * the window that was 1.4 s of a minute (#1328). `new Intl.DateTimeFormat(undefined, options).format(date)` is the
 * same string, so this keeps one and builds it again only when what it was built for moves: the language the window
 * runs in, or the time zone, which the operating system can change while Sotto is open. Both are read without building
 * anything: `navigator.language`, and the offset at two fixed instants, one in each half of the year so a zone with
 * daylight saving and one without never look alike.
 */
export function localeFormatter(options: Readonly<Intl.DateTimeFormatOptions>): (date: Date) => string {
  let built: { readonly key: string; readonly format: Intl.DateTimeFormat } | undefined
  return date => {
    const key = defaultsKey()
    if (built === undefined || built.key !== key) built = { key, format: new Intl.DateTimeFormat(undefined, options) }
    return built.format.format(date)
  }
}

const JANUARY = new Date(Date.UTC(2026, 0, 1))
const JULY = new Date(Date.UTC(2026, 6, 1))

function defaultsKey(): string {
  const language = typeof navigator === 'undefined' ? '' : navigator.language
  return `${language}|${JANUARY.getTimezoneOffset()}|${JULY.getTimezoneOffset()}`
}
