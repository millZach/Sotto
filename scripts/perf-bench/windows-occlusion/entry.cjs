// The benchmark's main entry, copied beside out/main/index.js by run.mjs. For the "off" side it turns Chromium's Windows
// occlusion detection off the way Sotto did before November 1, 2026 (ADR-0020), before the app's own main runs; then it
// loads the app, and the driver once the app is ready.
'use strict'
const { app } = require('electron')

if (process.env.OCCLUSION_SIDE === 'off') {
  const disabled = new Set(app.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean))
  disabled.add('CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-features', [...disabled].join(','))
}
require('./index.js')
if (process.env.OCCLUSION_DRIVE) require('./occlusion-driver.cjs')
