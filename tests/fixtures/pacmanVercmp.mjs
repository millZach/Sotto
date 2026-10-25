/**
 * A port of pacman's rpmvercmp (lib/libalpm/version.c) for versions without an epoch or release, so unit tests can
 * check how pacman orders the Owl's pkgver on a machine without pacman. The Linux Owl workflow runs the real vercmp.
 * pacman has no pre-release marker: a tilde is an ordinary separator, unlike in RPM and Debian.
 */
const isDigit = character => character !== undefined && character >= '0' && character <= '9'
const isAlpha = character => character !== undefined && /^[A-Za-z]$/u.test(character)
const isAlnum = character => isDigit(character) || isAlpha(character)

export function pacmanVercmp(a, b) {
  if (a === b) return 0
  let one = 0, two = 0
  while (one < a.length && two < b.length) {
    const start1 = one, start2 = two
    while (one < a.length && !isAlnum(a[one])) one++
    while (two < b.length && !isAlnum(b[two])) two++
    if (!(one < a.length && two < b.length)) break
    if (one - start1 !== two - start2) return one - start1 < two - start2 ? -1 : 1
    let end1 = one, end2 = two
    const numeric = isDigit(a[one])
    const inSegment = numeric ? isDigit : isAlpha
    while (end1 < a.length && inSegment(a[end1])) end1++
    while (end2 < b.length && inSegment(b[end2])) end2++
    let segment1 = a.slice(one, end1), segment2 = b.slice(two, end2)
    if (segment2.length === 0) return numeric ? 1 : -1
    if (numeric) {
      segment1 = segment1.replace(/^0+/u, ''); segment2 = segment2.replace(/^0+/u, '')
      if (segment1.length !== segment2.length) return segment1.length > segment2.length ? 1 : -1
    }
    if (segment1 !== segment2) return segment1 < segment2 ? -1 : 1
    one = end1; two = end2
  }
  if (one >= a.length && two >= b.length) return 0
  return (one >= a.length && !isAlpha(b[two])) || isAlpha(a[one]) ? -1 : 1
}
