# pi-foreman: `foreman setup|update-check|retro|sync|session|radar|config|bench|backlog|findings|close|worktree|dialogs|features|perms|knowledge [args]` for PowerShell.
$sub = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
if ($sub -eq 'setup') {
    & node (Join-Path $PSScriptRoot '..\setup.mjs') @rest
    $rc = $LASTEXITCODE
    if ($rc -eq 0) {
        & node --no-warnings --experimental-strip-types (Join-Path $PSScriptRoot '..\scripts\foreman_review_warn.mjs') @rest 2>$null
    }
    exit $rc
}
if ($sub -eq 'features') {
    & node (Join-Path $PSScriptRoot '..\scripts\foreman_features.mjs') @rest
    exit $LASTEXITCODE
}
if ($sub -eq 'perms') {
    & node (Join-Path $PSScriptRoot '..\scripts\foreman_perms.mjs') @rest
    exit $LASTEXITCODE
}
if ($sub -eq 'knowledge') {
    & node (Join-Path $PSScriptRoot '..\scripts\foreman_knowledge.mjs') @rest
    exit $LASTEXITCODE
}
if ($sub -eq 'dialogs') {
    & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)" 2>$null
    if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('foreman dialogs needs Node >= 22.6 (--experimental-strip-types)'); exit 1 }
    & node --no-warnings --experimental-strip-types (Join-Path $PSScriptRoot '..\extensions\core-adapter\dialogs-cli.ts') @rest
    exit $LASTEXITCODE
}
switch ($sub) {
    'update-check' { $name = 'foreman_update_check.py' }
    'retro' { $name = 'foreman_retro.py' }
    'sync' { $name = 'foreman_sync.py' }
    'session' { $name = 'foreman_session.py' }
    'radar' { $name = 'foreman_radar.py' }
    'config' { $name = 'foreman_config.py' }
    'bench' { $name = 'foreman_bench.py' }
    'backlog' { $name = 'foreman_backlog.py' }
    'findings' { $name = 'foreman_findings.py' }
    'close' { $name = 'foreman_close.py' }
    'worktree' { $name = 'foreman_worktree.py' }
    default { [Console]::Error.WriteLine('usage: foreman setup|update-check|retro|sync|session|radar|config|bench|backlog|findings|close|worktree|dialogs|features|perms|knowledge [args]'); exit 2 }
}
$script = Join-Path $PSScriptRoot "..\scripts\$name"
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
& $py @pre -E -s $script @rest
$rc = $LASTEXITCODE
if ($sub -eq 'update-check') {
    # update-check keeps its exit code; the knowledge nudge goes to stderr so --json stays clean (best effort)
    try { & node (Join-Path $PSScriptRoot '..\scripts\foreman_knowledge.mjs') nudge 2>$null | ForEach-Object { [Console]::Error.WriteLine($_) } } catch { }
}
exit $rc
