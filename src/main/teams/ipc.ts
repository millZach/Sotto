import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { TEAMS_COMMAND, TEAMS_GET, teamsCommandSchema, type TeamsState } from '../../shared/teams'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { TeamService } from './teams'

const noArguments = z.tuple([])
const commandArguments = z.tuple([teamsCommandSchema])

/** The Teams tab's channels, for the main window only: a code is shown there and nowhere else. */
export function registerTeamsIpc(ipc: IpcMainAdapter, teams: Pick<TeamService, 'get' | 'command' | 'subscribe'>, senders: () => readonly TrustedIpcSender[], publish: (state: TeamsState) => void): () => void {
  ipc.handle(TEAMS_GET, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Teams in the main Sotto window.`)
    noArguments.parse(args)
    return teams.get()
  })
  ipc.handle(TEAMS_COMMAND, (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error(t`Open Teams in the main Sotto window.`)
    const [command] = commandArguments.parse(args)
    return teams.command(command)
  })
  const off = teams.subscribe(publish)
  return () => { off(); ipc.removeHandler(TEAMS_GET); ipc.removeHandler(TEAMS_COMMAND) }
}
