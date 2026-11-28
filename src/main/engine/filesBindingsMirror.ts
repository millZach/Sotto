import type { AgentHostSnapshot, AgentProject, AgentThread } from '../../shared/agents'
import { isThreadClosed } from '../../shared/threadActivity'
import { resolveFilesBinding } from '../files/binding'
import type { FilesBinding } from '../files/service'
import type { HostThreadFolders } from '../hosts/hostedTerminals'
import type { SshTerminalHost } from '../hosts/sshTerminal'
import type { FilesBindingsDelta } from './types'

function sameBinding(a: FilesBinding | undefined, b: FilesBinding | null): boolean {
  if (a === undefined || b === null) return false
  return a.threadId === b.threadId
    && a.projectId === b.projectId
    && a.workingDirectory === b.workingDirectory
    && Boolean(a.previewOnly) === Boolean(b.previewOnly)
}

function sameHostedFolders(a: HostThreadFolders | undefined, b: HostThreadFolders): boolean {
  if (a === undefined) return false
  return a.hostId === b.hostId
    && a.projectId === b.projectId
    && a.workingDirectory === b.workingDirectory
    && a.projectFolder === b.projectFolder
}

function sameTerminalHost(a: SshTerminalHost | undefined, b: SshTerminalHost): boolean {
  if (a === undefined) return false
  return a.target === b.target
    && a.sshPort === b.sshPort
    && a.identityFile === b.identityFile
}

/**
 * Shell-side cache of thread folder bindings, project folders, thread titles, hosted terminal targets (ADR-0210) and
 * which threads are closed. Keeps BrowserService, CloudIphoneService and TerminalService local and non-blocking with
 * zero synchronous IPC.
 */
export class FilesBindingsMirror {
  private readonly bindings = new Map<string, FilesBinding>()
  private readonly projectFolders = new Map<string, string>()
  private readonly threadTitles = new Map<string, string>()
  private readonly hostedFolders = new Map<string, HostThreadFolders>()
  private readonly terminalHosts = new Map<string, SshTerminalHost>()
  private readonly closedThreads = new Set<string>()

  /**
   * Takes in what changed, and answers the local threads that ended with it: those their provider closed, archived or
   * settled there, and those that went. The user's Settle closes none, as Undo brings a settled thread straight back.
   * A thread that was closed already, or a whole list sent again, ends none.
   */
  apply(delta: FilesBindingsDelta): string[] {
    const titledBefore = new Set(this.threadTitles.keys()), closedBefore = new Set(this.closedThreads)
    if (delta.reset) {
      this.bindings.clear()
      this.projectFolders.clear()
      this.threadTitles.clear()
      this.hostedFolders.clear()
      this.terminalHosts.clear()
      this.closedThreads.clear()
    }
    if (delta.closedThreads) {
      for (const [id, value] of Object.entries(delta.closedThreads)) {
        if (value === null) this.closedThreads.delete(id)
        else this.closedThreads.add(id)
      }
    }
    if (delta.bindings) {
      for (const [id, value] of Object.entries(delta.bindings)) {
        if (value === null) this.bindings.delete(id)
        else this.bindings.set(id, value)
      }
    }
    if (delta.projectFolders) {
      for (const [id, value] of Object.entries(delta.projectFolders)) {
        if (value === null) this.projectFolders.delete(id)
        else this.projectFolders.set(id, value)
      }
    }
    if (delta.threadTitles) {
      for (const [id, value] of Object.entries(delta.threadTitles)) {
        if (value === null) this.threadTitles.delete(id)
        else this.threadTitles.set(id, value)
      }
    }
    if (delta.hostedFolders) {
      for (const [id, value] of Object.entries(delta.hostedFolders)) {
        if (value === null) this.hostedFolders.delete(id)
        else this.hostedFolders.set(id, value)
      }
    }
    if (delta.terminalHosts) {
      for (const [id, value] of Object.entries(delta.terminalHosts)) {
        if (value === null) this.terminalHosts.delete(id)
        else this.terminalHosts.set(id, value)
      }
    }
    // A thread goes with its title, which every local thread has; its folder can come and go while it lives.
    const gone = [...titledBefore].filter(id => !this.threadTitles.has(id))
    const closed = [...this.closedThreads].filter(id => !closedBefore.has(id) && this.threadTitles.has(id))
    return [...gone, ...closed]
  }

  resolveBinding(threadId: string): FilesBinding | null {
    return this.bindings.get(threadId) ?? null
  }

  projectFolder(projectId: string): string | undefined {
    return this.projectFolders.get(projectId)
  }

  threadTitle(threadId: string): string {
    return this.threadTitles.get(threadId) ?? threadId
  }

  hostedThreadFolders(threadId: string): HostThreadFolders | undefined {
    return this.hostedFolders.get(threadId)
  }

  terminalHost(hostId: string): SshTerminalHost | undefined {
    return this.terminalHosts.get(hostId)
  }
}

/**
 * Engine-side incremental tracker for `FilesBindingsMirror` (ADR-0210).
 * Skips unchanged thread and project object references so high-frequency streaming updates emit zero deltas
 * unless a thread's folder binding, title or project path actually changed.
 */
export class FilesBindingsTracker {
  private lastLocalThreads: readonly AgentThread[] | undefined
  private lastLocalProjects: readonly AgentProject[] | undefined
  private readonly threadRefs = new Map<string, AgentThread>()
  private readonly bindings = new Map<string, FilesBinding>()
  private readonly projectFolders = new Map<string, string>()
  private readonly threadTitles = new Map<string, string>()
  private readonly hostedFolders = new Map<string, HostThreadFolders>()
  private readonly terminalHosts = new Map<string, SshTerminalHost>()
  private readonly closedThreads = new Set<string>()

  syncLocal(host: AgentHostSnapshot): FilesBindingsDelta | null {
    if (host.threads === this.lastLocalThreads && host.projects === this.lastLocalProjects) return null
    const projectsChanged = host.projects !== this.lastLocalProjects
    this.lastLocalThreads = host.threads
    this.lastLocalProjects = host.projects

    let projectPatch: Record<string, string | null> | undefined
    if (projectsChanged) {
      const seenProjects = new Set<string>()
      for (const project of host.projects) {
        seenProjects.add(project.id)
        if (this.projectFolders.get(project.id) !== project.path) {
          this.projectFolders.set(project.id, project.path)
          ;(projectPatch ??= {})[project.id] = project.path
        }
      }
      for (const id of [...this.projectFolders.keys()]) {
        if (!seenProjects.has(id)) {
          this.projectFolders.delete(id)
          ;(projectPatch ??= {})[id] = null
        }
      }
    }

    let bindingPatch: Record<string, FilesBinding | null> | undefined
    let titlePatch: Record<string, string | null> | undefined
    let closedPatch: Record<string, true | null> | undefined
    const seenThreads = new Set<string>()
    for (const thread of host.threads) {
      seenThreads.add(thread.id)
      if (!projectsChanged && this.threadRefs.get(thread.id) === thread) continue
      this.threadRefs.set(thread.id, thread)
      let nextBinding: FilesBinding | null
      try { nextBinding = resolveFilesBinding(host, thread.id) } catch { nextBinding = null }
      const currentBinding = this.bindings.get(thread.id)
      if (nextBinding === null) {
        if (currentBinding !== undefined) {
          this.bindings.delete(thread.id)
          ;(bindingPatch ??= {})[thread.id] = null
        }
      } else if (!sameBinding(currentBinding, nextBinding)) {
        this.bindings.set(thread.id, nextBinding)
        ;(bindingPatch ??= {})[thread.id] = nextBinding
      }
      if (this.threadTitles.get(thread.id) !== thread.title) {
        this.threadTitles.set(thread.id, thread.title)
        ;(titlePatch ??= {})[thread.id] = thread.title
      }
      // The provider's close, not the user's Settle, which keeps running work and is undone in a press: a download
      // waiting in a settled thread keeps asking (ADR-0222, November 27 amendment).
      const closed = isThreadClosed(thread)
      if (closed !== this.closedThreads.has(thread.id)) {
        if (closed) this.closedThreads.add(thread.id)
        else this.closedThreads.delete(thread.id)
        ;(closedPatch ??= {})[thread.id] = closed ? true : null
      }
    }
    if (seenThreads.size < this.threadRefs.size) {
      for (const id of [...this.threadRefs.keys()]) {
        if (!seenThreads.has(id)) {
          this.threadRefs.delete(id)
          if (this.bindings.delete(id)) (bindingPatch ??= {})[id] = null
          if (this.threadTitles.delete(id)) (titlePatch ??= {})[id] = null
          if (this.closedThreads.delete(id)) (closedPatch ??= {})[id] = null
        }
      }
    }

    if (!bindingPatch && !projectPatch && !titlePatch && !closedPatch) return null
    return {
      ...(bindingPatch ? { bindings: bindingPatch } : {}),
      ...(projectPatch ? { projectFolders: projectPatch } : {}),
      ...(titlePatch ? { threadTitles: titlePatch } : {}),
      ...(closedPatch ? { closedThreads: closedPatch } : {}),
    }
  }

  syncHosted(
    remoteThreadIds: readonly string[],
    readFolders: (threadId: string) => HostThreadFolders | undefined,
    hosts: readonly (readonly [string, SshTerminalHost])[],
  ): FilesBindingsDelta | null {
    let hostedPatch: Record<string, HostThreadFolders | null> | undefined
    const seenThreads = new Set<string>()
    for (const id of remoteThreadIds) {
      seenThreads.add(id)
      const next = readFolders(id)
      if (!next) {
        if (this.hostedFolders.delete(id)) (hostedPatch ??= {})[id] = null
      } else if (!sameHostedFolders(this.hostedFolders.get(id), next)) {
        this.hostedFolders.set(id, next)
        ;(hostedPatch ??= {})[id] = next
      }
    }
    if (seenThreads.size < this.hostedFolders.size) {
      for (const id of [...this.hostedFolders.keys()]) {
        if (!seenThreads.has(id)) {
          this.hostedFolders.delete(id)
          ;(hostedPatch ??= {})[id] = null
        }
      }
    }

    let hostPatch: Record<string, SshTerminalHost | null> | undefined
    const seenHosts = new Set<string>()
    for (const [hostId, info] of hosts) {
      seenHosts.add(hostId)
      if (!sameTerminalHost(this.terminalHosts.get(hostId), info)) {
        this.terminalHosts.set(hostId, info)
        ;(hostPatch ??= {})[hostId] = info
      }
    }
    if (seenHosts.size < this.terminalHosts.size) {
      for (const hostId of [...this.terminalHosts.keys()]) {
        if (!seenHosts.has(hostId)) {
          this.terminalHosts.delete(hostId)
          ;(hostPatch ??= {})[hostId] = null
        }
      }
    }

    if (!hostedPatch && !hostPatch) return null
    return {
      ...(hostedPatch ? { hostedFolders: hostedPatch } : {}),
      ...(hostPatch ? { terminalHosts: hostPatch } : {}),
    }
  }

  snapshot(): FilesBindingsDelta {
    return {
      reset: true,
      bindings: Object.fromEntries(this.bindings),
      projectFolders: Object.fromEntries(this.projectFolders),
      threadTitles: Object.fromEntries(this.threadTitles),
      hostedFolders: Object.fromEntries(this.hostedFolders),
      terminalHosts: Object.fromEntries(this.terminalHosts),
      closedThreads: Object.fromEntries([...this.closedThreads].map(id => [id, true as const])),
    }
  }
}
