/**
 * What the installer said, bounded and without the machine in it. npm's last line is usually where
 * it put its log ("A complete log of this run can be found in C:\Users\<name>\..."), which is a home
 * folder and a user name on their way to the card, to Settings and to the turn record on disk. That
 * line is dropped, and any absolute path left in the one shown is replaced by an ellipsis.
 */
export function installerDetail(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    .filter(line => !/complete log of this run/iu.test(line))
  const tail = lines.at(-1)
  if (tail === undefined) return undefined
  const redacted = tail.replace(/[A-Za-z]:\\[^\s"']+|\/(?:home|Users)\/[^\s"']+/gu, '…').trim()
  return redacted ? redacted.slice(0, 200) : undefined
}
