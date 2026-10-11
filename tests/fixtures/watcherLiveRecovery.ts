import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { CodexAppServerHost } from '../../src/main/agents/codex'

/** Recover only the same synthetic native session after the old harness removed fixture metadata. */
export async function recoverWatcherLiveCodex(host: CodexAppServerHost, options: {
  date: string; data: string; id: string; projectId: string; modelId: string; prefix: string; sentinel: string; marker: string
}): Promise<string> {
  const native = host as unknown as { rpc(method: string, params: unknown, apply: (value: unknown) => void): Promise<void> }
  const row = z.object({ id: z.string(), cwd: z.string(), createdAt: z.number() })
  const page = z.object({ data: z.array(row), nextCursor: z.string().nullable() })
  const created = Date.parse(options.date) / 1000, matches: z.infer<typeof row>[] = []
  let cursor: string | null = null
  do {
    let next: z.infer<typeof page> | undefined
    await native.rpc('thread/list', { limit: 100, cursor, sourceKinds: ['cli', 'vscode', 'appServer'], modelProviders: ['openai'], sortKey: 'created_at', useStateDbOnly: true }, value => { next = page.parse(value) })
    if (!next) throw new Error('live-recovery-native-metadata-unconfirmed')
    for (const thread of next.data) {
      const project = resolve(thread.cwd), root = dirname(project)
      if (Math.abs(thread.createdAt - created) <= 60 && basename(project) === 'project' && dirname(root) === resolve(tmpdir()) && basename(root).startsWith(options.prefix)) matches.push(thread)
    }
    cursor = next.data.at(-1)?.createdAt !== undefined && next.data.at(-1)!.createdAt >= created - 60 ? next.nextCursor : null
  } while (cursor)
  if (matches.length !== 1) throw new Error('live-recovery-native-session-not-unique')
  const thread = matches[0]!, project = resolve(thread.cwd), root = dirname(project)
  const exists = await lstat(root).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })
  if (exists) throw new Error('live-recovery-project-occupied')
  await mkdir(root); await mkdir(project)
  await writeFile(join(project, 'sentinel.txt'), options.sentinel)
  await writeFile(join(project, 'source.txt'), `Synthetic searchable source\n${options.marker}\n`)
  // Sotto's own fixture stores, never a provider configuration or credential file.
  await writeFile(join(options.data, 'codex-projects.json'), JSON.stringify([{ id: options.projectId, title: 'Synthetic live project', path: project }]))
  await writeFile(join(options.data, 'codex-threads.json'), JSON.stringify({ [options.id]: {
    codexThreadId: thread.id, projectId: options.projectId, cwd: project, title: 'Synthetic center', modelId: options.modelId,
    runtimeMode: 'approval-required', createdAt: new Date(thread.createdAt * 1000).toISOString(), origins: [], messageIdentities: [], rewoundMessageIds: [], rewoundTurnIds: [],
  } }))
  return project
}
