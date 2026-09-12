// Synthetic disk-backed warm-store measurement; never opens the user's database.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, cpus, platform, release, arch } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { memoryInsertSql, migrateDatabase } from '../../src/main/memory/migrations.mjs'
import { retrieveExplicitMemories, threadMemoryScope, RETRIEVAL_CONTEXT_CHARACTERS,
  RETRIEVAL_CANDIDATES_PER_SCOPE, RETRIEVAL_MIN_COVERAGE } from '../../src/main/memory/retrieval.mjs'

const root = mkdtempSync(join(tmpdir(), 'sotto-retrieval-bench-'))
const path = join(root, 'memory.sqlite')
const database = new DatabaseSync(path)
const at = '2026-09-11T12:00:00.000Z'
const storeRows = 10_000
const warmupRuns = 100
const measuredRuns = 1_000
try {
  migrateDatabase(database)
  const insert = database.prepare(memoryInsertSql)
  database.exec('BEGIN')
  for (let i = 0; i < storeRows; i++) {
    const scope = i % 5 === 0 ? 'global' : i % 5 === 1 ? 'project-a'
      : i % 5 === 2 ? threadMemoryScope('project-a', 'thread-a') : `other-project-${i % 20}`
    const topic = ['verification', 'communication', 'workflow', 'git', 'privacy'][Math.floor(i / 5) % 5]
    insert.run(`synthetic-${i}`, 'preference', scope,
      `${topic}: run focused tests for component ${i}. Preserve unrelated edits and inspect the rendered result.`,
      'explicit', 1, 1, 0.8, at, at, null, at, null, null, '[]', JSON.stringify([topic]), 'active', 'preference', null)
  }
  database.exec('COMMIT')
  const queries = ['verification', 'communication focused tests', 'workflow unrelated edits', 'git component 73',
    'privacy', 'absent database', 'verification compiler database networking', 'focused tests']
  // A new SQLite connection's first query; Windows file cache is deliberately not flushed.
  const coldConnectionSamplesMs = []
  for (let i = 0; i < 20; i++) {
    const connection = new DatabaseSync(path)
    try {
      const started = performance.now()
      retrieveExplicitMemories(connection, { query: queries[i % queries.length], projectId: 'project-a', threadId: 'thread-a', at })
      coldConnectionSamplesMs.push(performance.now() - started)
    } finally { connection.close() }
  }
  const samples = []
  let maxContextCharacters = 0
  for (let i = 0; i < warmupRuns + measuredRuns; i++) {
    const started = performance.now()
    const memories = retrieveExplicitMemories(database, {
      query: queries[i % queries.length], projectId: 'project-a', threadId: 'thread-a', at,
    })
    const elapsed = performance.now() - started
    maxContextCharacters = Math.max(maxContextCharacters, JSON.stringify(memories).length)
    if (i >= warmupRuns) samples.push(elapsed)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1]
  const report = {
    generatedAt: new Date().toISOString(), benchmark: 'explicit-lexical-warm-v1',
    environment: { platform: platform(), release: release(), arch: arch(), node: process.version,
      electron: process.versions.electron ?? null, sqlite: database.prepare('SELECT sqlite_version() AS version').get().version,
      cpu: cpus()[0]?.model },
    storeRows, warmupRuns, measuredRuns, queries,
    coldConnection: { definition: 'First query on each of 20 new SQLite connections; excludes connection open; OS disk cache not flushed', samplesMs: coldConnectionSamplesMs },
    scopeOrder: ['thread', 'project', 'global'], candidatesPerScope: RETRIEVAL_CANDIDATES_PER_SCOPE,
    minCoverage: RETRIEVAL_MIN_COVERAGE, contextBudgetCharacters: RETRIEVAL_CONTEXT_CHARACTERS, maxContextCharacters,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) },
    targetP95Ms: 100, passes: percentile(0.95) <= 100, samplesMs: samples,
  }
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, samplesMs: undefined }, null, 2))
  if (!report.passes) process.exitCode = 1
} finally {
  database.close()
  if (resolve(root).startsWith(resolve(tmpdir()) + sep) && root.includes('sotto-retrieval-bench-')) {
    rmSync(root, { recursive: true, force: true })
  }
}
