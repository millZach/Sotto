#!/usr/bin/env bash
# sequence.sh <dark|light>: every state and menu of the composer for one appearance, into ../<theme>-*.png/json.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$1
F='form.thread-prompt'
"$here/step.sh" <<EOF2
await ctx.js(\`await window.sotto.updateSettings({ appearance: '$t', lightTheme: 't3-code', darkTheme: 't3-code' })\`)
await ctx.sleep(800)
await move(700, 400)
await ctx.js(\`document.activeElement?.blur()\`)
return await ctx.js(\`return [document.documentElement.dataset.theme, document.documentElement.dataset.themeId]\`)
EOF2
# 1a: empty, not focused, placeholder showing.
"$here/shoot.sh" "$t-1a-empty" "[\"$F\"]"
# 3: each menu, opened by a real click from the empty state, then closed with Escape.
open_menu() { # name trigger-selector menu-selector
  "$here/step.sh" <<EOF2
await click('$2')
return await ctx.js(\`return document.querySelector('$2').getAttribute('aria-expanded')\`)
EOF2
  "$here/shoot.sh" "$t-$1" "[\"$3\", \"$F\"]" "[\"$F\", \"$3\"]"
  "$here/step.sh" <<EOF2
await key('Escape'); await ctx.sleep(300)
let open = await ctx.js(\`return document.querySelector('$2').getAttribute('aria-expanded')\`)
if (open === 'true') { await key('Escape'); open = await ctx.js(\`return document.querySelector('$2').getAttribute('aria-expanded')\`) }
await ctx.js(\`document.activeElement?.blur()\`)
return open
EOF2
}
open_menu 3a-permissions-menu "$F .thread-prompt__shield .thread-chip" "$F .thread-prompt__shield .thread-chip-menu__list"
open_menu 3b-model-menu "$F .model-picker__trigger" "$F .model-picker__dialog"
open_menu 3c-effort-menu "$F .split-chip-effort__trigger" "$F .split-chip-effort__menu"
# 1b: a real click into the prompt, then the text.
"$here/step.sh" <<'EOF2'
await click('form.thread-prompt .prompt-editor')
wc.insertText('Before merging, check crash-after.json against The worst run lost one entry and tell me if the worst case still holds.')
await ctx.sleep(800)
return await ctx.js(`return [document.activeElement.className, document.querySelector('form.thread-prompt .prompt-editor').textContent]`)
EOF2
"$here/shoot.sh" "$t-1b-typed" "[\"$F\"]"
# 1c: one file attached, as a paste of crash-after.json into the prompt (the paste path the composer takes for files).
"$here/step.sh" <<'EOF2'
await ctx.js(`const runs = Array.from({ length: 5 }, (_, i) => ({ run: i + 1, entriesWritten: 1200, entriesRead: i === 3 ? 1199 : 1200, lost: i === 3 ? ['entry-0841'] : [], killedAfterMs: 400 + i * 150 }))
  const text = JSON.stringify({ test: 'crash-after', startedAt: '2026-11-19T08:12:04Z', runs }, null, 2)
  const dt = new DataTransfer(); dt.items.add(new File([text], 'crash-after.json', { type: 'application/json' }))
  document.querySelector('form.thread-prompt .prompt-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))`)
for (let i = 0; i < 50 && !(await ctx.js(`return !!document.querySelector('form.thread-prompt .attached-file')`)); i++) await ctx.sleep(100)
await ctx.sleep(600)
return await ctx.js(`return [document.activeElement.className, document.querySelector('form.thread-prompt .attached-file')?.textContent]`)
EOF2
"$here/shoot.sh" "$t-1c-attached" "[\"$F\"]"
# Clear the draft for the next run: remove the file, select all, delete.
"$here/step.sh" <<'EOF2'
await click('form.thread-prompt .attached-file button')
await click('form.thread-prompt .prompt-editor')
await key('A', ['control']); await key('Backspace')
await ctx.js(`document.activeElement?.blur()`)
await ctx.sleep(500)
return await ctx.js(`return [document.querySelector('form.thread-prompt .prompt-editor').textContent, document.querySelectorAll('form.thread-prompt .attached-file').length]`)
EOF2
