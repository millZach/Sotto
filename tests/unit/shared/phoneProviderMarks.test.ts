// @vitest-environment node
/*
 * The phones draw OpenCode's mark from the desktop's own (#1107): `src/renderer/src/agents/ProviderMark.tsx` holds its path
 * and view box, the iPhone has it as a vector in its asset catalog, and Android has it as Compose shapes in
 * `core/ProviderMarks.kt`, the frame and the inner square at 35%. Android is built by no CI job yet, so this reads its source
 * here and fails when the mark drifts from the desktop's or stops being drawn where the iPhone draws it.
 * The iPhone draws Muse's squiggle from the desktop's too (#1280), and fails here when its asset drifts.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')
const ANDROID = 'apps/android/app/src/main/kotlin/com/millzach/sotto'

function desktopMark(): { viewBox: string; path: string } {
  const match = /opencode: \{\s*viewBox: '([^']+)',\s*path: '([^']+)'/u.exec(read('src/renderer/src/agents/ProviderMark.tsx'))
  if (!match) throw new Error('The desktop has no OpenCode mark.')
  return { viewBox: match[1]!, path: match[2]! }
}

it('draws OpenCode’s mark on Android from the desktop’s path and view box, the inner square at 35%', () => {
  const { viewBox, path } = desktopMark()
  expect(viewBox).toBe('0 0 32 40')
  const marks = read(`${ANDROID}/core/ProviderMarks.kt`)
  expect(marks).toContain(`"opencode" to ProviderMarkShape(32f, 40f,`)
  expect(marks).toContain(`MarkShape("${path}", 1f)`)
  // The inner square is the frame's hole, drawn again at 35%.
  const inner = /^(M[^Z]+Z)/u.exec(path)![1]!
  expect(marks).toContain(`MarkShape("${inner}", 0.35f)`)
})

it('shows the mark on Android where the iPhone shows it: the thread header and each thread row’s place line', () => {
  expect(read(`${ANDROID}/ui/ThreadScreen.kt`)).toMatch(/ProviderMark\(thread\?\.providerId/u)
  expect(read(`${ANDROID}/ui/ThreadsScreen.kt`)).toMatch(/ProviderMark\(row\.thread\.providerId/u)
  // The iPhone draws it in its thread header and its place lines.
  expect(read('apps/ios/Sotto/ThreadViews.swift')).toContain('ProviderMarks(providerID: thread?.providerId')
  expect(read('apps/ios/Sotto/ProviderMarks.swift')).toContain('"opencode": "ProviderOpenCode"')
  expect(read('apps/ios/Sotto/Resources/Assets.xcassets/ProviderOpenCode.imageset/ProviderOpenCode.svg')).toContain('viewBox="0 0 32 40"')
})

it('draws Muse’s mark on the iPhone from the desktop’s path and view box (#1280)', () => {
  const match = /muse: \{\s*viewBox: '([^']+)',\s*path: '([^']+)'/u.exec(read('src/renderer/src/agents/ProviderMark.tsx'))
  if (!match) throw new Error('The desktop has no Muse mark.')
  const [, viewBox, path] = match
  const asset = read('apps/ios/Sotto/Resources/Assets.xcassets/ProviderMuse.imageset/ProviderMuse.svg')
  expect(asset).toContain(`viewBox="${viewBox!}"`)
  // The asset spaces the desktop's path out and rounds it to four decimals, so its commands and numbers are the same.
  const commands = (d: string): string => d.replace(/[^A-Za-z]/gu, '')
  const numbers = (d: string): number[] => (d.match(/-?\d*\.?\d+/gu) ?? []).map(Number)
  const drawn = /\bd="([^"]+)"/u.exec(asset)![1]!
  expect(commands(drawn)).toBe(commands(path!))
  const desktop = numbers(path!)
  const phone = numbers(drawn)
  expect(phone).toHaveLength(desktop.length)
  phone.forEach((value, index) => expect(value).toBeCloseTo(desktop[index]!, 4))
  expect(read('apps/ios/Sotto/ProviderMarks.swift')).toContain('"muse": "ProviderMuse"')
})

it('draws Cursor’s cube on both phones from the desktop’s path and view box (ADR-0128)', () => {
  const match = /cursor: \{\s*viewBox: '([^']+)',\s*path: '([^']+)'/u.exec(read('src/renderer/src/agents/ProviderMark.tsx'))
  if (!match) throw new Error('The desktop has no Cursor mark.')
  const [, viewBox, path] = match
  expect(viewBox).toBe('0 0 24 24')
  // Android draws the desktop's path as it is, in one shape at full strength.
  expect(read(`${ANDROID}/core/ProviderMarks.kt`)).toContain(`"cursor" to ProviderMarkShape(24f, 24f, listOf(MarkShape("${path!}", 1f)))`)
  // The iPhone's asset spaces the same path out, with the same commands and numbers.
  const asset = read('apps/ios/Sotto/Resources/Assets.xcassets/ProviderCursor.imageset/ProviderCursor.svg')
  expect(asset).toContain(`viewBox="${viewBox!}"`)
  const drawn = /\bd="([^"]+)"/u.exec(asset)![1]!
  expect(drawn.replace(/[^A-Za-z]/gu, '')).toBe(path!.replace(/[^A-Za-z]/gu, ''))
  expect(drawn.match(/-?\d*\.?\d+/gu)!.map(Number)).toEqual(path!.match(/-?\d*\.?\d+/gu)!.map(Number))
  expect(read('apps/ios/Sotto/ProviderMarks.swift')).toContain('"cursor": "ProviderCursor"')
})
