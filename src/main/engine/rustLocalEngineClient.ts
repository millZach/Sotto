import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  fileListingSchema,
  filePreviewSchema,
  filesResultSchema,
  type FileListing,
  type FilePreview,
  type FileWorkspace,
  type FilesResult,
} from '../../shared/files'
import {
  gitListingSchema,
  gitReviewSchema,
  type GitChangeListing,
  type GitReview,
  type GitReviewScope,
} from '../../shared/gitChanges'
import { gitChangedFilesSchema, type GitChangedFiles } from '../../shared/gitChangedFiles'
import { gitRefsPageSchema, type GitRefsPage } from '../../shared/gitRefs'
import { hostMachineReportSchema, type HostMachineReport } from '../../shared/hostFacts'
import { agentThreadWordsSchema, type AgentThreadWords } from '../../shared/threadWords'
import { toolsResultSchema, type ToolsResult } from '../../shared/tools'
import { usageLocalReadSchema, type UsageLocalQuery, type UsageLocalRead } from '../../shared/usageDashboard'
import {
  createEngineEndpoint,
  generateEngineToken,
  listenEngineServer,
  type EngineRpcConnection,
  type EngineServerHandle,
} from './transport'

const HANDSHAKE_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 5_000
// Below `THREAD_WORDS_HOST_WAIT_MS` (3_000 ms) in `src/shared/threadWords.ts` so a stalled Rust call
// falls back to TypeScript before the desktop router times out the local host.
const THREAD_WORDS_RPC_TIMEOUT_MS = 2_500
const LIVE_HOST_FACTS_TIMEOUT_MS = 6_000
const GIT_REVIEW_RPC_TIMEOUT_MS = 10_000
const USAGE_QUERY_RPC_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 5_000

// Hoist composite schemas to module scope so RPC calls never recompile zod parsers (AGENTS.md).
const threadFilesResultSchema = filesResultSchema(fileListingSchema)
const threadFilePreviewResultSchema = filesResultSchema(filePreviewSchema)
const threadChangesResultSchema = toolsResultSchema(gitListingSchema)
const threadChangesReviewResultSchema = toolsResultSchema(gitReviewSchema)

export interface RustLocalEngineOptions {
  readonly userDataPath: string
  readonly isPackaged: boolean
  readonly binaryPath?: string | undefined
  readonly log?: ((code: string) => void) | undefined
}

export interface RustLocalEngineGitRefsOptions {
  readonly query?: string | undefined
  readonly cursor?: number | undefined
  readonly limit?: number | undefined
  readonly includeMatchingRemoteRefs?: boolean | undefined
  readonly refresh?: boolean | undefined
}

export interface RustLocalEngineClient {
  readonly version: string
  readonly pid: number
  hostFacts(runningThreads?: number, live?: boolean): Promise<HostMachineReport | undefined>
  searchThreadWords(query: string): Promise<AgentThreadWords | undefined>
  gitRefs(folder: string, options?: RustLocalEngineGitRefsOptions): Promise<GitRefsPage | undefined>
  gitChangedFiles(folder: string): Promise<GitChangedFiles | undefined>
  usageQuery(query: UsageLocalQuery): Promise<UsageLocalRead | undefined>
  threadFiles(workspace: FileWorkspace, path: string): Promise<FilesResult<FileListing> | undefined>
  threadFilePreview(workspace: FileWorkspace, path: string): Promise<FilesResult<FilePreview> | undefined>
  threadChanges(workspace: FileWorkspace): Promise<ToolsResult<GitChangeListing> | undefined>
  threadChangesReview(
    workspace: FileWorkspace,
    scope: GitReviewScope,
    ignoreWhitespace?: boolean,
  ): Promise<ToolsResult<GitReview> | undefined>
  close(): Promise<void>
}

export function rustLocalEngineBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'sotto-engine.exe' : 'sotto-engine'
}

export async function resolveRustLocalEngineBinary(options: Pick<RustLocalEngineOptions, 'isPackaged' | 'binaryPath'>): Promise<string | undefined> {
  const exe = rustLocalEngineBinaryName()
  const candidates: string[] = []
  if (options.binaryPath) {
    candidates.push(options.binaryPath)
  } else if (options.isPackaged) {
    candidates.push(join(process.resourcesPath, 'rust-engine', exe))
  } else {
    const override = process.env['SOTTO_RUST_ENGINE_BINARY']?.trim()
    if (override) candidates.push(override)
    candidates.push(resolve(__dirname, '../../dist/rust-engine', exe))
  }
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try next candidate path.
    }
  }
  return undefined
}

/**
 * Starts the native Rust `sotto-engine` binary in read-only `--accelerator` mode over the
 * ADR-0210 OS IPC transport (ADR-0215). Returns `undefined` if the binary is unavailable or fails
 * its startup handshake so callers transparently keep running on the TypeScript path.
 */
export async function startRustLocalEngine(options: RustLocalEngineOptions): Promise<RustLocalEngineClient | undefined> {
  const binary = await resolveRustLocalEngineBinary(options)
  if (!binary) return undefined

  const log = options.log ?? (() => undefined)
  // Short prefix respects macOS's 104-byte Unix domain socket sun_path limit.
  const endpoint = createEngineEndpoint('se')
  const token = generateEngineToken()

  let server: EngineServerHandle | undefined
  let child: ChildProcess | undefined
  let connection: EngineRpcConnection | undefined
  let closed = false

  const cleanupFailedStart = async (): Promise<void> => {
    closed = true
    connection?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    }
    await server?.close().catch(() => undefined)
  }

  try {
    server = await listenEngineServer(endpoint, token)
    child = spawn(
      binary,
      ['--data', options.userDataPath, '--endpoint', endpoint, '--accelerator'],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
        env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
      },
    )
    const exited = new Promise<void>(resolveExit => {
      child!.once('exit', () => {
        if (!closed) {
          closed = true
          log('rust-engine-exited')
        }
        resolveExit()
      })
      child!.once('error', () => {
        if (!closed) {
          closed = true
          log('rust-engine-exited')
        }
        resolveExit()
      })
    })

    connection = await Promise.race([
      server.waitForClient(HANDSHAKE_TIMEOUT_MS),
      exited.then<never>(() => { throw new Error('rust-engine-exited-before-handshake') }),
    ])
    const ping = await connection.request<{ ok?: unknown; runtime?: unknown; version?: unknown; pid?: unknown }>('engine.ping', [], RPC_TIMEOUT_MS)
    if (ping?.ok !== true || ping.runtime !== 'rust' || typeof ping.pid !== 'number') {
      throw new Error('rust-engine-invalid-ping')
    }
    const version = typeof ping.version === 'string' ? ping.version : ''
    const pid = ping.pid
    log('rust-engine-started')

    const activeConnection = connection
    const activeServer = server
    const activeChild = child

    return {
      version,
      pid,
      async hostFacts(runningThreads?: number, live?: boolean): Promise<HostMachineReport | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const rpcArgs = live !== undefined
            ? [runningThreads ?? 0, { live }]
            : runningThreads === undefined
              ? []
              : [runningThreads]
          const timeoutMs = live ? LIVE_HOST_FACTS_TIMEOUT_MS : RPC_TIMEOUT_MS
          const raw = await activeConnection.request('ops.hostFacts', rpcArgs, timeoutMs)
          const parsed = hostMachineReportSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async searchThreadWords(query: string): Promise<AgentThreadWords | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.threadWords', [query], THREAD_WORDS_RPC_TIMEOUT_MS)
          const parsed = agentThreadWordsSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async gitRefs(folder: string, refOptions?: RustLocalEngineGitRefsOptions): Promise<GitRefsPage | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.gitRefsByFolder', refOptions ? [folder, refOptions] : [folder], RPC_TIMEOUT_MS)
          const parsed = gitRefsPageSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async gitChangedFiles(folder: string): Promise<GitChangedFiles | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.gitChangedFiles', [folder], RPC_TIMEOUT_MS)
          const parsed = gitChangedFilesSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async usageQuery(query: UsageLocalQuery): Promise<UsageLocalRead | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.usageQuery', [query], USAGE_QUERY_RPC_TIMEOUT_MS)
          const parsed = usageLocalReadSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async threadFiles(workspace: FileWorkspace, path: string): Promise<FilesResult<FileListing> | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.threadFiles', [workspace, path], RPC_TIMEOUT_MS)
          const parsed = threadFilesResultSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async threadFilePreview(workspace: FileWorkspace, path: string): Promise<FilesResult<FilePreview> | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.threadFilePreview', [workspace, path], RPC_TIMEOUT_MS)
          const parsed = threadFilePreviewResultSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async threadChanges(workspace: FileWorkspace): Promise<ToolsResult<GitChangeListing> | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request('ops.threadChanges', [workspace], RPC_TIMEOUT_MS)
          const parsed = threadChangesResultSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async threadChangesReview(
        workspace: FileWorkspace,
        scope: GitReviewScope,
        ignoreWhitespace = false,
      ): Promise<ToolsResult<GitReview> | undefined> {
        if (closed || activeConnection.isClosed) return undefined
        try {
          const raw = await activeConnection.request(
            'ops.threadChangesReview',
            [workspace, scope, ignoreWhitespace],
            GIT_REVIEW_RPC_TIMEOUT_MS,
          )
          const parsed = threadChangesReviewResultSchema.safeParse(raw)
          return parsed.success ? parsed.data : undefined
        } catch {
          return undefined
        }
      },
      async close(): Promise<void> {
        if (closed) {
          await activeServer.close().catch(() => undefined)
          return
        }
        closed = true
        if (!activeConnection.isClosed) {
          await activeConnection.request('engine.shutdown', [], SHUTDOWN_TIMEOUT_MS).catch(() => undefined)
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            exited,
            new Promise<void>(resolveWait => { timer = setTimeout(resolveWait, SHUTDOWN_TIMEOUT_MS) }),
          ])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        if (activeChild.exitCode === null && activeChild.signalCode === null) {
          try { activeChild.kill('SIGTERM') } catch { /* already exited */ }
          await exited.catch(() => undefined)
        }
        activeConnection.close()
        await activeServer.close().catch(() => undefined)
      },
    }
  } catch {
    log('rust-engine-start-failed')
    await cleanupFailedStart()
    return undefined
  }
}
