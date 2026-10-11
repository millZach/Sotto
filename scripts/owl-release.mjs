/** Resolve a local Owl build without rewriting the source package manifest. */
export function resolveOwlVersion(stableVersion, date, buildNumber) {
  const core = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(stableVersion)
  if (!core || !core.slice(1).every(part => Number.isSafeInteger(Number(part))) || !Number.isSafeInteger(Number(core[3]) + 1)) {
    throw new Error('Owl needs a plain stable package version.')
  }
  const dateMatch = /^([1-9]\d{3})(\d{2})(\d{2})$/u.exec(date)
  const parsed = dateMatch && new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`)
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10).replaceAll('-', '') !== date) {
    throw new Error('Use a real UTC build date in YYYYMMDD form.')
  }
  if (!/^[1-9]\d*$/u.test(String(buildNumber)) || !Number.isSafeInteger(Number(buildNumber))) {
    throw new Error('Choose a positive daily build number with --number (1, 2, and so on).')
  }
  return `${core[1]}.${core[2]}.${Number(core[3]) + 1}-owl.${date}.${buildNumber}`
}

export function owlBuildArguments(args, today = new Date().toISOString().slice(0, 10).replaceAll('-', '')) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--date', '--number'].includes(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new Error('Usage: npm run package:owl -- --number 1 [--date YYYYMMDD]')
    }
    values.set(key, value)
  }
  return { date: values.get('--date') ?? today, number: values.get('--number') }
}
