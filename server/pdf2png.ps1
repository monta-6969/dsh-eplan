# 用 Windows 自带的 PDF 引擎把某一页渲染成 PNG。
#
# 为什么不用 pdfjs + canvas：pdfjs v4 调 clip() 的方式和 @napi-rs/canvas 不兼容，
# 而且 node-canvas 在全新机器上要搭编译环境，和「可迁移」的目标冲突。
# Windows 10/11 自带 Windows.Data.Pdf，零依赖，渲染质量也更好。
#
# 用法：
#   powershell -File pdf2png.ps1 -Pdf "C:\a.pdf" -OutDir "C:\out" -From 1 -To 3 -Scale 2
param(
    [Parameter(Mandatory = $true)][string]$Pdf,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$From = 1,
    [int]$To = 0,
    [double]$Scale = 2.0
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Pdf)) {
    Write-Output "ERROR|PDF_NOT_FOUND|找不到文件：$Pdf"
    exit 2
}
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

try {
    # System.Runtime.WindowsRuntime 提供 AsTask 桥接，不显式加载的话
    # [System.WindowsRuntimeSystemExtensions] 会报 TypeNotFound。
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
} catch {
    Write-Output "ERROR|PDF_RUNTIME|这台机器没有 Windows.Data.Pdf，需要 Windows 10 及以上。$($_.Exception.Message)"
    exit 3
}

# WinRT 的异步调用在 PowerShell 里要用 AsTask 包一层才能同步等。
function Await($task, $resultType) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $netTask = $asTask.MakeGenericMethod($resultType).Invoke($null, @($task))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

$full = (Resolve-Path -LiteralPath $Pdf).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])

$count = [int]$doc.PageCount
if ($To -le 0 -or $To -gt $count) { $To = $count }
if ($From -lt 1) { $From = 1 }

$base = [System.IO.Path]::GetFileNameWithoutExtension($full)
$results = @()

for ($i = $From; $i -le $To; $i++) {
    $page = $doc.GetPage([uint32]($i - 1))

    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]([math]::Round($page.Size.Width * $Scale))
    # 透明背景会让线条在深色查看器里消失，先定死白底。
    $opts.BackgroundColor = [Windows.UI.Color]::FromArgb(255, 255, 255, 255)

    $name = '{0}-p{1}.png' -f $base, ([string]$i).PadLeft(3, '0')
    $target = Join-Path $OutDir $name

    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }

    $storageFolder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($OutDir)) ([Windows.Storage.StorageFolder])
    $outFile = Await ($storageFolder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
    $stream = Await ($outFile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])

    # IAsyncAction 是 COM 对象，不能直接 .AsTask()；PowerShell 也选不出
    # AsTask 的哪个重载，所以要按参数类型反射挑。
    $task = $page.RenderToStreamAsync($stream, $opts)
    $asTask = $script:AsTaskAction
    if ($null -eq $asTask) {
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
        } | Select-Object -First 1
        $script:AsTaskAction = $asTask
    }
    if ($null -eq $asTask) { throw '找不到 AsTask(IAsyncAction) 重载' }
    $netAction = $asTask.Invoke($null, @($task))
    $netAction.Wait(-1) | Out-Null
    $stream.Dispose()

    $results += ('{0}|{1}|{2}' -f $i, $target, [int]([math]::Round($page.Size.Width * $Scale)))
    $page.Dispose()
}

Write-Output ("PAGES|" + $count)
foreach ($line in $results) { Write-Output ("PAGE|" + $line) }
