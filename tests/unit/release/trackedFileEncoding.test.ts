// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps every tracked file free of a UTF-8 byte order mark', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  const prefix = Buffer.alloc(3)
  const offenders = files.filter(file => {
    let descriptor: number
    try {
      descriptor = openSync(file, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    try {
      return readSync(descriptor, prefix, 0, 3, 0) === 3 && prefix.equals(bom)
    } finally {
      closeSync(descriptor)
    }
  })
  expect(offenders).toEqual([])
})
