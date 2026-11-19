# Puts the spike binary beside CEF's runtime files on Windows, as an install would: libcef.dll and its resources next
# to webpane.exe, one locale. Copies, not links: Defender and the loader should see what an install has.
# Usage: powershell -File dist.ps1 [dist-folder]
param([string]$Dist = "D:\sotto-webpane-work\dist")
$ErrorActionPreference = "Stop"
$cef = if ($env:CEF_DIR) { $env:CEF_DIR } else { "D:\sotto-cef\156.0.31\cef_windows_x86_64" }
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "D:\sotto-cargo-target-webpane" }
New-Item -ItemType Directory -Force "$Dist\locales" | Out-Null
$files = "libcef.dll", "chrome_elf.dll", "d3dcompiler_47.dll", "dxcompiler.dll", "vk_swiftshader.dll", "vk_swiftshader_icd.json",
  "vulkan-1.dll", "icudtl.dat", "v8_context_snapshot.bin", "resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak"
foreach ($f in $files) { Copy-Item "$cef\$f" "$Dist\$f" -Force }
Copy-Item "$cef\locales\en-US.pak" "$Dist\locales\en-US.pak" -Force
Copy-Item "$target\release\webpane.exe" "$Dist\webpane.exe" -Force
$Dist
