// The iPhone app's hello `accepts`, read from its Swift source so a benchmark's phone never drifts from the app (November
// 10, 2026 audit). Shared by `scripts/perf-bench/phone-wire-probe.mjs` and the transfer benchmarks under `tests/perf/`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The features the iPhone's hello accepts: the snapshot hello's list, the step window's, and Watcher's and the machines line's. */
export function iphoneAccepts() {
  const source = name => readFileSync(join(root, 'apps/ios/Sources/SottoCore', name), 'utf8')
  const frame = source('IncomingFrame.swift')
  const watcher = source('Watcher.swift') + source('Machines.swift')
  const step = source('StepWindow.swift')
  const hello = frame.slice(frame.indexOf('static let snapshotHello'))
  const list = hello.slice(hello.indexOf('"accepts"'), hello.indexOf('])]'))
  const accepts = [...list.matchAll(/\.string\("([a-z0-9-]+)"\)/gu)].map(match => match[1])
  const named = (text, name) => {
    const match = new RegExp(`static let ${name} = "([a-z0-9-]+)"`, 'u').exec(text)
    if (!match) throw new Error(`No ${name} in the Swift source`)
    return match[1]
  }
  if (list.includes('StepWindow.feature')) accepts.push(named(step, 'feature'))
  for (const name of ['feature', 'stopFeature', 'manageFeature', 'steerFeature', 'machinesFeature', 'composerFeature']) accepts.push(named(watcher, name))
  return accepts
}
