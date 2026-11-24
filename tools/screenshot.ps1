# 截屏：整屏原生分辨率（2560x1600），不做任何缩放。
#
# 关键点：进程必须先声明 DPI 感知。否则 Windows 会让 CopyFromScreen 拿到
# 「逻辑像素」——在 150% 缩放的机器上截出来是 1707x1067 之类的缩水图，
# 细节全糊。声明 PerMonitorV2 之后拿到的就是真实的 2560x1600。
#
# 用法:
#   powershell -File tools\screenshot.ps1
#   powershell -File tools\screenshot.ps1 -Out D:\x\shot.png
#   powershell -File tools\screenshot.ps1 -Window    # 只截 EPLAN 窗口（坐标仍是物理像素）
param(
  [string]$Out = 'D:\静静\临时文件\eplan_shot.png',
  [switch]$Window
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$code = @'
using System;
using System.Runtime.InteropServices;

public class ShotNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
    public static bool MakeDpiAware()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true;
        }
        catch { }
        try { return SetProcessDPIAware(); }
        catch { return false; }
    }
}
'@

Add-Type -TypeDefinition $code

$aware = [ShotNative]::MakeDpiAware()
Write-Host ("DPI aware: " + $aware) -ForegroundColor DarkGray

# 物理屏幕尺寸（声明 DPI 感知后 SM_CXSCREEN 就是真实像素）。
$screenW = [ShotNative]::GetSystemMetrics(0)
$screenH = [ShotNative]::GetSystemMetrics(1)

$left = 0
$top = 0
$width = $screenW
$height = $screenH

if ($Window) {
  $proc = Get-Process -Name Eplan -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proc) { throw 'EPLAN is not running' }
  $hwnd = $proc.MainWindowHandle
  if ($hwnd -eq [IntPtr]::Zero) { throw 'cannot get EPLAN main window handle' }

  # 提到前台，截到的就是用户正看着的画面。
  [void][ShotNative]::ShowWindow($hwnd, 9)
  [void][ShotNative]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 800

  $rect = New-Object ShotNative+RECT
  [void][ShotNative]::GetWindowRect($hwnd, [ref]$rect)
  $left = $rect.Left
  $top = $rect.Top
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw "bad window size: $width x $height" }
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
$graphics.Dispose()

$dir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "screenshot: $Out ($width x $height)" -ForegroundColor Green
