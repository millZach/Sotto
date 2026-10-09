-- Load after Omarchy's defaults, from ~/.config/hypr/bindings.lua.
-- For ~/.config/hypr/sotto-bindings.lua, use require("hypr.sotto-bindings").
-- hl.unbind removes every occurrence, including Voxtype's F9 release binding.
hl.unbind("F9")
hl.unbind("SUPER + CTRL + X")

-- For a development checkout, set this to its absolute apps/omarchy/sotto path.
local sotto = "sotto"
o.bind("F9", "Start dictation (push-to-talk)", sotto .. " dictation start")
o.bind("F9", "Stop dictation (push-to-talk)", sotto .. " dictation stop", { release = true })
o.bind("SUPER + CTRL + X", "Toggle dictation", sotto .. " dictation toggle")
