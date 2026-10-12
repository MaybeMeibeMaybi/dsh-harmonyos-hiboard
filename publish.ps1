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
# The pre-publish credential scan reads the real secret values from a local,
# git-ignored JSON file (default .\privacy-secrets.local.json). No secret is
# stored in this script - a credential written here would be published with the
# repository, and splitting it into fragments does not help (the fragments
# concatenate straight back to the secret, and an exact-match scan cannot see
# them either).
#
# ASCII-only on purpose (PowerShell 5.1 reads .ps1 as ANSI without a BOM).
# ============================================================================
[CmdletBinding()]
param(
    [string]$GitHubUser = 'MaybeMeibeMaybi',
    [string]$RepoName = 'dsh-harmonyos-hiboard',
    [string]$CommitMessage = 'feat: HarmonyOS assistant-today card push for DeepSeek Harness (dsh 0.1.5 / cordis 4 compatible)',
    # Local file holding the real credential values to grep for. Keep it out of
    # git (the repository .gitignore covers it); an out-of-repo path works too.
    # Left empty by default: resolved below, because $PSScriptRoot is NOT
    # populated yet while param() defaults are evaluated (PowerShell 5.1).
    [string]$SecretsPath = '',
    # Publish without running the credential scan. Use only if you know why.
    [switch]$SkipSecretScan,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
if (-not $SecretsPath) { $SecretsPath = Join-Path $here 'privacy-secrets.local.json' }

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

# Guard: the real credentials must never be committed / published.
#
# Which keys of the secrets file count as credentials. Attribution values
# (userName / email / sshAlias) are deliberately excluded: they appear in
# LICENSE / NOTICE / docs by design and would otherwise block every publish.
$CredentialKeys = @('authCode', 'gatewayPassword', 'registerKey', 'tokens', 'publicIps', 'tailnetIp', 'lanIp', 'hostname')

Head "1. Secret scan (must be clean)"
if ($SkipSecretScan) {
    Warn "credential scan SKIPPED (-SkipSecretScan)"
} else {
    if (-not (Test-Path -LiteralPath $SecretsPath)) {
        Err2 "secrets file not found: $SecretsPath"
        Write-Host "      Create it (never commit it), pass -SecretsPath, or use -SkipSecretScan." -ForegroundColor Gray
        Write-Host "      Example content: { `"authCode`": `"<your auth code>`" }" -ForegroundColor Gray
        exit 1
    }
    $secrets = $null
    try { $secrets = Get-Content -LiteralPath $SecretsPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Err2 "secrets file is not valid JSON: $SecretsPath"; exit 1 }

    $needles = @()
    foreach ($prop in $secrets.PSObject.Properties) {
        if ($CredentialKeys -notcontains $prop.Name) { continue }
        $values = @()
        if ($prop.Value -is [string]) { $values = @($prop.Value) }
        elseif ($prop.Value -is [System.Array]) { $values = @($prop.Value) }
        foreach ($v in $values) {
            $s = ([string]$v).Trim()
            if ($s.Length -ge 8) { $needles += , @($prop.Name, $s) }
        }
    }
    if ($needles.Count -eq 0) {
        Err2 "no usable credential values in $SecretsPath (expected keys: $($CredentialKeys -join ', '))"
        exit 1
    }

    $secretsFull = [IO.Path]::GetFullPath($SecretsPath)
    $hits = @()
    Get-ChildItem $here -Recurse -File -Force |
        Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.FullName -ne $secretsFull } |
        ForEach-Object {
            $rel = $_.FullName.Substring($here.Length).TrimStart('\')
            $lines = [IO.File]::ReadAllLines($_.FullName, [Text.Encoding]::UTF8)
            for ($i = 0; $i -lt $lines.Length; $i++) {
                foreach ($n in $needles) {
                    if ($lines[$i].Contains($n[1])) { $hits += ('{0}:{1}  [{2}]' -f $rel, ($i + 1), $n[0]) }
                }
            }
        }
    if ($hits.Count -gt 0) {
        Err2 "real credentials found - aborting (matched values are NOT printed):"
        $hits | ForEach-Object { Write-Host "      $_" }
        exit 1
    }
    OK "no real credentials in any file ($($needles.Count) credential value(s) checked)"
}

Head "2. git init"
if (Test-Path "$here\.git") {
    OK "repository already initialised"
} else {
    & git init -b main 2>&1 | Out-Null
    if (Test-Path "$here\.git") { OK "initialised on branch main" } else { Err2 "git init failed"; exit 1 }
}

Head "2b. Secrets file must not be committable"
if (-not (Test-Path -LiteralPath $SecretsPath)) {
    Warn "no secrets file at $SecretsPath - nothing to protect"
} elseif (-not ([IO.Path]::GetFullPath($SecretsPath)).StartsWith($here + '\', [StringComparison]::OrdinalIgnoreCase)) {
    OK "secrets file lives outside the repository"
} else {
    & git check-ignore -q -- $SecretsPath 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        OK "secrets file is git-ignored: $SecretsPath"
    } else {
        Err2 "secrets file is inside the repo but NOT git-ignored: $SecretsPath"
        Write-Host "      Add it to .gitignore before publishing." -ForegroundColor Gray
        exit 1
    }
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
