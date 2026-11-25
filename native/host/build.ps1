# 编译 EPLAN 进程内宿主 EplanMcpHost-<ticks>.dll。
#
# 与桥接器的区别：宿主必须引用 DataModel / HEServices / Base，因为它要真的画图。
# 用 .NET Framework 4.x 的 csc.exe（C# 5 语言版本），所以源码里不能出现
# 字符串内插、? 、nameof、表达式体成员。
#
# 产物带时间戳后缀：EPLAN 加载后会锁住 DLL 文件，覆盖会报 CS0016。
# 每次构建产生新文件名，引导脚本每次调用挑最新的那个，实现热重载。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File native\host\build.ps1
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
# EPLAN 安装目录：先看 EPLAN_BIN，再看 setup.mjs 写的配置，最后才是本机默认路径。
$eplanBin = 'D:\EPLAN\Platform\2.9.4\Bin'
if ($env:EPLAN_BIN -and (Test-Path -LiteralPath $env:EPLAN_BIN)) {
  $eplanBin = $env:EPLAN_BIN
} else {
  $configFile = Join-Path (Join-Path $env:LOCALAPPDATA 'eplan-mcp') 'eplan.config.json'
  if (Test-Path -LiteralPath $configFile) {
    try {
      $configured = (Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).eplanExe
      if ($configured -and (Test-Path -LiteralPath $configured)) { $eplanBin = Split-Path -Parent $configured }
    } catch { }
  }
}
$csc      = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$outDir   = Join-Path $PSScriptRoot 'bin'

if (-not (Test-Path -LiteralPath $csc)) { throw "找不到 csc.exe: $csc" }
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$stamp  = [DateTime]::UtcNow.Ticks
$outDll = Join-Path $outDir ("EplanMcpHost-$stamp.dll")

# 宿主 + 共用 JSON 源码一起编进同一个 DLL。
$sources = New-Object System.Collections.ArrayList
[void]$sources.Add((Join-Path $root 'bridge\src\Json.cs'))
$hostSources = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' | Sort-Object Name
foreach ($file in $hostSources) { [void]$sources.Add($file.FullName) }

$refs = New-Object System.Collections.ArrayList
foreach ($name in @('Eplan.EplApi.Baseu.dll', 'Eplan.EplApi.DataModelu.dll', 'Eplan.EplApi.AFu.dll', 'Eplan.EplApi.HEServicesu.dll', 'Eplan.EplApi.Systemu.dll')) {
  $path = Join-Path $eplanBin $name
  if (-not (Test-Path -LiteralPath $path)) { throw "缺少引用: $path" }
  [void]$refs.Add($path)
}

$arguments = New-Object System.Collections.ArrayList
foreach ($a in @('-nologo', '-target:library', '-platform:x64', '-optimize+', '-langversion:5')) { [void]$arguments.Add($a) }
[void]$arguments.Add("-out:$outDll")
foreach ($r in $refs) { [void]$arguments.Add("-r:$r") }
foreach ($s in $sources) { [void]$arguments.Add($s) }

Write-Host "csc -> $(Split-Path -Leaf $outDll)"
Write-Host ("源文件 " + $sources.Count + " 个")

$argArray = $arguments.ToArray()
& $csc $argArray
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $outDll)) { throw "未产出 $outDll" }

# 只保留最近 5 个版本，免得目录里堆几百个 DLL。
$old = Get-ChildItem -LiteralPath $outDir -Filter 'EplanMcpHost-*.dll' |
       Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 5
foreach ($file in $old) {
  try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop }
  catch {
    # 被 EPLAN 锁住的删不掉，留着无妨（引导脚本只挑最新的）。
  }
}

Write-Host "OK $outDll" -ForegroundColor Green
Write-Host '重新生成引导脚本: powershell -NoProfile -ExecutionPolicy Bypass -File native\script\prepare-install.ps1' -ForegroundColor DarkGray
