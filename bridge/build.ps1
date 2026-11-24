# 编译桥接器。
#
# 这台机器没有 .NET SDK，但 Windows 自带 .NET Framework 4.x 的 csc.exe 和 4.8 引用程序集，
# 足够编一个引用 EplApi 的控制台程序。C# 语言版本是 5，所以代码里不要用
# 字符串内插、? 、nameof、表达式体成员这些语法。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File bridge\build.ps1
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$eplanBin = 'D:\EPLAN\Platform\2.9.4\Bin'
$csc      = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$outDir   = Join-Path $PSScriptRoot 'bin'
# 带时间戳：桥接器跑起来后 DLL/EXE 会被占用，同名覆盖必然 CS0016。
# 和宿主 DLL 用同一套办法 —— 每次输出新文件，启动时取最新的那个。
$stamp = [DateTime]::UtcNow.Ticks
$outExe   = Join-Path $outDir ("EplanBridge-" + $stamp + '.exe')

if (-not (Test-Path -LiteralPath $csc)) {
  throw "找不到 csc.exe: $csc"
}
if (-not (Test-Path -LiteralPath $eplanBin)) {
  throw "找不到 EPLAN Bin 目录: $eplanBin"
}
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

$refs = @(
  'Eplan.EplApi.Remotingu.dll'
  'Eplan.EplApi.RemoteClientu.dll'
  'Eplan.EplApi.Baseu.dll'
  'Eplan.EplApi.AFu.dll'
) | ForEach-Object { Join-Path $eplanBin $_ }

foreach ($ref in $refs) {
  if (-not (Test-Path -LiteralPath $ref)) { throw "缺少引用: $ref" }
}

$sources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.cs' |
  Sort-Object Name |
  ForEach-Object { $_.FullName })

if ($sources.Count -eq 0) { throw "bridge\src 下没有 .cs 文件" }

$arguments = @(
  '-nologo'
  '-target:exe'
  '-platform:x64'
  '-optimize+'
  "-out:$outExe"
)
foreach ($ref in $refs) { $arguments += "-r:$ref" }
$arguments += $sources

Write-Host "csc $($arguments -join ' ')"
& $csc @arguments
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

if (-not (Test-Path -LiteralPath $outExe)) { throw "编译未产出 $outExe" }
Write-Host "OK $outExe" -ForegroundColor Green
