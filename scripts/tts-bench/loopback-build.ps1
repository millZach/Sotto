$ErrorActionPreference = 'Stop'
$repoDirectory = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$outputDirectory = Join-Path $repoDirectory 'artifacts/tts-bench/loopback-build'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$visualStudio = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio) { throw 'MSVC C++ build tools are required.' }
$compiler = Get-ChildItem (Join-Path $visualStudio 'VC/Tools/MSVC/*/bin/Hostx64/x64/cl.exe') | Sort-Object FullName -Descending | Select-Object -First 1
$msvcRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler.FullName)))
$sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10"
$sdkVersion = Get-ChildItem (Join-Path $sdkRoot 'Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
$env:INCLUDE = "$msvcRoot\include;$sdkRoot\Include\$sdkVersion\ucrt;$sdkRoot\Include\$sdkVersion\shared;$sdkRoot\Include\$sdkVersion\um;$sdkRoot\Include\$sdkVersion\winrt"
$env:LIB = "$msvcRoot\lib\x64;$sdkRoot\Lib\$sdkVersion\ucrt\x64;$sdkRoot\Lib\$sdkVersion\um\x64"
$executable = Join-Path $outputDirectory 'loopback.exe'
& $compiler.FullName /nologo /EHsc /std:c++17 /DNTDDI_VERSION=0x0A00000B /D_WIN32_WINNT=0x0A00 (Join-Path $PSScriptRoot 'loopback.cpp') "/Fo$outputDirectory\loopback.obj" "/Fe$executable" /link ole32.lib mmdevapi.lib
if ($LASTEXITCODE -ne 0) { throw 'Loopback build failed.' }
Write-Output $executable
