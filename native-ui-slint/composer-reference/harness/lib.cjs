// Prepended to step code by step.sh. Real input through webContents.sendInputEvent, so Chromium's own focus and
// :focus-visible rules apply as they do for a person's click; the pointer is then moved to empty transcript space
// (700, 400) so no control in a capture is hovered.
const wc = ctx.win().webContents
const centre = async selector => ctx.js(`const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing ' + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }`)
const move = async (x, y) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); await ctx.sleep(120) }
const click = async (selector, { away = true } = {}) => {
  const { x, y } = await centre(selector)
  await move(x, y)
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await ctx.sleep(40)
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await ctx.sleep(300)
  if (away) await move(700, 400)
}
const key = async (keyCode, modifiers = []) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); await ctx.sleep(20)
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await ctx.sleep(200)
}
