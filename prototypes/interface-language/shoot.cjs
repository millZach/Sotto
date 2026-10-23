// Screenshots every screen of the prototype at a laptop size and an iPhone size.
// Run: node prototypes/interface-language/shoot.cjs   (uses the main checkout's Playwright)
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const pw = process.env.PW_PATH || 'D:/Talk to Text Application/node_modules/playwright';
const { chromium } = require(pw);

const dir = __dirname;
const out = path.join(dir, 'shots');
const base = pathToFileURL(path.join(dir, 'index.html')).href;
const shots = [
  ['settings-A', 'screen=settings&variant=A'],
  ['settings-A-open', 'screen=settings&variant=A&open=1'],
  ['settings-A-es', 'screen=settings&variant=A&ui=es-MX'],
  ['settings-A-ar', 'screen=settings&variant=A&ui=ar&layout=kept'],
  ['settings-A-ar-open', 'screen=settings&variant=A&ui=ar&layout=kept&open=1'],
  ['settings-A-ar-mirrored', 'screen=settings&variant=A&ui=ar&layout=mirrored'],
  ['settings-B', 'screen=settings&variant=B'],
  ['settings-B-ja', 'screen=settings&variant=B&ui=ja'],
  ['settings-C', 'screen=settings&variant=C&disclose=1'],
  ['settings-C-hi', 'screen=settings&variant=C&ui=hi&disclose=1'],
  ['settings-A-light', 'screen=settings&variant=A&mode=light&ui=zh-Hans'],
  ['rtl-ar', 'screen=rtl&rtl=ar&layout=kept'],
  ['rtl-ar-kept-clean-light', 'screen=rtl&rtl=ar&layout=kept&marks=0&mode=light'],
  ['rtl-ar-mirrored', 'screen=rtl&rtl=ar&layout=mirrored'],
  ['rtl-ur', 'screen=rtl&rtl=ur&layout=kept&marks=0'],
  ['rtl-ur-mirrored', 'screen=rtl&rtl=ur&layout=mirrored&marks=0'],
  ['cjk-zh', 'screen=cjk&cjk=zh-Hans'],
  ['cjk-ja', 'screen=cjk&cjk=ja&mode=light'],
  ['hindi', 'screen=hindi'],
  ['hindi-en', 'screen=hindi&hl=en'],
];
const sizes = [['desktop', { width: 1440, height: 900 }, 1], ['phone', { width: 390, height: 844 }, 2]];
const only = process.argv[2];

(async () => {
  const fs = require('node:fs');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const [sname, viewport, scale] of sizes) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.error('pageerror', e.message));
    for (const [name, qs] of shots) {
      if (only && !name.includes(only)) continue;
      await page.goto(`${base}?${qs}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const file = path.join(out, `${name}-${sname}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
    }
    await ctx.close();
  }
  await browser.close();
})();
