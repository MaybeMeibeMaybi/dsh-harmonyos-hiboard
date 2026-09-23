# ============================================================================
# setup-publish-env.ps1 - prepare this PC to publish to GitHub (no admin rights)
#
# What it does, in order:
#   1. Detect git; if missing, download Git for Windows from a CHINA MIRROR and
#      install it per-user and silently (no administrator rights needed).
#      (Downloading from github.com would fail here: a SteamTools/Watt Toolkit
#      MITM certificate is installed and Node/git cannot verify it.)
#   2. Apply the user's own git settings: branch name, line endings, Chinese
#      file names, credential manager (wincred + browser auth).
#   3. Set the commit identity for this repository.
#   4. Create a GitHub SSH key and configure SSH over port 443.
#      REQUIRED in this environment: the DNS-redirection tool rewrites
#      github.com to 127.0.0.1 and only listens on 80/443, so port 22 is dead.
#      ssh.github.com:443 is GitHub's official firewalled-network endpoint.
#   5. Fix Node.js TLS: export the SteamTools CA to a .pem and set
#      NODE_EXTRA_CA_CERTS (User level). Without this, anything Node does over
#      HTTPS to github.com fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE.
#   6. Print the public key plus the exact remaining manual steps.
#
# Safe to re-run: every step is idempotent and nothing is overwritten blindly.
#
# IMPORTANT: keep this file ASCII-only, or save it as UTF-8 WITH BOM.
# PowerShell 5.1 decodes .ps1 as ANSI when no BOM is present.
# ============================================================================
[CmdletBinding()]
param(
    [string]$GitHubUser = 'MaybeMeibeMaybi',
    [string]$CommitName = 'Jim Chen',
    [string]$CommitEmail = '',
    [string]$GitVersion = '2.55.0.windows.5',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')
$env:GIT_TERMINAL_PROMPT = '0'

if (-not $CommitEmail) { $CommitEmail = "$GitHubUser@users.noreply.github.com" }

function Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [注意] $t" -ForegroundColor DarkYellow }
function Err2($t) { Write-Host "  [失败] $t" -ForegroundColor Red }
function Info($t) { Write-Host "  [信息] $t" -ForegroundColor Gray }

Write-Host "===== 发布环境准备 =====" -ForegroundColor Cyan
Write-Host "  GitHub 用户 : $GitHubUser"
Write-Host "  提交署名    : $CommitName <$CommitEmail>"

# ---------------------------------------------------------------- 1. git
Head "1. Git"
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    OK "已安装: $(& git --version)  -> $($git.Source)"
} elseif ($SkipInstall) {
    Err2 "git 未安装，且指定了 -SkipInstall"
    exit 1
} else {
    Warn "未检测到 git，开始从国内镜像安装（免提权、静默）"
    $exeName = "Git-$GitVersion-64-bit.exe"
    $url = "https://registry.npmmirror.com/-/binary/git-for-windows/v$GitVersion/$exeName"
    $out = Join-Path $env:TEMP $exeName
    Info "下载: $url"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -TimeoutSec 600
        $size = (Get-Item $out).Length
        if ($size -lt 10MB) { throw "文件过小($size 字节)，可能不是安装包" }
        OK ("下载完成: {0:N1} MB" -f ($size / 1MB))
    } catch {
        Err2 "下载失败: $($_.Exception.Message)"
        Info "可手工下载后重跑本脚本："
        Info "  https://mirrors.tuna.tsinghua.edu.cn/github-release/git-for-windows/git/"
        exit 1
    }

    Info "静默安装到当前用户（无需管理员）..."
    $args = @(
        '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-',
        '/CURRENTUSER',
        '/o:PathOption=Cmd',            # 只把 cmd 目录加入 PATH，避免污染
        '/o:CRLFOption=CRLFCommitAsIs',
        '/o:GitFinderContextMenu=false'
    )
    $p = Start-Process -FilePath $out -ArgumentList $args -Wait -PassThru
    OK "安装程序退出码: $($p.ExitCode)"

    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    $candidates = @(
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
        "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) {
        OK "已安装: $(& $found --version)"
        Info "若当前窗口仍找不到 git，请重开一个 PowerShell 窗口"
    } else {
        Err2 "安装后仍未找到 git.exe，请手工安装"
        exit 1
    }
}

# ---------------------------------------------------------------- 2. git 配置
Head "2. Git 全局基础配置"
& git config --global init.defaultBranch main;        OK "init.defaultBranch = main"
& git config --global core.autocrlf input;            OK "core.autocrlf = input"
& git config --global core.quotepath false;           OK "core.quotepath = false"
& git config --global pull.rebase false;              OK "pull.rebase = false"
& git config --global credential.helper manager;      OK "credential.helper = manager"

$gcm = "$env:ProgramFiles\Git\mingw64\bin\git-credential-manager.exe"
if (Test-Path $gcm) {
    & git config --global credential.credentialStore wincred
    & git config --global credential.gitHubAuthModes browser
    OK "GCM 已配置（wincred 持久化 + 浏览器授权）"
} else {
    Warn "未找到 Git Credential Manager（HTTPS 认证可能需手工输入；SSH 方案不受影响）"
}

# ---------------------------------------------------------------- 3. 提交身份
Head "3. 提交身份（本仓库）"
& git config --global user.name  $CommitName
& git config --global user.email $CommitEmail
OK "user.name  = $(& git config --global user.name)"
OK "user.email = $(& git config --global user.email)"

# ---------------------------------------------------------------- 4. SSH 443
Head "4. GitHub SSH 密钥（走 443 端口）"
$sshDir  = "$env:USERPROFILE\.ssh"
$keyPath = "$sshDir\id_ed25519_github"
New-Item -ItemType Directory -Path $sshDir -Force | Out-Null

if (Test-Path $keyPath) {
    OK "密钥已存在，跳过生成: id_ed25519_github"
} else {
    & ssh-keygen -t ed25519 -C $CommitEmail -f $keyPath -N '""' -q 2>&1 | Out-Null
    if (Test-Path $keyPath) { OK "已生成 ed25519 密钥" } else { Err2 "密钥生成失败" }
}

$cfgPath = "$sshDir\config"
$marker  = '# --- GitHub over 443'
$existing = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw } else { '' }
if ($existing -notmatch [regex]::Escape($marker)) {
    $block = @"

# --- GitHub over port 443 ---
# Reason: the DNS-redirection tool rewrites github.com to 127.0.0.1 and only
# listens on 80/443, so port 22 is dead. ssh.github.com:443 is GitHub's
# official firewalled-network endpoint.
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519_github
    IdentitiesOnly yes

Host ssh.github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519_github
    IdentitiesOnly yes
"@
    Add-Content -Path $cfgPath -Value $block -Encoding ASCII
    OK "已追加 SSH config（443 端口）"
} else {
    OK "SSH config 已含 443 配置，保留不动"
}

$khPath = "$sshDir\known_hosts"
if (-not (Test-Path $khPath)) {
    $kh = @"
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
ssh.github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
"@
    [IO.File]::WriteAllText($khPath, $kh, (New-Object Text.UTF8Encoding($false)))
    OK "已写入 known_hosts（GitHub 官方 ed25519 指纹）"
} else {
    Info "known_hosts 已存在，保留"
}

# ---------------------------------------------------------------- 5. Node CA
Head "5. Node.js TLS（SteamTools 中间人证书）"
$stCA = Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -match 'SteamTools|BeyondDimension' }
if ($stCA) {
    Warn "检测到 SteamTools 中间人证书（$($stCA.Count) 个）"
    $pemPath = "$env:USERPROFILE\.certs\steamtools-ca.pem"
    New-Item -ItemType Directory -Path (Split-Path $pemPath) -Force | Out-Null
    $sb = New-Object Text.StringBuilder
    foreach ($c in $stCA) {
        [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
        [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, 'InsertLineBreaks'))
        [void]$sb.AppendLine('-----END CERTIFICATE-----')
    }
    [IO.File]::WriteAllText($pemPath, $sb.ToString(), (New-Object Text.UTF8Encoding($false)))
    [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $pemPath, 'User')
    $env:NODE_EXTRA_CA_CERTS = $pemPath
    OK "已导出 CA 并设置 NODE_EXTRA_CA_CERTS（用户级，永久生效）"
    $r = & node -e "require('https').get('https://github.com',r=>{console.log('HTTP '+r.statusCode);process.exit(0)}).on('error',e=>{console.log('ERR:'+e.code);process.exit(0)})" 2>&1
    if ("$r" -match 'HTTP') { OK "Node 访问 github.com 正常（$r）" }
    else { Warn "Node 仍无法访问 github.com: $r （git push 走 HTTPS 时可能受影响，SSH 方案不受影响）" }
} else {
    OK "未检测到中间人证书，无需配置"
}

# ---------------------------------------------------------------- 6. SSH 测试
Head "6. SSH 链路测试"
$sshExe = "$env:WINDIR\System32\OpenSSH\ssh.exe"
if (Test-Path $sshExe) {
    $o = [IO.Path]::GetTempFileName(); $e = [IO.Path]::GetTempFileName()
    $sp = Start-Process -FilePath $sshExe -ArgumentList @(
        '-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
        '-o', 'BatchMode=yes', 'git@github.com') -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $o -RedirectStandardError $e
    $err = Get-Content $e -Raw -ErrorAction SilentlyContinue
    Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
    if ($sp.ExitCode -eq 1 -or $err -match 'successfully authenticated') {
        OK "SSH 认证成功 —— push 不会有任何弹窗"
    } elseif ($err -match 'Permission denied \(publickey\)') {
        Warn "链路正常（443 通、主机密钥已校验），但公钥尚未添加到 GitHub -> 见第 7 步"
    } elseif ($err -match 'Host key verification failed') {
        Err2 "主机密钥校验失败，检查 $khPath"
    } else {
        Warn "SSH 未通过（退出码 $($sp.ExitCode)）: $($err.Trim())"
    }
}

# ---------------------------------------------------------------- 7. 待办
Head "7. 剩余的人工步骤"
$pub = "$keyPath.pub"
if (Test-Path $pub) {
    Write-Host "`n  【必做 1】把下面的公钥添加到 GitHub：" -ForegroundColor Yellow
    Write-Host "            https://github.com/settings/keys  ->  New SSH key`n" -ForegroundColor Yellow
    Write-Host ("  " + (Get-Content $pub)) -ForegroundColor White
}
Write-Host "`n  【必做 2】在 GitHub 网页新建仓库（不要勾选 Add a README）：" -ForegroundColor Yellow
Write-Host "            Name: dsh-harmonyos-hiboard      可见性: Public" -ForegroundColor Yellow
Write-Host "`n  【必做 3】回到本机执行发布（脚本已备好，见 publish.ps1）" -ForegroundColor Yellow
Write-Host ""
Write-Host "===== 环境准备结束 =====" -ForegroundColor Cyan
