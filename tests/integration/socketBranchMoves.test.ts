// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostBranchMoves } from '../../src/host/branchMoves'
import { startSocketServer } from '../../src/host/socketServer'
import { BranchBundles } from '../../src/main/agents/branchBundles'
import { desktopBranchMoves, DesktopBranchMoves, type BranchMoveFolders, type BranchMoveHost } from '../../src/main/agents/branchMoves'
import type { HostService } from '../../src/main/agents/hostService'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { branchMoveWords, incomingRef, type HostBranchMoveRequest } from '../../src/shared/branchMoves'
import type { HostOperation } from '../../src/shared/hostProtocol'
import { commitFile, git, incompressible, twoMachines } from '../fixtures/branchRepositories'
import { useSocketHostFixture } from '../fixtures/socketHostFixture'
import { startFixtureHeadlessHost } from '../fixtures/desktopHostStack'

const fixture = useSocketHostFixture()
let machines: Awaited<ReturnType<typeof twoMachines>>
beforeEach(async () => { machines = await twoMachines() })
afterEach(async () => { await machines.close() })

/** The fixture host's own service, which the socket needs for its shell; moves read their folders from the test's map. */
function service(): HostService {
  const base = fixture.host.service
  return { shell: () => base.shell(), state: () => base.state(), threadDetail: id => base.threadDetail(id), events: () => [],
    command: (command, identity) => base.command(command, identity), subscribe: listener => base.subscribe(listener) }
}

/**
 * Forge behind a socket stand-in: its `forge-project` is the forge clone, and its `forge-thread` works in `threadFolder`.
 * `desktop` says whether the launch script recorded the client as a desktop; `moves` is false for a host before them.
 */
async function forgeHost(options: { threadFolder?: string; desktop?: boolean; moves?: boolean } = {}) {
  const folders: BranchMoveFolders = {
    projectFolder: id => id === 'forge-project' ? machines.forge : undefined,
    threadFolder: id => id === 'forge-thread' ? options.threadFolder ?? machines.forge : undefined,
  }
  const moves = options.moves === false ? undefined : new HostBranchMoves(new BranchBundles(machines.data('forge')), folders)
  const server = await startSocketServer({ service: service(), pairing: fixture.host.pairing,
    watcherDesktops: { refresh: async () => undefined, has: () => options.desktop !== false }, ...(moves ? { branchMoves: moves } : {}) })
  const paired = await fixture.host.pairing.redeem(fixture.host.pairing.issuePairingCode().code, 'Laptop')
  const client = new SocketHostService({ url: 'http://127.0.0.1:' + server.descriptor.port, token: paired.token }); fixture.clients.push(client)
  const hello = await client.connect()
  return { server, client, moves, features: hello.features ?? [] }
}

/** The laptop's side: its `laptop-thread` works in the laptop clone, and `laptop-project` is that clone. */
function laptopMoves(host: BranchMoveHost | undefined): DesktopBranchMoves {
  return new DesktopBranchMoves({ bundles: new BranchBundles(machines.data('laptop')), hostName: () => 'forge', host: () => host,
    folders: { threadFolder: id => id === 'laptop-thread' ? machines.laptop : undefined, projectFolder: id => id === 'laptop-project' ? machines.laptop : undefined } })
}

describe('branch moves over the host socket (ADR-0105 decision 8)', () => {
  it('sends a laptop thread’s branch into forge’s incoming ref and leaves forge’s checked-out branch alone; a retry is done', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'feature/login')
    const commit = await commitFile(machines.laptop, 'login.txt', 'form\n')
    const { server, client, features } = await forgeHost()
    try {
      expect(features).toContain('branch-moves')
      expect(server.descriptor.features).toContain('branch-moves')
      const before = machines.untouched(machines.forge)
      const moveId = randomUUID()
      const moves = laptopMoves(client)
      expect(await moves.toHost({ threadId: 'laptop-thread', hostId: 'forge-id', projectId: 'forge-project', moveId }))
        .toEqual({ type: 'moved', moveId, branch: 'feature/login', commit, ref: incomingRef(moveId, 'feature/login') })
      expect(git(machines.forge, 'rev-parse', incomingRef(moveId, 'feature/login'))).toBe(commit)
      expect(machines.untouched(machines.forge)).toEqual(before)
      expect(await moves.toHost({ threadId: 'laptop-thread', hostId: 'forge-id', projectId: 'forge-project', moveId })).toMatchObject({ type: 'moved', commit })
      expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
      expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
    } finally { await server.close() }
  })

  it('receives a forge thread’s branch into the laptop’s own repository, in chunks', async () => {
    const worktree = join(machines.root, 'forge-work')
    git(machines.forge, 'worktree', 'add', '-q', '-b', 'fix/sync', worktree)
    await commitFile(worktree, 'blob.bin', incompressible(3 * 1024 * 1024))
    const commit = await commitFile(worktree, 'sync.txt', 'fixed\n')
    const { server, client } = await forgeHost({ threadFolder: worktree })
    try {
      const before = machines.untouched(machines.laptop)
      const calls: string[] = []
      const counting: BranchMoveHost = { supportsBranchMoves: true, branchMove: request => { calls.push(request.action); return client.branchMove(request) } }
      const receipt = await laptopMoves(counting).fromHost({ hostId: 'forge-id', threadId: 'forge-thread', projectId: 'laptop-project' })
      expect(receipt).toMatchObject({ type: 'moved', branch: 'fix/sync', commit })
      expect(git(machines.laptop, 'rev-parse', (receipt as { ref: string }).ref)).toBe(commit)
      expect(calls.filter(action => action === 'send-chunk').length).toBeGreaterThanOrEqual(3)
      expect(calls.at(-1)).toBe('end')
      expect(machines.untouched(machines.laptop)).toEqual(before)
      expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
    } finally { await server.close() }
  })

  it('sends no bundle either way when the receiving side already has the commit', async () => {
    const commit = git(machines.laptop, 'rev-parse', 'main')
    const { server, client } = await forgeHost()
    try {
      const calls: string[] = []
      const counting: BranchMoveHost = { supportsBranchMoves: true, branchMove: request => { calls.push(request.action); return client.branchMove(request) } }
      const there = await laptopMoves(counting).toHost({ threadId: 'laptop-thread', hostId: 'forge-id', projectId: 'forge-project' })
      expect(there).toMatchObject({ type: 'moved', branch: 'main', commit })
      expect(git(machines.forge, 'rev-parse', (there as { ref: string }).ref)).toBe(commit)
      expect(calls).toEqual(['tips', 'receive-ref'])
      calls.length = 0
      const back = await laptopMoves(counting).fromHost({ hostId: 'forge-id', threadId: 'forge-thread', projectId: 'laptop-project' })
      expect(back).toMatchObject({ type: 'moved', branch: 'main', commit })
      expect(git(machines.laptop, 'rev-parse', (back as { ref: string }).ref)).toBe(commit)
      expect(calls).toEqual(['send-begin', 'end'])
      expect(await readdir(machines.data('forge').stagingDirectory)).toEqual([])
      expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
    } finally { await server.close() }
  })

  it('refuses a forge thread with uncommitted work, in plain words, and moves nothing', async () => {
    await writeFile(join(machines.forge, 'app.txt'), 'half done\n')
    const { server, client } = await forgeHost()
    try {
      expect(await laptopMoves(client).fromHost({ hostId: 'forge-id', threadId: 'forge-thread', projectId: 'laptop-project' }))
        .toEqual({ type: 'refused', reason: 'uncommitted', message: branchMoveWords.uncommitted })
      expect(git(machines.laptop, 'for-each-ref', 'refs/sotto')).toBe('')
      expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
    } finally { await server.close() }
  })

  it('discards a transfer cut off when the connection drops, and lands nothing', async () => {
    git(machines.laptop, 'switch', '-q', '-c', 'big')
    await commitFile(machines.laptop, 'blob.bin', incompressible(3 * 1024 * 1024))
    const { server, client, moves } = await forgeHost()
    try {
      let chunks = 0
      const dropping: BranchMoveHost = { supportsBranchMoves: true, branchMove: async (request: HostBranchMoveRequest) => {
        if (request.action === 'receive-chunk' && ++chunks === 2) await client.close()
        return client.branchMove(request)
      } }
      expect(await laptopMoves(dropping).toHost({ threadId: 'laptop-thread', hostId: 'forge-id', projectId: 'forge-project' }))
        .toEqual({ type: 'refused', reason: 'cut-off', message: branchMoveWords.cutOff })
      // Forge hears the socket close and discards what it staged.
      await expect.poll(() => moves!.staged).toBe(0)
      await expect.poll(() => readdir(machines.data('forge').stagingDirectory)).toEqual([])
      expect(git(machines.forge, 'for-each-ref', 'refs/sotto')).toBe('')
      expect(await readdir(machines.data('laptop').stagingDirectory)).toEqual([])
    } finally { await server.close() }
  })

  it('is not offered by a host before branch moves, nor to a client not recorded as a desktop; both refuse the request', async () => {
    for (const options of [{ moves: false }, { desktop: false }]) {
      const { server, client, features } = await forgeHost(options)
      try {
        expect(features).not.toContain('branch-moves')
        expect(client.supportsBranchMoves).toBe(false)
        expect(await laptopMoves(client).toHost({ threadId: 'laptop-thread', hostId: 'forge-id', projectId: 'forge-project' }))
          .toEqual({ type: 'refused', reason: 'unsupported', message: branchMoveWords.olderHost('forge') })
        await expect(client.branchMove({ action: 'tips', projectId: 'forge-project' })).rejects.toMatchObject({ code: 'version_mismatch' })
        const raw = client as unknown as { call(op: HostOperation): Promise<unknown> }
        await expect(raw.call({ op: 'branch-move', request: { action: 'tips', projectId: 'forge-project' } })).rejects.toMatchObject({ code: 'invalid_request' })
      } finally { await server.close() }
    }
    expect(await laptopMoves(undefined).fromHost({ hostId: 'forge-id', threadId: 'forge-thread', projectId: 'laptop-project' }))
      .toEqual({ type: 'refused', reason: 'unsupported', message: branchMoveWords.notConnected('forge') })
  })
})

describe('the cross-machine-work Owl answer (ADR-0072)', () => {
  const options = () => ({ bundles: new BranchBundles(machines.data('laptop')), hostName: () => 'forge', host: () => undefined,
    folders: { threadFolder: () => undefined, projectFolder: () => undefined } })
  it('makes the desktop’s branch moves only where it is on', () => {
    expect(desktopBranchMoves(false, options())).toBeUndefined()
    expect(desktopBranchMoves(true, options())).toBeInstanceOf(DesktopBranchMoves)
  })

  it('has a headless host list branch moves only where its own answer is on', async () => {
    for (const [sottoVersion, offered] of [['0.1.37-owl.20261023.1', true], ['0.1.37', false]] as const) {
      const host = await startFixtureHeadlessHost({ dataDirectory: join(machines.root, 'host-' + String(offered)), port: 0, sottoVersion })
      try { expect(host.descriptor!.features.includes('branch-moves')).toBe(offered) } finally { await host.close() }
    }
  })
})
