# 生成装进 EPLAN 的引导脚本（把 HostDir 换成真实路径）。
#
# 两个"带版本号"的原因，都是 EPLAN 的缓存行为逼出来的：
#   1. 宿主 DLL 用 EplanMcpHost-<ticks>.dll。EPLAN 加载后锁住文件，覆盖会报 CS0016；
#      每次构建产生新文件名，引导脚本挑最新的，实现热重载。
#   2. 引导脚本本身也用 EplanMcpBootstrap-<ticks>.cs。RegisterScript 对**同一个路径**
#      会复用已编译的程序集，改了源码也不重新编译；换个文件名才强制重编译。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File native\script\prepare-install.ps1
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$source  = Join-Path $PSScriptRoot 'EplanMcpBootstrap.cs'
$hostDir = Join-Path $root 'host\bin'
$stamp   = [DateTime]::UtcNow.Ticks
$target  = Join-Path $PSScriptRoot "EplanMcpBootstrap-$stamp.cs"

if (-not (Test-Path -LiteralPath $hostDir)) {
  throw "宿主还没编译：$hostDir。先运行 native\host\build.ps1"
}

$latest = Get-ChildItem -LiteralPath $hostDir -Filter 'EplanMcpHost-*.dll' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $latest) {
  throw "宿主还没编译：$hostDir 里没有 EplanMcpHost-*.dll。先运行 native\host\build.ps1"
}

$text = Get-Content -LiteralPath $source -Raw -Encoding UTF8
if ($text -notmatch '__HOST_DLL_DIR__') {
  Write-Host '警告：模板里没有 __HOST_DLL_DIR__ 占位符，可能已经生成过。' -ForegroundColor Yellow
}
$text = $text.Replace('__HOST_DLL_DIR__', $hostDir)

# EPLAN 的脚本编译器读 UTF-8，带 BOM 最稳。
[System.IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($true)))

# 不要删历史引导脚本。
#
# 这些文件可能已经被 EPLAN 的 RegisterScript 记住了路径；删掉之后 EPLAN 每次启动
# 都会记一条 S046001「未找到指定的脚本文件」，并自动弹出「系统消息」框。
# 那个框占住 EPLAN 主线程，桥接器会预先检查到它，于是所有调用都返回
# EPLAN_BLOCKED_BY_DIALOG —— 2026-11-20 实测：几个失效注册就能让整条链路看起来像卡死。
# 一个文件 9 KB，留着比删掉便宜。
$scripts = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'EplanMcpBootstrap-*.cs')
if ($scripts.Count -gt 6) {
  Write-Host "提示：已有 $($scripts.Count) 个历史引导脚本。EPLAN 里注册过的文件不要手动删；要清理先在 EPLAN 里取消注册。" -ForegroundColor DarkYellow
}

Write-Host "已生成: $(Split-Path -Leaf $target)" -ForegroundColor Green
Write-Host "将加载最新宿主: $($latest.Name)" -ForegroundColor Gray
Write-Host ''
Write-Host '下一步：用桥接器注册（推荐，不需要点鼠标）:' -ForegroundColor Cyan
$json = '{"id":"i","op":"install","args":{"script":"' + ($target -replace '\\','\\\\') + '"}}'
Write-Host "  native\bridge\bin\EplanBridge.exe --once '$json'"
Write-Host ''
Write-Host '注意：EPLAN 里「运行脚本」走的是 ExecuteScript，只执行 [Start]，**不注册** [DeclareAction]。' -ForegroundColor DarkGray
Write-Host '      要注册动作必须用 RegisterScript（桥接器的 install 操作就是干这个）。' -ForegroundColor DarkGray
