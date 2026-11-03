import { t } from '@lingui/core/macro'
import { createHash } from 'node:crypto'
import type { FileWorkspace } from '../../shared/files'
import type { TerminalPlace } from '../../shared/terminal'
import { ToolFailure } from '../tools/common'
import type { HostedTerminals } from '../tools/terminal'
import { sshTerminalArguments, type SshTerminalHost } from './sshTerminal'

/** What a shell over SSH needs of a thread on a paired host, from what that host last published. */
export interface HostThreadFolders {
  readonly hostId: string
  readonly projectId: string
  readonly workingDirectory?: string | undefined
  readonly projectFolder?: string | undefined
}

/**
 * The terminals of threads on paired hosts (ADR-0183). A thread is found in what its host last published and asks the host
 * nothing, so this works while the host's socket is down. The window names only a thread: the target and every argument
 * come from here, from the saved host. `workspaceId` leaves the working folder out, so a shell isn't lost from its tab
 * when the thread's folder moves, which the shell itself never notices.
 */
export function hostedTerminals(options: {
  folders(threadId: string): HostThreadFolders | undefined
  host(hostId: string): SshTerminalHost | undefined
  /** How ssh is started: the same executable the launcher uses, or a development run's stand-in. */
  ssh: { readonly file: string; readonly args?: readonly string[] }
}): HostedTerminals {
  const found = (threadId: string): HostThreadFolders => {
    const folders = options.folders(threadId)
    if (!folders) throw new ToolFailure('thread-unavailable', t`This thread’s host is not connected, so Sotto cannot tell where its terminal starts. Connect it in Settings > Hosts & phones, then try again.`)
    return folders
  }
  return {
    workspace(threadId, expected) {
      const { projectId, workingDirectory, projectFolder } = found(threadId)
      const workspaceId = createHash('sha256').update(JSON.stringify([threadId, projectId])).digest('hex')
      if (expected !== undefined && expected !== workspaceId) throw new ToolFailure('workspace-changed', t`This thread moved to another project. Open its terminal again.`)
      return { threadId, projectId, workspaceId, workingDirectory: workingDirectory ?? projectFolder ?? '' } satisfies FileWorkspace
    },
    launch(owner: FileWorkspace, place: TerminalPlace) {
      const { hostId, projectFolder, workingDirectory } = found(owner.threadId)
      const host = options.host(hostId)
      if (!host) throw new ToolFailure('unavailable', t`Sotto has no SSH connection saved for this host, so nothing was started. Add the host in Settings > Hosts & phones, then try again.`)
      // The drawer starts in the project folder and Tools in the working copy, as they do on this computer.
      const preferred = place === 'drawer' ? [projectFolder, workingDirectory] : [workingDirectory, projectFolder]
      const folders = [...new Set(preferred.filter((folder): folder is string => Boolean(folder)))]
      return { file: options.ssh.file, args: [...options.ssh.args ?? [], ...sshTerminalArguments(host, folders)] }
    },
  }
}
