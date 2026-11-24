# 用 Win32 消息关掉 EPLAN 的模态对话框。
#
# 为什么不用 UIAutomation：实测 EPLAN 的模态框是原生 Win32 对话框（class #32770），
# UIAutomation 在进程外只看到 MDI 主框架，找不到里面的按钮。
# 直接 EnumWindows / EnumChildWindows 枚举、按文字找按钮、发 BM_CLICK 最稳。
param(
  [string]$ButtonText = '',
  [switch]$Escape,
  [string]$LogPath = 'D:\静静\临时文件\dismiss_dialog.log'
)

$signature = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class DlgWin
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder buf, int max);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowEnabled(IntPtr hWnd);

    public const uint BM_CLICK = 0x00F5;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;

    public static List<IntPtr> WindowsOfProcess(uint targetPid)
    {
        List<IntPtr> result = new List<IntPtr>();
        EnumProc cb = delegate(IntPtr h, IntPtr p)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == targetPid) result.Add(h);
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return result;
    }

    public static List<IntPtr> Children(IntPtr parent)
    {
        List<IntPtr> result = new List<IntPtr>();
        EnumProc cb = delegate(IntPtr h, IntPtr p) { result.Add(h); return true; };
        EnumChildWindows(parent, cb, IntPtr.Zero);
        return result;
    }

    public static string Text(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string Class(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $signature

$lines = New-Object System.Collections.ArrayList
function Log([string]$m) { [void]$lines.Add($m); Write-Host $m }

$proc = Get-Process -Name Eplan -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Log 'EPLAN_NOT_RUNNING'; exit 1 }

$wins = [DlgWin]::WindowsOfProcess([uint32]$proc.Id)
Log ("windows: " + $wins.Count)

foreach ($h in $wins) {
  $cls = [DlgWin]::Class($h)
  $txt = [DlgWin]::Text($h)
  Log ("top hwnd=" + $h + " class=" + $cls + " enabled=" + [DlgWin]::IsWindowEnabled($h) + " text='" + $txt + "'")
  $kids = [DlgWin]::Children($h)
  foreach ($k in $kids) {
    $kcls = [DlgWin]::Class($k)
    if ($kcls -ne 'Button') { continue }
    Log ("   button hwnd=" + $k + " text='" + [DlgWin]::Text($k) + "'")
  }
}

$clicked = $false
if ($ButtonText.Length -gt 0) {
  foreach ($h in $wins) {
    if ($clicked) { break }
    foreach ($k in [DlgWin]::Children($h)) {
      if ($clicked) { break }
      if ([DlgWin]::Class($k) -ne 'Button') { continue }
      if ([DlgWin]::Text($k) -ne $ButtonText) { continue }
      [void][DlgWin]::SendMessageW($k, [DlgWin]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
      Log ("CLICKED hwnd=" + $k + " text='" + $ButtonText + "'")
      $clicked = $true
    }
  }
}

if (-not $clicked -and $Escape) {
  foreach ($h in $wins) {
    if (-not [DlgWin]::IsWindowEnabled($h)) { continue }
    [void][DlgWin]::PostMessageW($h, [DlgWin]::WM_KEYDOWN, [IntPtr]0x1B, [IntPtr]::Zero)
    [void][DlgWin]::PostMessageW($h, [DlgWin]::WM_KEYUP, [IntPtr]0x1B, [IntPtr]::Zero)
    Log ("ESC sent to hwnd=" + $h)
    $clicked = $true
    break
  }
}

if (-not $clicked) { Log 'NOTHING_CLICKED' }

$dir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$lines -join "`r`n" | Set-Content -LiteralPath $LogPath -Encoding UTF8
