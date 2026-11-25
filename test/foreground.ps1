# Print the current foreground window (pid + title) as one line of JSON.
# Used by test/smoke-all.mjs to prove that EPLAN does not steal focus.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
}
"@

$handle = [FgWin]::GetForegroundWindow()
$buffer = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowTextW($handle, $buffer, 512)
$procId = 0
[void][FgWin]::GetWindowThreadProcessId($handle, [ref]$procId)

@{ pid = $procId; title = $buffer.ToString() } | ConvertTo-Json -Compress
