import { join } from 'node:path'

import { HistoryRepository } from './historyRepository'
import { RecoveryNoticeCenter } from './recoveryNoticeCenter'
import { SettingsRepository } from './settingsRepository'

export function createStorageRepositories(
  userDataPath: string,
  recoveryNotices: RecoveryNoticeCenter,
  now: () => number = Date.now,
): Readonly<{
  settings: SettingsRepository
  history: HistoryRepository
}> {
  return Object.freeze({
    settings: new SettingsRepository(join(userDataPath, 'settings.json'), {
      now,
      onRecovery: (notice) => recoveryNotices.publish(notice),
    }),
    history: new HistoryRepository(join(userDataPath, 'history.json'), {
      now,
      onRecovery: (notice) => recoveryNotices.publish(notice),
    }),
  })
}
