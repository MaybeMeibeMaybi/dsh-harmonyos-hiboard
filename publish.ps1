# ============================================================================
# publish.ps1 - init the repo, commit, and push to GitHub.
#
# Prerequisites: run setup-publish-env.ps1 first, add the SSH public key to
# GitHub, and create the empty repository on github.com.
#
# Usage:
#   powershell -File .\publish.ps1 -DryRun     # preview: init + stage + commit only
#   powershell -File .\publish.ps1             # real: also add remote and push
#
# ASCII-only on purpose (PowerShell 5.1 reads .ps1 as ANSI without a BOM).
# ============================================================================
[CmdletBinding()]
param(
    [string]$GitHubUser = 'MaybeMeibeMaybi',
    [string]$RepoName = 'dsh-harmonyos-hiboard',
    [string]$CommitMessage = 'feat: HarmonyOS assistant-today card push for DeepSeek Harness (dsh 0.1.5 / cordis 4 compatible)',
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [warn] $t" -ForegroundColor DarkYellow }
function Err2($t) { Write-Host "  [fail] $t" -ForegroundColor Red }

$remote = "git@github.com:$GitHubUser/$RepoName.git"

Head "0. Preconditions"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Err2 "git not found. Run setup-publish-env.ps1 first."
    exit 1
}
OK "git: $(& git --version)"
OK "working dir: $here"
if (-not (Test-Path "$here\README.md")) { Err2 "README.md missing - wrong directory?"; exit 1 }
if (-not (Test-Path "$here\LICENSE"))  { Err2 "LICENSE missing"; exit 1 }
if (-not (Test-Path "$here\NOTICE"))   { Err2 "NOTICE missing"; exit 1 }

# Guard: the real auth code must never be committed.
# The needles are assembled at run time from fragments, so this script does not
# itself contain the literal credentials it is searching for.
Head "1. Secret scan (must be clean)"
$needles = @(
    ('eh5Q6' + 'HVUFCDU'),
    ('2f655bdf' + 'c62e92ade')
)
$hits = @()
Get-ChildItem $here -Recurse -File -Force |
    Where-Object { $_.FullName -notmatch '\\\.git\\' } |
    ForEach-Object {
        $t = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
        foreach ($n in $needles) { if ($t -match [regex]::Escape($n)) { $hits += "$($_.Name): $n" } }
    }
if ($hits.Count -gt 0) {
    Err2 "real credentials found - aborting:"
    $hits | ForEach-Object { Write-Host "      $_" }
    exit 1
}
OK "no real credentials in any file"

Head "2. git init"
if (Test-Path "$here\.git") {
    OK "repository already initialised"
} else {
    & git init -b main 2>&1 | Out-Null
    if (Test-Path "$here\.git") { OK "initialised on branch main" } else { Err2 "git init failed"; exit 1 }
}

Head "3. Stage and commit"
& git add -A
$staged = (& git diff --cached --name-only) -join ', '
if (-not $staged) {
    Warn "nothing staged (already committed?)"
} else {
    OK "staged: $staged"
    & git -c user.name='Jim Chen' commit -m $CommitMessage 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "      $_" }
    $last = & git log -1 --pretty=format:'%h %an <%ae> %s' 2>$null
    OK "commit: $last"
}

if ($DryRun) {
    Head "Dry run complete"
    Write-Host "  Nothing was pushed. Re-run without -DryRun to publish." -ForegroundColor Yellow
    Write-Host "  Remote that will be used: $remote" -ForegroundColor Yellow
    exit 0
}

Head "4. Remote"
$existingRemote = & git remote get-url origin 2>$null
if ($existingRemote) {
    OK "origin already set: $existingRemote"
    if ($existingRemote -ne $remote) { Warn "expected: $remote" }
} else {
    & git remote add origin $remote
    OK "origin -> $remote"
}

Head "5. Push"
& git push -u origin main 2>&1 | ForEach-Object { Write-Host "      $_" }
if ($LASTEXITCODE -eq 0) {
    OK "pushed. Repository: https://github.com/$GitHubUser/$RepoName"
    Write-Host ""
    Write-Host "  Next: add topics and description in the repo settings, or run:" -ForegroundColor Cyan
    Write-Host "    gh repo edit --add-topic harmonyos-next,harmonyos,hiboard,deepseek-harness,dsh,dsh-plugin,negative-one-screen,assistant-today,service-card" -ForegroundColor Gray
} else {
    Err2 "push failed (exit $LASTEXITCODE). Common causes:"
    Write-Host "      - the repository does not exist yet -> create it on github.com (no README)" -ForegroundColor Gray
    Write-Host "      - the SSH public key is not added -> https://github.com/settings/keys" -ForegroundColor Gray
    Write-Host "      - port 22 blocked -> setup-publish-env.ps1 configures ssh.github.com:443" -ForegroundColor Gray
    exit $LASTEXITCODE
}
