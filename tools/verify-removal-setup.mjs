// Run: npm run build, then node tools/verify-removal-setup.mjs; no other Electron journey may use the desktop.
/* global console */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
const requireRepo = createRequire(path.resolve('package.json'));
const { _electron: electron, expect } = requireRepo('@playwright/test');
const captures = path.resolve('artifacts/voice-control-removal/merged-setup');
fs.mkdirSync(captures, { recursive: true });


function removeOwnedProfile(profile) {
  const target = path.resolve(profile), root = path.resolve(os.tmpdir());
  if (!target.startsWith(root + path.sep) || !path.basename(target).startsWith('sotto-e2e-removal-merge-')) throw Error('Refuse to remove unowned profile');
  fs.rmSync(target, { recursive: true, force: true });
}

(async () => {
  const results = [];
  for (const [width, height, appearance] of [[1600, 1000, 'light'], [1280, 800, 'dark'], [820, 560, 'dark']]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sotto-e2e-removal-merge-'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ appearance, reducedMotion: 'on', onboardingComplete: false }));
    let app;
    try {
      const env = { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile };
      delete env.ELECTRON_RUN_AS_NODE;
      app = await electron.launch({ args: ['--force-device-scale-factor=1', path.resolve('out/main/index.js')], env });
      let page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      if (!page.url().endsWith('/index.html')) page = await app.waitForEvent('window', { predicate: async item => { await item.waitForLoadState('domcontentloaded'); return item.url().endsWith('/index.html'); } });
      const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html')).setSize(size.width, size.height), { width, height });
      await expect.poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight])).toEqual([width, height]);
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      const slug = `${width}x${height}-${appearance}`;
      await expect(page.getByText('Step 1 of 9', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'Get started', exact: true }).click();
      for (let step = 2; step <= 9; step++) {
        await expect(page.getByText(`Step ${step} of 9`, { exact: false })).toBeVisible();
        if (step === 3) {
          await page.getByRole('button', { name: /test microphone/i }).click();
          await expect(page.getByText(/microphone ready/i)).toBeVisible();
        }
        const bounds = await page.locator('.onboarding-actions').boundingBox();
        if (!bounds || bounds.y < 0 || bounds.y + bounds.height > height + 1) throw Error('Setup footer clipped at ' + slug + ' step ' + step);
        if (step === 6) await page.screenshot({ animations: 'disabled', path: path.join(captures, `agents-${slug}.png`) });
        if (step === 9) await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
        else await page.locator('.onboarding-actions').getByRole('button', { name: /^(Continue|Skip for now)$/ }).click();
      }
      const tour = page.locator('.threads-tour');
      for (const [index, title] of ['Projects and threads', 'New thread', 'Threads', 'Settings'].entries()) {
        await expect(tour.getByRole('heading', { name: title, exact: true })).toBeVisible();
        await expect(tour.getByRole('heading', { name: title, exact: true })).toBeFocused();
        const bounds = await tour.locator('.threads-tour__note').boundingBox();
        if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1) throw Error('Tour clipped at ' + slug + ' ' + title);
        if (index === 0) await page.screenshot({ animations: 'disabled', path: path.join(captures, `tour-${slug}.png`) });
        await tour.getByRole('button', { name: index === 3 ? 'Done' : 'Next', exact: true }).click();
      }
      await expect(tour).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'New thread', exact: true })).toBeFocused();
      if (pageErrors.length) throw Error('Page errors: ' + pageErrors.join(', '));
      results.push({ width, height, appearance, steps: 9, tourStops: 4, pageErrors: 0, result: 'passed' });
      console.log('Passed setup and all tour stops: ' + slug);
    } finally {
      await app?.close();
      removeOwnedProfile(profile);
    }
  }
  fs.writeFileSync(path.join(captures, 'journey.json'), JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
