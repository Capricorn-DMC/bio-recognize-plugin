Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct CURSORINFO {
    public int cbSize;
    public int flags;       // 1 = CURSOR_SHOWING, 0 = hidden
    public IntPtr hCursor;
    public int ptX;
    public int ptY;
}
public class CurProbe {
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
    public static string Probe() {
        CURSORINFO ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref ci)) return "FAIL";
        return ((ci.flags & 1) != 0 ? "SHOWING" : "HIDDEN") + " h=" + ci.hCursor.ToInt64();
    }
}
"@
Write-Output ([CurProbe]::Probe())
