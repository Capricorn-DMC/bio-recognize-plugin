Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WtsLockProbe {
    [DllImport("wtsapi32.dll")]
    public static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytes);
    [DllImport("wtsapi32.dll")]
    public static extern void WTSFreeMemory(IntPtr pMemory);
    public static int GetLock() {
        IntPtr buf; int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 24, out buf, out bytes)) return -1; // 24 = WTSSessionInfoEx
        int f = Marshal.ReadInt32(buf, 12); // SessionFlags offset in WTSINFOEXW
        WTSFreeMemory(buf);
        return (f & 1) != 0 ? 1 : 0;
    }
}
"@
Write-Output ([WtsLockProbe]::GetLock())
