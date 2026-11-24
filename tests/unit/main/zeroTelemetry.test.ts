// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeLegacyTelemetryFiles } from '../../../src/main/storage/legacyTelemetryCleanup'
import { parseSettings, settingsSchema } from '../../../src/shared/settings'

const ROOT = resolve(import.meta.dirname, '../../..')
const LEGACY_CLEANUP_PATH = 'src/main/storage/legacyTelemetryCleanup.ts'

/**
 * Permanent zero-telemetry regression guard (ADR-0179 reversed November 24, 2026).
 * Fails if telemetry endpoints, analytics SDK references, install-ID telemetry files,
 * or telemetry auth-file readers reappear in production source.
 */
describe('zero-telemetry regression guard', () => {
  const productionFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/', 'crates/', 'apps/ios/'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(path => path.length > 0 && !path.startsWith('src/locales/') && !path.startsWith('apps/ios/Tests/') && !path.startsWith('apps/ios/UITests/'))

  const forbidden: readonly { readonly name: string; readonly pattern: RegExp; readonly allow?: readonly string[] }[] = [
    { name: 'events.saysotto.com endpoint', pattern: /events\.saysotto\.com/i },
    { name: 'PostHog reference', pattern: /\bposthog\b/i },
    { name: 'product-events-install-id file', pattern: /product-events-install-id/i, allow: [LEGACY_CLEANUP_PATH] },
    { name: 'telemetry env var', pattern: /\b(SOTTO_TELEMETRY_ENABLED|SOTTO_PRODUCT_EVENTS_ENDPOINT)\b/ },
    { name: 'Claude telemetry accountUuid reader', pattern: /\baccountUuid\b/ },
    { name: 'OpenAI telemetry auth-claim reader', pattern: /api\.openai\.com\/auth/i },
    { name: 'Electron crashReporter', pattern: /\bcrashReporter\b/ },
  ]

  it('production source (src/, crates/, apps/ios/) contains no telemetry endpoints, SDKs, or auth-file readers', async () => {
    expect(productionFiles.length).toBeGreaterThan(0)
    const hits: string[] = []
    for (const file of productionFiles) {
      const content = await readFile(join(ROOT, file), 'utf8')
      for (const rule of forbidden) {
        if (rule.allow?.includes(file)) continue
        if (rule.pattern.test(content)) hits.push(`${file}: matched ${rule.name}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('legacy cleanup module only deletes the retired install-id file and never reads, writes, or sends anything', async () => {
    const cleanupSource = await readFile(join(ROOT, LEGACY_CLEANUP_PATH), 'utf8')
    expect(cleanupSource).not.toMatch(/\b(readFile|writeFile|createReadStream|fetch|http|https)\b/u)
    const dir = await mkdtemp(join(tmpdir(), 'sotto-legacy-telemetry-'))
    try {
      const legacyFile = join(dir, 'product-events-install-id')
      await writeFile(legacyFile, '00000000-0000-4000-8000-000000000000', 'utf8')
      await removeLegacyTelemetryFiles(dir)
      await expect(stat(legacyFile)).rejects.toThrow()
      // Non-fatal when already absent or directory does not exist.
      await expect(removeLegacyTelemetryFiles(dir)).resolves.toBeUndefined()
      await expect(removeLegacyTelemetryFiles(join(dir, 'missing-subdir'))).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads legacy settings.json files that still contain retired product-events keys cleanly', () => {
    const legacy = {
      ...parseSettings({}),
      productEventsEnabled: true,
      productEventsNoticeAnswered: true,
    }
    const normalized = parseSettings(legacy)
    expect('productEventsEnabled' in normalized).toBe(false)
    expect('productEventsNoticeAnswered' in normalized).toBe(false)
    const parsed = settingsSchema.parse(legacy)
    expect('productEventsEnabled' in parsed).toBe(false)
    expect('productEventsNoticeAnswered' in parsed).toBe(false)
  })
})
