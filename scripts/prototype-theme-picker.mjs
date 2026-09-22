// PROTOTYPE, throwaway: opens Sotto in development with a fresh, throwaway profile so the
// theme-picker variants can be tried without touching your real settings. Settings → Appearance,
// then use the black bar at the bottom (or ← →) to switch variants and palettes.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const profile = mkdtempSync(join(tmpdir(), 'sotto-e2e-theme-prototype-'))
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ onboardingComplete: true }), 'utf8')
const child = spawn('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: profile, VITE_THEME_PROTOTYPE: '1' },
})
child.on('exit', code => process.exit(code ?? 0))
