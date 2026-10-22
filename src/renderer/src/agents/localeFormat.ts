/**
 * A date formatter for one set of options in the default locale and time zone, built once rather than on every call.
 *
 * `Date.prototype.toLocaleTimeString(undefined, options)` builds a new `Intl.DateTimeFormat` each time it is called,
 * and the Threads page asks for a clock label for every message and every sidebar row on every render: in a profile of
 * the window that was 1.4 s of a minute (#1328). `new Intl.DateTimeFormat(undefined, options).format(date)` is the
 * same string, so this keeps one and builds it again only when what it was built for moves: the language the window
 * runs in, or the time zone, which the operating system can change while Sotto is open.
 *
 * The language is `navigator.language`. The zone is checked two ways. Its offsets on two fixed days, one in each half
 * of the year, are read on every call without building anything, and catch nearly every switch at once. Its name is
 * read at most once a second, which costs one formatter a second, and catches a switch between zones that share those
 * offsets, such as Algiers and Casablanca. Such a switch can leave a label made within that second on the old zone.
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
const ZONE_NAME_CHECK_MS = 1_000
let zoneName: { readonly name: string; readonly readAt: number } | undefined

function defaultsKey(): string {
  const language = typeof navigator === 'undefined' ? '' : navigator.language
  return `${language}|${JANUARY.getTimezoneOffset()}|${JULY.getTimezoneOffset()}|${currentZoneName()}`
}

function currentZoneName(): string {
  const now = Date.now()
  // A clock set back reads the name afresh rather than trusting one read in what is now the future.
  if (zoneName === undefined || now - zoneName.readAt >= ZONE_NAME_CHECK_MS || now < zoneName.readAt) {
    zoneName = { name: new Intl.DateTimeFormat().resolvedOptions().timeZone, readAt: now }
  }
  return zoneName.name
}
