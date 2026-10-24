# pi-foreman: `ledger` for Pi's powershell tool (Pi starts it with -ExecutionPolicy Bypass).
# Same binding as bin/ledger: PI_SESSION_ID -> CLAUDE_CODE_SESSION_ID, PI_FOREMAN_STATE_DIR -> TMPDIR.
$script = Join-Path $PSScriptRoot '..\core\scripts\ledger.py'
$py = $env:PI_FOREMAN_PYTHON
$pre = @()
if (-not $py) {
    $found = 'none'
    foreach ($cand in @(@{ Name = 'py'; Pre = @('-3') }, @{ Name = 'python'; Pre = @() })) {
        if (-not (Get-Command $cand.Name -ErrorAction SilentlyContinue)) { continue }
        $ver = & $cand.Name @($cand.Pre) -c 'import sys; print(sys.version.split()[0])' 2>$null
        if ($found -eq 'none') { $found = "$($cand.Name) $ver" }
        & $cand.Name @($cand.Pre) -c 'import sys; sys.exit(sys.version_info < (3, 13))' 2>$null
        if ($LASTEXITCODE -eq 0) { $py = $cand.Name; $pre = $cand.Pre; break }
    }
    if (-not $py) {
        [Console]::Error.WriteLine("pi-foreman needs Python 3.13+; found $found. Set PI_FOREMAN_PYTHON or install Python 3.13 (macOS: brew install python@3.13).")
        exit 2
    }
}
$oldSid = $env:CLAUDE_CODE_SESSION_ID
$oldTmp = $env:TMPDIR
try {
    $env:CLAUDE_CODE_SESSION_ID = $env:PI_SESSION_ID
    if ($env:PI_FOREMAN_STATE_DIR) { $env:TMPDIR = $env:PI_FOREMAN_STATE_DIR }
    & $py @pre -E -s $script @args
    $code = $LASTEXITCODE
} finally {
    $env:CLAUDE_CODE_SESSION_ID = $oldSid
    $env:TMPDIR = $oldTmp
}
exit $code
