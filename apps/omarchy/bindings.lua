-- Load after Omarchy's defaults, from ~/.config/hypr/bindings.lua.
-- For ~/.config/hypr/sotto-bindings.lua, use require("hypr.sotto-bindings").
-- hl.unbind removes every occurrence, including Voxtype's F9 release binding.
hl.unbind("F9")
hl.unbind("SUPER + CTRL + X")

-- For a development checkout, set this to its absolute apps/omarchy/sotto path.
local sotto = "sotto"
-- o.bind uses hl.dsp.exec_cmd. Explicitly evaluate the event stamp in a shell
-- before the launcher boots Electron in Node mode, including for release.
local function dictation(command)
  return "sh -c " .. o.shell_quote(sotto .. " dictation " .. command .. ' --at "$(date +%s%N)"')
end
o.bind("F9", "Start dictation (push-to-talk)", dictation("start"))
o.bind("F9", "Stop dictation (push-to-talk)", dictation("stop"), { release = true })
o.bind("SUPER + CTRL + X", "Toggle dictation", dictation("toggle"))
