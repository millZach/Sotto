import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import sharp from 'sharp'
import { ownedE2EProfile } from './support/e2eProfile'
import { completeFirstRunSetup, firstSottoWindow, launchSotto, closeSotto, openPage, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { designThreadsFixture } from '../../src/shared/e2e'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'

const enabled = process.platform === 'linux' && existsSync('/usr/share/omarchy/bin/omarchy-theme-set-templates') && process.env.SOTTO_OMARCHY_EVIDENCE === '1'
const evidence = resolve('artifacts/omarchy-theme')
const proof: unknown[] = []

async function renderTheme(home: string, slug: string): Promise<void> {
  const current = join(home, '.local/state/omarchy/current'), next = join(current, 'next-theme')
  await mkdir(next, { recursive: true })
  await copyFile(`/usr/share/omarchy/themes/${slug}/colors.toml`, join(next, 'colors.toml'))
  execFileSync('/usr/share/omarchy/bin/omarchy-theme-set-templates', [], {
    env: { ...process.env, HOME: home, OMARCHY_PATH: '/usr/share/omarchy', PATH: `/usr/share/omarchy/bin:${process.env.PATH}` }, stdio: 'pipe',
  })
  await rm(join(current, 'theme'), { recursive: true, force: true })
  await rename(next, join(current, 'theme'))
  await writeFile(join(current, 'theme.name'), slug)
}
async function appearance(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
  await page.locator('#settings-appearance').evaluate(element => element.scrollIntoView({ block:'start' }))
}

/** Measure actual text interiors and their background pixels inside each saved capture. */
async function capture(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.evaluate(() => document.fonts.ready)
  const regions = await page.evaluate(() => {
    const samples: Array<{text:string; color:string; rect:{x:number;y:number;width:number;height:number}}> = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement
      if (!parent || !node.textContent?.trim()) continue
      const style = getComputedStyle(parent)
      if (style.visibility !== 'visible' || style.display === 'none') continue
      const range = document.createRange(); range.selectNodeContents(node)
      for (const r of range.getClientRects()) {
        if (r.width < 10 || r.height < 8 || r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) continue
        // Skip descendants of clipped scroll content and hidden overlays.
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        if (top && (parent === top || parent.contains(top) || top.contains(parent))) samples.push({text:node.textContent.trim().slice(0,60),color:style.color,rect:{x:r.x,y:r.y,width:r.width,height:r.height}})
      }
    }
    return samples
  })
  const requested = /-(\d+)x(\d+)$/.exec(name)
  const clip = requested ? {x:0,y:0,width:Number(requested[1]),height:Number(requested[2])} : undefined
  const png = await page.screenshot({ path:join(evidence, `${name}.png`), caret:'hide', animations:'disabled', ...(clip ? {clip} : {}) })
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject:true })
  const measurements: unknown[] = []
  for (const sample of regions) {
    const expected = parseThemeRgb(sample.color, {r:0,g:0,b:0})
    const counts = new Map<string,number>()
    let foreground: {r:number;g:number;b:number} | null = null, distance = Infinity
    for (let y=Math.ceil(sample.rect.y); y<Math.floor(sample.rect.y+sample.rect.height); y++) for(let x=Math.ceil(sample.rect.x); x<Math.floor(sample.rect.x+sample.rect.width); x++) {
      const offset=(y*info.width+x)*info.channels
      const rgb={r:data[offset]!,g:data[offset+1]!,b:data[offset+2]!}
      const delta=Math.max(Math.abs(rgb.r-expected.r),Math.abs(rgb.g-expected.g),Math.abs(rgb.b-expected.b))
      if(delta<distance){distance=delta;foreground=rgb}
      const key=`${rgb.r},${rgb.g},${rgb.b}`;counts.set(key,(counts.get(key)??0)+1)
    }
    const [backgroundKey] = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0] ?? []
    if (!backgroundKey || !foreground || distance>2) continue // thin antialiased glyphs have no solid interior
    const [r,g,b]=backgroundKey.split(',').map(Number)
    const ratio=contrastRatio(foreground,{r:r!,g:g!,b:b!})
    measurements.push({text:sample.text,foreground,background:backgroundKey,ratio})
    expect(ratio, `${name}: ${sample.text}`).toBeGreaterThanOrEqual(4.5)
  }
  expect(measurements.length, `${name}: measured visible text interiors`).toBeGreaterThan(name.startsWith('widget-') ? 0 : 2)
  proof.push({capture:`${name}.png`,dimensions:[info.width,info.height],measurements})
}

async function size(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Sotto')!
    // Hyprland adds 20 pixels to a client's minimum. Reach Sotto's specified content minimum.
    window.setMinimumSize(800, 540)
  })
  const pid = launched.app.process().pid!
  const env = { ...process.env }
  const clients = JSON.parse(execFileSync('hyprctl', ['clients','-j'],{env,encoding:'utf8'})) as Array<{pid:number;address:string;title:string}>
  const client = clients.find(client => client.pid === pid && client.title === 'Sotto')!
  expect(client).toBeTruthy()
  execFileSync('hyprctl', ['dispatch', `hl.dsp.window.float({ action = "enable", window = "address:${client.address}" })`],{env})
  execFileSync('hyprctl', ['dispatch', `hl.dsp.window.resize({ x = ${width}, y = ${height}, window = "address:${client.address}" })`],{env})
  await expect.poll(async () => launched.page.evaluate(([w,h]) => Math.max(Math.abs(innerWidth-w!), Math.abs(innerHeight-h!)), [width,height])).toBeLessThanOrEqual(1)
  execFileSync('hyprctl', ['dispatch', `hl.dsp.window.move({ x = 0, y = 0, window = "address:${client.address}" })`], { env })
}

test('Omarchy switches repaint both windows, keep choices, and read at all review sizes', async () => {
  test.skip(!enabled, 'Run SOTTO_OMARCHY_EVIDENCE=1 in an owned nested Hyprland with TMPDIR inside the worktree')
  test.setTimeout(240_000)
  const profile = await ownedE2EProfile({prefix:'sotto-e2e-omarchy-theme-'})
  const home = join(profile.directory,'home')
  await mkdir(join(home,'.config/omarchy/themed'),{recursive:true})
  await copyFile('apps/omarchy/sotto.json.tpl',join(home,'.config/omarchy/themed/sotto.json.tpl'))
  await renderTheme(home,'tokyo-night')
  // Exercise the install path too, including its one-time render.
  await mkdir(join(home, 'runtime'))
  execFileSync(resolve('apps/omarchy/install-theme.sh'),[],{env:{...process.env,HOME:home,XDG_RUNTIME_DIR:join(home,'runtime')},stdio:'pipe'})
  const fixture=designThreadsFixture()
  await writeFile(join(profile.directory,'agents.json'),JSON.stringify({configuration:{provider:'codex',enabled:true,projectsDirectory:'',defaultModelId:'claude:sonnet',followupLimit:5,speak:false,speechProvider:'system',speechVoice:'F1',grokSpeechVoice:'ara',wakeModelDirectory:'',wakeRuntimeDirectory:'',reasoning:'none',reasoningModel:'',reasoningEffort:''},assignments:fixture.assignments,queue:[],activeThreadId:null,activeProjectId:null,draft:'',draftThreadId:null,draftRequestId:null,composing:false,pendingRequest:'',contextSavedAt:Date.now(),outbox:[]}))
  const launch = () => launchSotto('design-threads',profile.directory,{
    createProfile:async()=>profile.directory,removeProfile:async()=>{},firstWindow:firstSottoWindow,
    launch:(options={})=>electron.launch({...options,args:['--ozone-platform=wayland','--password-store=basic',...options.args!],env:{...options.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.local/state'),XDG_DATA_HOME:join(home,'.local/share'),XDG_CACHE_HOME:join(home,'.cache')}}),
  })
  let launched: LaunchedSotto | undefined
  try {
    launched=await launch()
    const page=launched.page
    await expect(page.locator('html')).toHaveAttribute('data-theme-id','omarchy')
    expect(await page.evaluate(()=>window.sotto!.getSettings())).toMatchObject({appearance:'system',lightTheme:'omarchy',darkTheme:'omarchy'})
    await completeFirstRunSetup(page)
    await openThreads(page)
    await page.getByRole('complementary', { name: /Thread sidebar/ }).getByText('Visual gate flake', { exact: true }).click()
    await expect(page.locator('.thread-transcript')).toBeVisible()
    await appearance(page)
    const dark=page.getByRole('radiogroup',{name:'Dark theme'})
    await expect(dark.getByRole('radio',{name:'Omarchy Tokyo Night'})).toBeChecked()
    await dark.getByRole('radio',{name:'Sotto',exact:true}).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-id','t3-code')
    await dark.getByRole('radio',{name:'Omarchy Tokyo Night'}).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-id','omarchy')
    await page.emulateMedia({reducedMotion:'reduce'})
    await expect.poll(()=>launched!.app.windows().some(page=>page.url().endsWith('/widget.html'))).toBe(true)
    const widget=launched.app.windows().find(page=>page.url().endsWith('/widget.html'))!
    for(const slug of ['tokyo-night','catppuccin-latte','rose-pine','hackerman']) {
      await renderTheme(home,slug)
      const mode=['catppuccin-latte','rose-pine'].includes(slug)?'light':'dark'
      await expect(page.locator('html')).toHaveAttribute('data-theme',mode)
      await expect.poll(()=>page.evaluate(()=>window.sotto!.getSettings().then(s=>s.omarchyTheme?.sourceName))).toBe(slug.split('-').map(s=>s[0]!.toUpperCase()+s.slice(1)).join(' '))
      await expect(widget.locator('html')).toHaveAttribute('data-theme',mode)
      await expect.poll(()=>widget.evaluate(()=>document.documentElement.style.getPropertyValue('--theme-canvas'))).toBe(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--theme-canvas')))
      for(const [width,height] of [[1600,1000],[1280,800],[820,560]]) {
        await size(launched,width!,height!)
        await openThreads(page)
        if (width === 820) {
          // The transcript scrolls at the minimum; keep the pending request's controls in view.
          await page.getByRole('button', { name: 'Deny', exact: true }).scrollIntoViewIfNeeded()
        }
        await capture(page,`threads-${slug}-${width}x${height}`)
        await appearance(page)
        await capture(page,`appearance-${slug}-${width}x${height}`)
        expect(await page.locator('.theme-halves').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
      }
      await widget.getByTestId('widget-sliver').hover()
      await capture(widget,`widget-${slug}`)
    }
    // Missing and invalid files fall back, preserving the waiting choice and then recovering.
    const file=join(home,'.local/state/omarchy/current/theme/sotto.json')
    await writeFile(file,'{{ broken }}')
    await expect(page.locator('html')).toHaveAttribute('data-theme-id','t3-code')
    await rm(file)
    expect(await page.evaluate(()=>window.sotto!.getSettings())).toMatchObject({lightTheme:'omarchy',darkTheme:'omarchy',omarchyTheme:null})
    await renderTheme(home,'tokyo-night')
    await expect(page.locator('html')).toHaveAttribute('data-theme-id','omarchy')
    await closeSotto(launched);launched=await launch()
    await expect(launched.page.locator('html')).toHaveAttribute('data-theme-id','omarchy')
    expect(JSON.parse(await readFile(join(profile.directory,'settings.json'),'utf8'))).not.toHaveProperty('omarchyTheme')
    await writeFile(join(evidence,'proof.json'),JSON.stringify(proof,null,2)+'\n')
  } finally { if(launched)await closeSotto(launched);await profile.dispose() }
})
