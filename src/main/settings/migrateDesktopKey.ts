import type { SecureSettings } from '../agents/secureSettings'
import type { RecoveryNoticeCenter } from '../storage/recoveryNoticeCenter'

/** Startup continues with a safe notice when an older key cannot be stored. */
export async function migrateDesktopKey(settings: SecureSettings, notices: RecoveryNoticeCenter, log: (event: 'secure-key-migration-unavailable') => void): Promise<void> {
  await settings.migrate(() => notices.publish({ code: 'OPENROUTER_KEY_MIGRATION_FAILED' }))
    .catch(() => log('secure-key-migration-unavailable'))
}
