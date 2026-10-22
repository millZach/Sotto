/**
 * A date formatter for one set of options in the default locale and time zone, built once rather than on every call.
 *
 * `Date.prototype.toLocaleTimeString(undefined, options)` builds a new `Intl.DateTimeFormat` each time it is called,
 * and the Threads page asks for a clock label for every message and every sidebar row on every render: in a profile of
 * the window that was 1.4 s of a minute (#1328). So this keeps one, built again only when the language the window runs
 * in moves (`navigator.language`, read without building anything).
 *
 * The time zone is never part of what it keeps. The kept formatter is set to UTC and is handed the moment moved by its
 * own local offset, which `getTimezoneOffset` reads from the zone in force now. The wall-clock time it prints is then the
 * one the default zone gives that moment, even after the operating system switches to another zone with the same
 * offsets in January and July. None of the options this serves prints a zone name, so moving the moment changes nothing
 * else.
 */
export function localeFormatter(options: Readonly<Intl.DateTimeFormatOptions>): (date: Date) => string {
  let built: { readonly language: string; readonly format: Intl.DateTimeFormat } | undefined
  return date => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    // A moment at the edge of what a Date can hold may have no local twin; ask the zone directly for it.
    if (!Number.isFinite(local.valueOf())) return new Intl.DateTimeFormat(undefined, options).format(date)
    const language = typeof navigator === 'undefined' ? '' : navigator.language
    if (built === undefined || built.language !== language) built = { language, format: new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }) }
    return built.format.format(local)
  }
}
