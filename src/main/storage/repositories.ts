import { join } from 'node:path'

import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import { HistoryRepository } from './historyRepository'
import { RecoveryNoticeCenter } from './recoveryNoticeCenter'
import { SettingsRepository, type SettingsRepositoryOptions } from './settingsRepository'

export function createStorageRepositories(
  userDataPath: string,
  recoveryNotices: RecoveryNoticeCenter,
  now: () => number = Date.now,
  defaults: AppSettings = DEFAULT_SETTINGS,
  log?: (event: 'history-temp-cleanup-failed') => void,
  options: Pick<SettingsRepositoryOptions, 'omarchyTheme' | 'shellPillInUse' | 'workerRolesEnabled' | 'dictationHoldShortcutsEnabled'> = {},
): Readonly<{
  settings: SettingsRepository
  history: HistoryRepository
}> {
  return Object.freeze({
    settings: new SettingsRepository(join(userDataPath, 'settings.json'), {
      now,
      defaults,
      ...options,
      onRecovery: (notice) => recoveryNotices.publish(notice),
    }),
    history: new HistoryRepository(join(userDataPath, 'history.json'), {
      now,
      ...(log ? { log } : {}),
      onRecovery: (notice) => recoveryNotices.publish(notice),
    }),
  })
}
