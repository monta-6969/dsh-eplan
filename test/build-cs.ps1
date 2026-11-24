param(
  [string]$Source = 'test\probe2.cs',
  [string]$Out    = 'test\probe2.exe'
)
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$eplanBin = 'D:\EPLAN\Platform\2.9.4\Bin'
if ($env:EPLAN_BIN -and (Test-Path -LiteralPath $env:EPLAN_BIN)) { $eplanBin = $env:EPLAN_BIN }
$csc      = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

$src = if ([System.IO.Path]::IsPathRooted($Source)) { $Source } else { Join-Path $root $Source }
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }

# 探针工具要能引用 EPLAN 的任何程序集：AF 用于 ActionManager，
# Gui 用于界面相关类型，DataModel 用来摸对象模型。
$wanted = @(
  'Eplan.EplApi.Remotingu.dll',
  'Eplan.EplApi.RemoteClientu.dll',
  'Eplan.EplApi.Baseu.dll',
  'Eplan.EplApi.AFu.dll',
  'Eplan.EplApi.Guiu.dll',
  'Eplan.EplApi.DataModelu.dll',
  'Eplan.EplApi.Systemu.dll',
  'Eplan.EplApi.HEServicesu.dll',
  'Eplan.EplApi.EServicesu.dll'
)
$refs = New-Object System.Collections.ArrayList
foreach ($name in $wanted) {
  $path = Join-Path $eplanBin $name
  if (Test-Path -LiteralPath $path) { [void]$refs.Add($path) }
}

$arguments = New-Object System.Collections.ArrayList
foreach ($a in @('-nologo', '-target:exe', '-platform:x64', '-langversion:5')) { [void]$arguments.Add($a) }
[void]$arguments.Add("-out:$outPath")
foreach ($r in $refs) { [void]$arguments.Add("-r:$r") }
[void]$arguments.Add($src)

& $csc $arguments.ToArray()
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
Write-Host "OK $outPath" -ForegroundColor Green
