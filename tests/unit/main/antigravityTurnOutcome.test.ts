// @vitest-environment node
import { lstat, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyAntigravityTurnOutcome, watchAntigravityTurnOutcome } from '../../../src/main/agents/antigravityTurnOutcome'

const SESSION = 'session-1234-abcd'

function writeSteps(dbPath: string, rows: readonly { idx: number; type: number; payload?: string | Uint8Array | null }[]): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, step_payload BLOB)')
    const insert = db.prepare('INSERT OR REPLACE INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)')
    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? Buffer.from(row.payload, 'utf8') : (row.payload ?? null)
      insert.run(row.idx, row.type, payload)
    }
  } finally {
    db.close()
  }
}

describe('Antigravity turn outcome checker', () => {
  let appData = ''
  const conversationsDir = () => join(appData, 'conversations')
  const dbPath = (id = SESSION) => join(conversationsDir(), `${id}.db`)

  beforeEach(async () => { appData = await mkdtemp(join(tmpdir(), 'sotto-agy-outcome-')) })
  afterEach(async () => { if (appData) await rm(appData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('settles a clean turn with a planner response step as completed', async () => {
    await mkdir(conversationsDir(), { recursive: true })
    writeSteps(dbPath(), [{ idx: 0, type: 15, payload: 'ok' }])
    const watcher = await watchAntigravityTurnOutcome(appData, SESSION)
    writeSteps(dbPath(), [{ idx: 1, type: 15, payload: 'second turn reply' }])
    expect(await watcher.check('end_turn')).toEqual({ status: 'completed' })
  })

  it('detects error steps hidden behind end_turn without leaking raw payloads or status codes', async () => {
    const encoder = new TextEncoder()
    const cases = [
      { payload: 'Error 429, Message: secret backend quota detail reason:QUOTA_EXHAUSTED, Status: RESOURCE_EXHAUSTED', reachedModel: false, expected: /usage limit/u },
      { payload: 'RESOURCE_EXHAUSTED (code 429): internal rate limit text\nat stack.go:99', reachedModel: false, expected: /usage limit/u },
      { payload: 'Error 400, Message: messages.2.content.0.thinking.signature: Field required, Status: INVALID_ARGUMENT', reachedModel: false, expected: /Fork from here/u },
      { payload: 'Error 401, Message: raw oauth token expired secret, Status: UNAUTHENTICATED', reachedModel: false, expected: /Settings › Providers/u },
      { payload: 'Error 403, Message: hidden iam reason, Status: PERMISSION_DENIED', reachedModel: false, expected: /Settings › Providers/u },
      { payload: 'Error 404, Message: unknown model claude-secret, Status: NOT_FOUND', reachedModel: false, expected: /Choose another Gemini model/u },
      { payload: 'Error 404, Message: edge transient missing session, Status: NOT_FOUND', reachedModel: true, expected: /service error/u },
      { payload: 'Error 503, Message: raw gRPC stack frame, Status: UNAVAILABLE', reachedModel: false, expected: /service error/u },
      { payload: 'unstructured internal go traceback secret-text', reachedModel: false, expected: /stopped this turn because of an error/u },
    ]
    for (const item of cases) {
      const outcome = classifyAntigravityTurnOutcome('end_turn', { type: 17, payload: encoder.encode(item.payload), reachedModel: item.reachedModel })
      expect(outcome.status).toBe('failed')
      expect(outcome.error).toMatch(item.expected)
      expect(outcome.error).not.toMatch(/secret|stack\.go|traceback|\b(?:401|403|404|429|503)\b/u)
    }
  })

  it('ignores stale error steps from earlier turns while catching newly written ones', async () => {
    await mkdir(conversationsDir(), { recursive: true })
    writeSteps(dbPath(), [{ idx: 0, type: 17, payload: 'Error 500, Message: earlier turn secret, Status: INTERNAL' }])

    // Turn 2 writes a clean planner response -> old step 0 must not fail turn 2.
    const cleanWatcher = await watchAntigravityTurnOutcome(appData, SESSION)
    writeSteps(dbPath(), [{ idx: 1, type: 15, payload: 'clean answer' }])
    expect(await cleanWatcher.check('end_turn')).toEqual({ status: 'completed' })

    // Turn 3 writes no new step -> old step 0 still ignored.
    const idleWatcher = await watchAntigravityTurnOutcome(appData, SESSION)
    expect(await idleWatcher.check('end_turn')).toEqual({ status: 'completed' })

    // Turn 4 has planner response (idx 2) then 404 error step (idx 3) -> transient edge error.
    const transientWatcher = await watchAntigravityTurnOutcome(appData, SESSION)
    writeSteps(dbPath(), [
      { idx: 2, type: 15, payload: 'partial' },
      { idx: 3, type: 17, payload: 'Error 404, Message: edge hiccup, Status: NOT_FOUND' },
    ])
    expect(await transientWatcher.check('end_turn')).toEqual({
      status: 'failed',
      error: 'Antigravity ran into a service error and stopped this turn. Your thread is kept. Send again to retry.',
    })

    // Turn 5 cancelled by user stays interrupted even with an error step written mid-turn.
    const cancelWatcher = await watchAntigravityTurnOutcome(appData, SESSION)
    writeSteps(dbPath(), [{ idx: 4, type: 17, payload: 'Error 500, Message: aborted, Status: INTERNAL' }])
    expect(await cancelWatcher.check('cancelled')).toEqual({ status: 'interrupted' })
  })

  it('catches errors in a database created mid-turn when neither conversations nor db existed yet', async () => {
    const watcher = await watchAntigravityTurnOutcome(appData, SESSION)
    await mkdir(conversationsDir(), { recursive: true })
    writeSteps(dbPath(), [{ idx: 0, type: 17, payload: 'Error 429, Message: limited, reason:QUOTA_EXHAUSTED, Status: RESOURCE_EXHAUSTED' }])
    expect(await watcher.check('end_turn')).toEqual({
      status: 'failed',
      error: 'Antigravity reached its usage limit for this period. Your thread is kept. Try again later.',
    })
  })

  it('bounds large payloads cleanly and falls back on refusal when no error step exists', async () => {
    await mkdir(conversationsDir(), { recursive: true })
    writeSteps(dbPath(), [{ idx: 0, type: 15 }])
    const watcher = await watchAntigravityTurnOutcome(appData, SESSION)
    const huge = `Error 500, Message: ${'x'.repeat(64 * 1024)}, Status: INTERNAL`
    writeSteps(dbPath(), [{ idx: 1, type: 17, payload: huge }])
    expect(await watcher.check('end_turn')).toEqual({
      status: 'failed',
      error: 'Antigravity stopped this turn because of an error. Your thread is kept. Send again to retry.',
    })
    expect(classifyAntigravityTurnOutcome('refusal')).toEqual({
      status: 'failed',
      error: 'Antigravity refused this turn, or the account reached its limit. Nothing else was lost.',
    })
  })

  it('never follows a linked conversations folder or reads traversal IDs, and ignores replaced files', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sotto-agy-outside-outcome-'))
    try {
      writeSteps(join(outside, `${SESSION}.db`), [{ idx: 0, type: 17, payload: 'Error 500, Message: outside, Status: INTERNAL' }])
      await symlink(outside, conversationsDir(), process.platform === 'win32' ? 'junction' : 'dir')

      const linked = await watchAntigravityTurnOutcome(appData, SESSION)
      expect(await linked.check('end_turn')).toEqual({ status: 'completed' })
      expect(await linked.check('refusal').then(outcome => outcome.status)).toBe('failed')
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }

    const traversal = await watchAntigravityTurnOutcome(appData, '../escape')
    expect(await traversal.check('end_turn')).toEqual({ status: 'completed' })

    // A file replaced with a different inode mid-turn is ignored cleanly.
    const realAppData = await mkdtemp(join(tmpdir(), 'sotto-agy-replaced-'))
    try {
      const dir = join(realAppData, 'conversations')
      await mkdir(dir, { recursive: true })
      const original = join(dir, `${SESSION}.db`)
      writeSteps(original, [{ idx: 0, type: 15 }])
      const watcher = await watchAntigravityTurnOutcome(realAppData, SESSION)
      await rename(original, join(dir, 'archived.db'))
      writeSteps(original, [{ idx: 1, type: 17, payload: 'Error 500, Message: swapped, Status: INTERNAL' }])
      expect(await watcher.check('end_turn')).toEqual({ status: 'completed' })
    } finally {
      await rm(realAppData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  it('distinguishes replaced files whose 64-bit NTFS ino values collide when converted to float64', async () => {
    const realAppData = await mkdtemp(join(tmpdir(), 'sotto-agy-bigint-ino-'))
    try {
      const dir = join(realAppData, 'conversations')
      await mkdir(dir, { recursive: true })
      const original = join(dir, `${SESSION}.db`)
      writeSteps(original, [{ idx: 0, type: 15 }])

      const firstIno = 0x0040_0000_0000_0001n
      const secondIno = 0x0040_0000_0000_0002n
      expect(Number(firstIno)).toBe(Number(secondIno))

      let currentIno = firstIno
      const fakeLstat = async (path: string) => {
        const stats = await lstat(path, { bigint: true })
        return path.endsWith('.db') ? {
          isDirectory: () => stats.isDirectory(),
          isFile: () => stats.isFile(),
          isSymbolicLink: () => stats.isSymbolicLink(),
          dev: stats.dev,
          ino: currentIno,
          birthtimeNs: stats.birthtimeNs,
        } : stats
      }

      const watcher = await watchAntigravityTurnOutcome(realAppData, SESSION, fakeLstat)
      writeSteps(original, [{ idx: 1, type: 17, payload: 'Error 500, Message: same-file, Status: INTERNAL' }])
      expect(await watcher.check('end_turn')).toEqual({
        status: 'failed',
        error: 'Antigravity ran into a service error and stopped this turn. Your thread is kept. Send again to retry.',
      })

      currentIno = secondIno
      expect(await watcher.check('end_turn')).toEqual({ status: 'completed' })
    } finally {
      await rm(realAppData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
