// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wordPluginChange } from '../../../../src/main/plugins/changeWords'
import { MODEL_COST } from '../../../../src/main/plugins/meshy/tool'
import type { PluginChangeAnswer } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer } from '../../../../src/main/plugins/pluginTools'
import type { PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { checkPhoto, photoToSend, pixelsOf } from '../../../../src/main/tools/meshy/photo'
import type { ThreeDModel } from '../../../../src/main/tools/meshy/records'
import type { ModelRequest } from '../../../../src/main/tools/meshy/service'
import { MAKE_3D_MODEL_TOOL, pluginAccountAdmits, type PluginAccount, type PluginChange } from '../../../../src/shared/plugins'

/** `make_3d_model` (ADR-0141; the Meshy plan's ticket 3). Every key and account here is made up; nothing reaches Meshy. */
const servers: PluginToolServer[] = []
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-meshy-tool-'))) })
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map(server => server.close()))
  await rm(root, { recursive: true, force: true })
})

const STUDIO: PluginAccount = { id: '44444444-4444-4444-8444-000000000001', plugin: 'meshy', name: 'Studio', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 1_000 } }
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from('made-up photo with camera details')])

/** The tools for thread `one`, over one Meshy account, with the user's answers and Meshy's outcome scripted. */
function tools(options: { unshown?: boolean; answers?: PluginChangeAnswer[]; used?: number; ended?: Partial<ThreeDModel> | 'never' | 'lost'; noMeshy?: boolean; folder?: string; whileAsked?: (world: { accounts: PluginAccount[] }) => void | Promise<void>; whileCounting?: (world: { accounts: PluginAccount[] }) => void } = {}) {
  const world = { accounts: [STUDIO] }
  const answers = [...options.answers ?? []]
  const asked: PluginChange[] = []
  const recorded: PluginUseReport[] = []
  const made: ModelRequest[] = []
  const shown: { readonly threadId: string; readonly id: string; readonly name: string }[] = []
  const mine = (): PluginAccount[] => world.accounts.filter(account => pluginAccountAdmits(account, null))
  const never = async (): Promise<never> => { throw new Error('Not part of these tests.') }
  const server = new PluginToolServer({
    admits: threadId => threadId === 'one',
    gitHubSignIn: async () => ({ state: 'signed-out' }),
    readGitHub: never, readVercel: never, commentOnGitHub: never, openGitHubIssue: never, describeGitHubIssue: never, setGitHubIssueState: never,
    describeVercelDeployment: never, cancelVercelDeployment: never, moveVercelProduction: never,
    accounts: async () => mine(),
    findAccount: async (_threadId, plugin, name) => {
      const usable = mine().filter(account => account.plugin === plugin)
      if (usable.length === 0) return world.accounts.length === 0 ? 'none' : 'withheld'
      return name === undefined ? usable[0]! : usable.find(account => account.name === name) ?? 'unknown'
    },
    holdsAccount: async accountId => world.accounts.some(account => account.id === accountId),
    record: async report => { recorded.push(report) },
    isWatcher: () => false,
    askChange: async (_threadId, change) => {
      asked.push(change)
      await options.whileAsked?.(world)
      return answers.shift() ?? 'allowed'
    },
    ...(options.noMeshy ? {} : { meshy: {
      folderOf: async () => options.folder ?? root,
      // What this computer counts: what was used before, and each 3D model started here at its full cost.
      monthCredits: async () => { options.whileCounting?.(world); return (options.used ?? 0) + made.length * MODEL_COST.words },
      keyTrouble: () => null,
      checkPhoto,
      // The redraw keeps the pixels and drops the rest; here, the bytes after the marker stand for what is dropped.
      photoToSend: (folder, checked, path) => photoToSend(folder, checked, path, async bytes => ({ bytes: bytes.subarray(0, 4), kind: 'image/jpeg' })),
      make: async request => {
        made.push(request)
        const model: ThreeDModel = { id: 'model-1', threadId: request.threadId, accountId: request.accountId, name: request.name,
          source: request.source.kind === 'words' ? { kind: 'words', words: request.source.words } : { kind: 'photo', fileName: request.source.fileName },
          root: request.root, folder: join(request.root, request.folder ?? 'models'), formats: ['glb', 'usdz'], state: 'making', stage: 'shape', credits: 0, askedAt: '2026-11-15T09:00:00.000Z', files: [] }
        const ended = options.ended
        const done = ended === 'never' ? new Promise<ThreeDModel | undefined>(() => undefined) : ended === 'lost' ? Promise.resolve(undefined)
          : Promise.resolve({ ...model, state: 'done' as const, credits: 30, files: ['Oak barrel.png', 'Oak barrel.glb', 'Oak barrel.usdz'], ...ended })
        return { model, done }
      },
      showInThread: async (threadId, model) => { if (options.unshown) return false; shown.push({ threadId, id: model.id, name: model.name }); return true },
    } }),
  })
  servers.push(server)
  const make = (args: Record<string, unknown>, context: { waitMs?: number; signal?: AbortSignal } = {}) => server.call('one', MAKE_3D_MODEL_TOOL, args, context)
  return { server, world, asked, recorded, made, shown, make }
}
const said = (result: { content: { type: string; text?: string }[] }): string => result.content.map(part => part.text ?? '').join('\n')
const uses = (recorded: readonly PluginUseReport[]): string[] => recorded.map(use => `${use.tool} ${use.kind} ${use.outcome}`)
const BARREL = { name: 'Oak barrel', words: 'An oak barrel with iron hoops and moss on the lid' }

describe('making a 3D model through make_3d_model', () => {
  it('asks first with what goes to Meshy and what it costs, makes it after the yes, and answers with its files', async () => {
    const t = tools({ used: 140 })
    const result = await t.make(BARREL)
    expect(result.isError).toBeUndefined()
    expect(t.asked).toEqual([{ kind: 'meshy-model', account: 'Studio', name: 'Oak barrel', words: BARREL.words, credits: MODEL_COST.words, monthCredits: 140, monthlyLimit: 1_000, folder: 'models' }])
    expect(t.made).toEqual([expect.objectContaining({ threadId: 'one', accountId: STUDIO.id, name: 'Oak barrel', root, folder: 'models', source: { kind: 'words', words: BARREL.words } })])
    expect(said(result)).toBe('The user allowed it. The 3D model "Oak barrel" is made, for 30 credits. Its files, in the thread\'s folder: models/Oak barrel.png, models/Oak barrel.glb, models/Oak barrel.usdz.')
    expect(uses(t.recorded)).toEqual(['make_3d_model 3d-model done'])
  })

  it('words its card with the training line, the month’s credits so far and Make the model', () => {
    expect(wordPluginChange({ kind: 'meshy-model', account: 'Studio', name: 'Oak barrel', words: BARREL.words, credits: 30, monthCredits: 140, monthlyLimit: 1_000, folder: 'models' })).toEqual({
      plugin: 'Meshy',
      text: 'Make the 3D model Oak barrel with the Meshy account Studio? About 30 credits.',
      action: 'Make a 3D model with Meshy', target: 'Oak barrel',
      details: [
        `Sends Meshy these words: “${BARREL.words}”`,
        'Meshy may use what it is sent, and the 3D models it makes, to train its own models.',
        'About 30 credits on the Meshy account Studio; 140 of its 1,000 credits used this month.',
        'The files go to models in this thread’s folder.',
      ].join('\n'),
      allow: 'Make the model', deny: 'Deny',
    })
  })

  it('makes nothing when the user says no or nobody answers', async () => {
    const t = tools({ answers: ['denied', 'lapsed'] })
    expect(said(await t.make(BARREL))).toBe('The user said no. Nothing was sent to Meshy and nothing was charged. Do not ask again unless they tell you to.')
    expect(said(await t.make(BARREL))).toContain('Nobody answered in time')
    expect(t.made).toEqual([])
    expect(uses(t.recorded)).toEqual(['make_3d_model 3d-model denied', 'make_3d_model 3d-model lapsed'])
  })

  it('places the 3D model’s line in its thread once Meshy has it, and none when it is denied or refused', async () => {
    const t = tools()
    await t.make(BARREL)
    expect(t.shown).toEqual([{ threadId: 'one', id: 'model-1', name: 'Oak barrel' }])
    const denied = tools({ answers: ['denied'] })
    await denied.make(BARREL)
    const over = tools({ used: 980 })
    await over.make(BARREL)
    expect([...denied.shown, ...over.shown]).toEqual([])
    expect([...denied.made, ...over.made]).toEqual([])
  })

  it('makes the 3D model all the same when its line cannot go into the thread, and tells the agent so', async () => {
    const t = tools({ unshown: true })
    const result = await t.make(BARREL)
    expect(result.isError).toBeUndefined()
    expect(said(result)).toBe('The user allowed it. The 3D model "Oak barrel" is made, for 30 credits. Its files, in the thread\'s folder: models/Oak barrel.png, models/Oak barrel.glb, models/Oak barrel.usdz. Sotto could not show the 3D model in the thread, so tell the user its name and where its files go.')
    expect(uses(t.recorded)).toEqual(['make_3d_model 3d-model done'])
  })

  it('refuses one that would pass the month’s limit before asking or sending anything', async () => {
    const t = tools({ used: 980 })
    const result = await t.make(BARREL)
    expect(result.isError).toBe(true)
    expect(said(result)).toBe('This 3D model would cost about 30 credits, and 980 of the account\'s monthly limit of 1,000 credits are used this month, so it would pass the limit. Nothing was sent to Meshy and nothing was charged. Tell the user, who can raise the limit in Settings > Plugins.')
    expect([t.asked, t.made]).toEqual([[], []])
    expect(uses(t.recorded)).toEqual(['make_3d_model 3d-model refused'])
    // Exactly at the limit is within it.
    expect((await tools({ used: 970 }).make(BARREL)).isError).toBeUndefined()
  })

  it('looks at the limit again after the yes, as the user may have lowered it while the card waited', async () => {
    const t = tools({ whileAsked: world => { world.accounts = [{ ...STUDIO, spending: { askBefore: true, monthlyLimit: 10 } }] } })
    expect(said(await t.make(BARREL))).toContain('of the account\'s monthly limit of 10 credits')
    expect(t.made).toEqual([])
  })

  it('lets only one of two 3D models asked for at once fit under the limit', async () => {
    const t = tools()
    t.world.accounts = [{ ...STUDIO, spending: { askBefore: false, monthlyLimit: 40 } }]
    const results = await Promise.all([t.make(BARREL), t.make({ ...BARREL, name: 'Second barrel' })])
    expect(results.map(result => result.isError === true).sort()).toEqual([false, true])
    expect(t.made).toHaveLength(1)
  })

  it('makes one without a card once the user turned asking off, still within the limit', async () => {
    const t = tools()
    t.world.accounts = [{ ...STUDIO, spending: { askBefore: false, monthlyLimit: 1_000 } }]
    const result = await t.make(BARREL)
    expect(t.asked).toEqual([])
    expect(said(result)).toMatch(/^Made without a card, since the user turned asking off for the account\. The 3D model "Oak barrel" is made, for 30 credits\./u)
    t.world.accounts = [{ ...STUDIO, spending: { askBefore: false, monthlyLimit: 20 } }]
    expect((await t.make(BARREL)).isError).toBe(true)
    expect(t.made).toHaveLength(1)
  })

  it('sends a photo in the thread’s folder redrawn, and refuses one outside it, of another kind, or changed since it was asked for', async () => {
    await mkdir(join(root, 'art'))
    await writeFile(join(root, 'art', 'fox.jpg'), JPEG)
    const t = tools()
    expect((await t.make({ name: 'Fox', photo: 'art/fox.jpg' })).isError).toBeUndefined()
    expect(t.asked[0]).toMatchObject({ kind: 'meshy-model', photo: 'art/fox.jpg', credits: MODEL_COST.photo })
    // What goes is the redrawn photo, and not the bytes that stood for its camera details.
    expect(t.made[0]!.source).toEqual({ kind: 'photo', fileName: 'fox.jpg', photo: `data:image/jpeg;base64,${JPEG.subarray(0, 4).toString('base64')}` })
    const outside = await mkdtemp(join(tmpdir(), 'sotto-meshy-outside-'))
    try {
      await writeFile(join(outside, 'x.jpg'), JPEG)
      await writeFile(join(root, 'notes.jpg'), 'not a photo at all')
      expect(said(await t.make({ name: 'X', photo: join(outside, 'x.jpg') }))).toContain('is not inside the thread\'s folder')
      expect(said(await t.make({ name: 'X', photo: '../x.jpg' }))).toMatch(/is not inside the thread's folder|There is no photo/u)
      expect(said(await t.make({ name: 'X', photo: 'notes.jpg' }))).toContain('is not a JPEG or PNG photo')
    } finally { await rm(outside, { recursive: true, force: true }) }
    const changing = tools({ whileAsked: async () => { await writeFile(join(root, 'art', 'fox.jpg'), Buffer.concat([JPEG, Buffer.from('more')])) } })
    expect(said(await changing.make({ name: 'Fox', photo: 'art/fox.jpg' }))).toContain('changed or moved after it was asked for, so it was not sent')
    expect(changing.made).toEqual([])
  })

  it('takes words or a photo, not both, a folder inside the thread’s, and STL as the only extra format', async () => {
    const t = tools()
    for (const args of [{ name: 'X' }, { name: 'X', words: 'a', photo: 'a.jpg' }, { name: 'X', words: 'a', formats: ['obj'] }, { name: 'x'.repeat(81), words: 'a' }, { name: 'X', words: 'x'.repeat(801) }]) {
      expect((await t.make(args)).isError, JSON.stringify(args).slice(0, 80)).toBe(true)
    }
    for (const folder of ['../elsewhere', join(root, 'models'), 'a/../../b']) expect(said(await t.make({ ...BARREL, folder }))).toContain('must be a folder inside the thread\'s folder')
    expect((await t.make({ ...BARREL, formats: ['stl'], folder: 'art/3d' })).isError).toBeUndefined()
    expect(t.made[0]).toMatchObject({ formats: ['stl'], folder: 'art/3d' })
    expect(t.asked).toHaveLength(1)
  })

  it('shows the card after all when asking was turned back on while the call was being looked at', async () => {
    let counted = 0
    const t = tools({ answers: ['denied'], whileCounting: world => { if (++counted === 1) world.accounts = [{ ...STUDIO, spending: { askBefore: true, monthlyLimit: 1_000 } }] } })
    t.world.accounts = [{ ...STUDIO, spending: { askBefore: false, monthlyLimit: 1_000 } }]
    expect(said(await t.make(BARREL))).toContain('The user said no.')
    expect(t.asked).toHaveLength(1)
    expect(t.made).toEqual([])
  })

  it('sends no photo swapped after it was checked, even one of the same size and time, or one reached through a link', async () => {
    await mkdir(join(root, 'art'))
    const fox = join(root, 'art', 'fox.jpg')
    await writeFile(fox, JPEG)
    const same = Buffer.from(JPEG)
    same[same.length - 1] = same[same.length - 1]! ^ 1
    // The photo's time is a whole second, so the swapped one can be given exactly the same time and size.
    const when = new Date(2026, 0, 1, 12, 0, 0)
    await utimes(fox, when, when)
    const swapped = tools({ whileAsked: async () => {
      await writeFile(fox, same)
      await utimes(fox, when, when)
    } })
    expect(said(await swapped.make({ name: 'Fox', photo: 'art/fox.jpg' }))).toContain('changed or moved after it was asked for')
    expect(swapped.made).toEqual([])
    const outside = await mkdtemp(join(tmpdir(), 'sotto-meshy-outside-'))
    try {
      await writeFile(join(outside, 'fox.jpg'), same)
      await writeFile(fox, JPEG)
      const linked = tools({ whileAsked: async () => {
        await rm(join(root, 'art'), { recursive: true })
        await symlink(outside, join(root, 'art'), 'junction')
      } })
      expect(said(await linked.make({ name: 'Fox', photo: 'art/fox.jpg' }))).toContain('changed or moved after it was asked for')
      expect(linked.made).toEqual([])
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('stops a call its client gave up on, and says a 3D model is still being made when the client does not say how long it waits', async () => {
    const t = tools({ ended: 'never' })
    t.world.accounts = [{ ...STUDIO, spending: { askBefore: false, monthlyLimit: 1_000 } }]
    // A call its client already gave up on asks nothing of Meshy (Bug Bot on #2594, N1).
    const gone = new AbortController()
    gone.abort()
    expect(said(await t.make(BARREL, { signal: gone.signal }))).toBe('The call was stopped before the 3D model was asked for. Nothing was sent to Meshy and nothing was charged.')
    expect(t.made).toEqual([])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let answered = false
      const waiting = t.make(BARREL).finally(() => { answered = true })
      // The call reads files on its way to its timer, so the clock is moved on a minute at a time while they finish.
      for (let minute = 0; !answered && minute < 10; minute++) {
        await new Promise(resolve => setImmediate(resolve))
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(said(await waiting)).toContain('Meshy is still making the 3D model "Oak barrel"')
    } finally { vi.useRealTimers() }
  })

  it('says a 3D model is still being made when the client will not wait for it', async () => {
    // With asking off there is no card to wait on, so a client that waits ten seconds hears back at once.
    const t = tools({ ended: 'never' })
    t.world.accounts = [{ ...STUDIO, spending: { askBefore: false, monthlyLimit: 1_000 } }]
    const result = await t.make(BARREL, { waitMs: 10_100 })
    expect(said(result)).toBe('Asked of Meshy without a card, since the user turned asking off for the account. Meshy is still making the 3D model "Oak barrel". Sotto saves its files into models/ in the thread\'s folder when it is done, named after "Oak barrel"; about 30 credits.')
    expect(uses(t.recorded)).toEqual(['make_3d_model 3d-model done'])
  })

  it('does not say a 3D model is still being made once Sotto lost track of it', async () => {
    // Bug Bot on #2594, L2: the thread was removed, Sotto is stopping, or the record could not be written.
    const t = tools({ ended: 'lost' })
    const result = await t.make(BARREL)
    expect(result.isError).toBe(true)
    expect(said(result)).toMatch(/^Sotto lost track of the 3D model "Oak barrel" before it was done/u)
    expect(uses(t.recorded)).toEqual(['make_3d_model 3d-model failed'])
  })

  it('gives the files\' paths inside the thread\'s folder when that folder is reached through a link', async () => {
    // Bug Bot on #2594, L3.
    const linkTo = await mkdtemp(join(tmpdir(), 'sotto-meshy-link-'))
    const linked = join(linkTo, 'thread')
    try {
      await symlink(root, linked, 'junction')
      const t = tools({ folder: linked })
      expect(said(await t.make(BARREL))).toContain('Its files, in the thread\'s folder: models/Oak barrel.png, models/Oak barrel.glb, models/Oak barrel.usdz.')
      expect(t.made[0]!.root).toBe(root)
    } finally { await rm(linkTo, { recursive: true, force: true }) }
  })

  it('refuses a photo with more pixels than Sotto draws again, read from its header before anything decodes it', async () => {
    // Bug Bot on #2594, L1: a small PNG that says it is 16,000 pixels on a side.
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(16_000, 16)
    png.writeUInt32BE(16_000, 20)
    await writeFile(join(root, 'huge.png'), png)
    const t = tools()
    expect(said(await t.make({ name: 'Huge', photo: 'huge.png' }))).toContain('has more pixels than Sotto draws again')
    expect([t.asked, t.made]).toEqual([[], []])
    expect(pixelsOf(png, 'image/png')).toEqual({ width: 16_000, height: 16_000 })
    // A JPEG's size is in its first start of frame, past any other segment before it.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03])
    expect(pixelsOf(jpeg, 'image/jpeg')).toEqual({ width: 800, height: 600 })
    expect(pixelsOf(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toBeNull()
  })

  it('says plainly why one was not made, and that Meshy may have charged one it could not tell about', async () => {
    expect(said(await tools({ ended: { state: 'failed', failure: 'failed', credits: 20, files: [] } }).make(BARREL))).toBe('The 3D model "Oak barrel" was not made. Meshy could not finish the 3D model, and gave back the credits of what it could not make. 20 credits were counted for it.')
    expect(said(await tools({ ended: { state: 'lost', failure: 'unreachable', credits: 20, files: [] } }).make(BARREL))).toContain('Do not ask again for this one')
  })

  it('is not made on a computer whose threads cannot make 3D models yet', async () => {
    const t = tools({ noMeshy: true })
    expect(said(await t.make(BARREL))).toBe('Threads on this computer cannot make 3D models through Sotto yet. Nothing was sent to Meshy and nothing was charged.')
  })
})
