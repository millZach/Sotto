// Pure, deterministic scoring and aggregation. Rates are fractions from 0 to 1.
import { CATEGORIES } from './schema.mjs'

export function scoreCase({ expected }, { answer }) {
  const matches = (pattern) => new RegExp(pattern, 'i').test(answer)
  switch (expected.kind) {
    case 'abstain':
      return answer === null ? { pass: true } : { pass: false, reason: 'Expected abstention' }
    case 'project-leak':
    case 'authority-leak':
      return answer === null || !matches(expected.leakPattern)
        ? { pass: true }
        : { pass: false, reason: `Answer matches the ${expected.kind} pattern` }
    case 'recall':
    case 'temporal':
    case 'exception':
      if (answer === null) return { pass: false, reason: 'Expected an answer' }
      if (!matches(expected.pattern)) return { pass: false, reason: 'Answer does not match the expected pattern' }
      if (expected.kind !== 'recall' && matches(expected.stalePattern)) {
        return { pass: false, reason: 'Answer matches the stale pattern' }
      }
      return { pass: true }
    default:
      throw new Error(`Unknown expected kind: ${expected.kind}`)
  }
}

export function buildCategoryTable(results) {
  return CATEGORIES.map((category) => {
    const cases = results.filter((entry) => entry.category === category)
    const passed = cases.filter((entry) => entry.pass).length
    const row = { category, cases: cases.length, passed, rate: cases.length ? passed / cases.length : 0 }
    if (['recall', 'temporal', 'exception'].includes(category)) {
      row.meanMemoryIds = cases.length ? cases.reduce((sum, entry) => sum + entry.memoryIds.length, 0) / cases.length : 0
    }
    return row
  })
}
