// @vitest-environment node
/*
 * The phones draw OpenCode's mark from the desktop's own (#1107): `src/renderer/src/agents/ProviderMark.tsx` holds its path
 * and view box, the iPhone has it as a vector in its asset catalog, and Android has it as Compose shapes in
 * `core/ProviderMarks.kt`, the frame and the inner square at 35%. Android is built by no CI job yet, so this reads its source
 * here and fails when the mark drifts from the desktop's or stops being drawn where the iPhone draws it.
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
