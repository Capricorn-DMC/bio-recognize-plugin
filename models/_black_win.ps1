# Persistent fullscreen black window.
# Started once by the backend, runs hidden, and polls models/_black_state.txt:
#   "1" -> show a borderless, always-on-top, pure-black window covering every
#          monitor (kills the residual backlight glow so no text is visible)
#   "0" -> hide it
# Deliberately avoids any display-power API: SC_MONITORPOWER locks the
# workstation on this machine. A plain topmost window cannot lock anything.
# Failsafe: exits by itself if the backend stops answering /health, so a
# crashed server can never leave the user staring at a black screen.

param([int]$BackendPort = 8765)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$stateFile = Join-Path $PSScriptRoot '_black_state.txt'
$healthUrl = 'http://127.0.0.1:' + $BackendPort + '/health'

# Build a fully transparent 32bpp cursor (.cur). XOR plane all zeros +
# AND mask all ones = nothing drawn. Assigning it as the form's Cursor hides
# the pointer while the black window is up WITHOUT touching the global
# ShowCursor counter — a killed process can therefore never leave the mouse
# invisible system-wide (the window disappears, the normal cursor returns).
# NOTE: a 1bpp cursor is rejected by System.Windows.Forms.Cursor ("invalid
# image format") and silently falls back to the default arrow — must be 32bpp.
function New-BlankCursorPath {
    $w = 32; $h = 32
    $xorLen = $w * $h * 4
    $andLen = ($w / 8) * $h
    $xor = New-Object byte[] $xorLen
    $and = New-Object byte[] $andLen
    for ($i = 0; $i -lt $andLen; $i++) { $and[$i] = 255 }   # 1 = keep screen
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt16]0); $bw.Write([UInt16]2); $bw.Write([UInt16]1)   # ICONDIR, type=2 (cursor)
    $bw.Write([byte]$w); $bw.Write([byte]$h); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]0); $bw.Write([UInt16]0)                          # hotspot 0,0
    $bw.Write([UInt32](40 + $xorLen + $andLen)); $bw.Write([UInt32]22)  # size, offset
    $bw.Write([UInt32]40); $bw.Write([Int32]$w); $bw.Write([Int32]($h * 2))
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)                         # planes, bpp
    $bw.Write([UInt32]0); $bw.Write([UInt32]($xorLen + $andLen))        # compression, sizeImage
    $bw.Write([Int32]0); $bw.Write([Int32]0); $bw.Write([UInt32]0); $bw.Write([UInt32]0)
    $bw.Write($xor); $bw.Write($and)
    $bw.Flush()
    $path = Join-Path $env:TEMP 'dsh_blank_cursor.cur'
    [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose()
    return $path
}

$blankCursor = $null
try { $blankCursor = New-Object System.Windows.Forms.Cursor((New-BlankCursorPath)) } catch { }
# Publish the handle so a probe can confirm the pointer really is our blank one
try {
    $hp = if ($blankCursor) { $blankCursor.Handle.ToInt64() } else { 0 }
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '_cursor_handle.txt'), [string]$hp)
} catch { }

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
$form.TopMost = $true
$form.ShowWithoutActivation = $true   # never steal focus from the app in use
$form.Cursor = if ($blankCursor) { $blankCursor } else { [System.Windows.Forms.Cursors]::Default }

$script:isShown = $false
$script:miss = 0
$ctx = New-Object System.Windows.Forms.ApplicationContext

# 120ms state poll -> show/hide latency ~0.1s
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 120
$poll.add_Tick({
    $want = '0'
    try { $want = ([System.IO.File]::ReadAllText($script:stateFile)).Trim() } catch { }
    if ($want -eq '1') {
        if (-not $script:isShown) {
            $form.Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
            $form.Show()
            $form.TopMost = $true
            # Force an immediate cursor redraw: the pointer image only refreshes
            # when it moves or the window beneath it changes, and the user is
            # typically away right now (no mouse motion). A 1px nudge-and-back
            # is not an input event, so it cannot wake/reset anything.
            try {
                $p = [System.Windows.Forms.Cursor]::Position
                [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($p.X + 1), $p.Y)
                [System.Windows.Forms.Cursor]::Position = $p
            } catch { }
            $script:isShown = $true
        }
    } elseif ($script:isShown) {
        $form.Hide()
        $script:isShown = $false
    }
})
$poll.Start()

# Watchdog: backend gone => leave the desktop usable again.
# This is the last line of defence for an ABRUPT death (crash, Task Manager,
# kill without a shutdown handler): the backend may have left the panel at
# brightness 0, so restore the level it recorded before blanking and hide the
# window before exiting.
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 2000
$watch.add_Tick({
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1
        if ($r.StatusCode -eq 200) { $script:miss = 0 } else { $script:miss++ }
    } catch { $script:miss++ }
    if ($script:miss -ge 3) {
        $script:miss = 0
        $poll.Stop()
        $watch.Stop()
        try {
            if ($script:isShown) { $form.Hide(); $script:isShown = $false }
        } catch { }
        try {
            $lvl = 70
            $lvlFile = Join-Path $PSScriptRoot '_black_level.txt'
            if (Test-Path $lvlFile) {
                $parsed = 0
                if ([int]::TryParse((Get-Content $lvlFile -Raw).Trim(), [ref]$parsed) -and $parsed -ge 5) { $lvl = $parsed }
            }
            Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop |
                ForEach-Object { $_ | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]$lvl } | Out-Null }
        } catch { }
        $ctx.ExitThread()
    }
})
$watch.Start()

[System.Windows.Forms.Application]::Run($ctx)
