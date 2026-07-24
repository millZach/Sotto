import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  migrateLegacyUserData,
  type LegacyMigrationFs,
} from '../../../src/main/storage/migrateLegacyUserData'

const ROOT = join('C:', 'users', 'zoe', 'AppData', 'Roaming')
const NEW_DIR = join(ROOT, 'Sotto')
const LEGACY_DIR = join(ROOT, 'TalkType')

interface FakeFsOptions {
  readonly existing?: readonly string[]
  readonly renameFails?: boolean
}

function createFakeFs(options: FakeFsOptions = {}) {
  const existing = new Set(options.existing ?? [])
  const operations: string[] = []
  const fs: LegacyMigrationFs = {
    exists: (path) => existing.has(path),
    rename(from, to) {
      if (options.renameFails === true) {
        throw new Error('EPERM')
      }
      operations.push(`rename ${from} -> ${to}`)
    },
    copyFile(from, to) {
      operations.push(`copy ${from} -> ${to}`)
    },
    copyDir(from, to) {
      operations.push(`copydir ${from} -> ${to}`)
    },
    mkdir(path) {
      operations.push(`mkdir ${path}`)
    },
  }
  return { fs, operations }
}

describe('migrateLegacyUserData', () => {
  it('renames the legacy directory when the new profile does not exist yet', () => {
    const { fs, operations } = createFakeFs({
      existing: [LEGACY_DIR, join(LEGACY_DIR, 'settings.json')],
    })

    expect(migrateLegacyUserData(NEW_DIR, fs)).toBe('renamed')
    expect(operations).toEqual([`rename ${LEGACY_DIR} -> ${NEW_DIR}`])
  })

  it('copies data files and models when the new directory already exists', () => {
    const { fs, operations } = createFakeFs({
      existing: [
        NEW_DIR,
        LEGACY_DIR,
        join(LEGACY_DIR, 'settings.json'),
        join(LEGACY_DIR, 'history.json'),
        join(LEGACY_DIR, 'models'),
      ],
    })

    expect(migrateLegacyUserData(NEW_DIR, fs)).toBe('copied')
    expect(operations).toEqual([
      `mkdir ${NEW_DIR}`,
      `copy ${join(LEGACY_DIR, 'settings.json')} -> ${join(NEW_DIR, 'settings.json')}`,
      `copy ${join(LEGACY_DIR, 'history.json')} -> ${join(NEW_DIR, 'history.json')}`,
      `copydir ${join(LEGACY_DIR, 'models')} -> ${join(NEW_DIR, 'models')}`,
    ])
  })

  it('falls back to copying when the rename fails', () => {
    const { fs, operations } = createFakeFs({
      existing: [LEGACY_DIR, join(LEGACY_DIR, 'settings.json')],
      renameFails: true,
    })

    expect(migrateLegacyUserData(NEW_DIR, fs)).toBe('copied')
    expect(operations).toContain(
      `copy ${join(LEGACY_DIR, 'settings.json')} -> ${join(NEW_DIR, 'settings.json')}`,
    )
  })

  it('does nothing when the new profile already has data', () => {
    const { fs, operations } = createFakeFs({
      existing: [join(NEW_DIR, 'settings.json'), LEGACY_DIR, join(LEGACY_DIR, 'settings.json')],
    })

    expect(migrateLegacyUserData(NEW_DIR, fs)).toBe('skipped')
    expect(operations).toEqual([])
  })

  it('does nothing when no legacy profile exists', () => {
    const { fs, operations } = createFakeFs()

    expect(migrateLegacyUserData(NEW_DIR, fs)).toBe('skipped')
    expect(operations).toEqual([])
  })
})
