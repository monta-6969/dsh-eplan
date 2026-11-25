# 校验引导脚本能不能被 EPLAN 的脚本编译器编过。
#
# 这一步很重要：EPLAN 自己的脚本编译器引用集是写死的（见 EplanEplApiScriptLogu.erx），
# 和普通 csc 编译完全不是一回事。本地先用一模一样的引用集编一遍，
# 就能在把脚本塞进 EPLAN 之前发现 CS0234 那类"命名空间不存在"的错误。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File script\verify-bootstrap.ps1
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$eplanBin = 'D:\EPLAN\Platform\2.9.4\Bin'
$csc      = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$script   = Join-Path $PSScriptRoot 'EplanMcpBootstrap.cs'
$hostDll  = Join-Path $root 'host\bin\EplanMcpHost.dll'
$tempDir  = Join-Path $env:TEMP ('eplan-bootstrap-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
  # 把 HostPath 换成真实路径，和安装时的做法一致。
  $source = Get-Content -LiteralPath $script -Raw -Encoding UTF8
  $source = $source.Replace('__HOST_DLL_PATH__', $hostDll)
  $patched = Join-Path $tempDir 'EplanMcpBootstrap.cs'
  [System.IO.File]::WriteAllText($patched, $source, (New-Object System.Text.UTF8Encoding($true)))

  # EPLAN 脚本编译器的引用集，逐字抄自 EplanEplApiScriptLogu.erx 的字符串表。
  $frameworkRefs = @(
    'mscorlib.dll'
    'System.dll'
    'System.Core.dll'
    'System.Drawing.dll'
    'System.XML.dll'
    'System.Xml.Linq.dll'
    'System.Windows.Forms.dll'
    'System.IO.Compression.FileSystem.dll'
  ) | ForEach-Object {
    Join-Path $env:WINDIR ('Microsoft.NET\Framework64\v4.0.30319\' + $_)
  }
  $eplanRefs = @(
    'Eplan.EplApi.Baseu.dll'
    'Eplan.EplApi.AFu.dll'
    'Eplan.EplApi.Guiu.dll'
    'Eplan.EplApi.RecorderToolsu.dll'
    'Eplan.EplApi.EServicesu.dll'
  ) | ForEach-Object { Join-Path $eplanBin $_ }

  $args = New-Object System.Collections.ArrayList
  foreach ($a in @('-nologo', '-target:library', '-platform:x64', '-langversion:5')) { [void]$args.Add($a) }
  [void]$args.Add('-out:' + (Join-Path $tempDir 'bootstrap-check.dll'))
  foreach ($r in ($frameworkRefs + $eplanRefs)) {
    if (Test-Path -LiteralPath $r) { [void]$args.Add('-r:' + $r) }
    else { Write-Host "跳过（本机没有）: $r" -ForegroundColor DarkYellow }
  }
  [void]$args.Add($patched)

  Write-Host '用 EPLAN 脚本编译器的引用集编译引导脚本…'
  & $csc $args.ToArray()
  if ($LASTEXITCODE -ne 0) { throw "引导脚本编译失败（退出码 $LASTEXITCODE），EPLAN 里也会失败。" }
  Write-Host 'OK 引导脚本可通过 EPLAN 脚本编译器' -ForegroundColor Green
}
finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
