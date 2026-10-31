<#
.SYNOPSIS
    发布 dsh-sakurafrp：把 develop 整包合并到 master，打 tag，建 GitHub Release。

.DESCRIPTION
    遵守 main/develop 双分支流：
      - 日常小改动只提交并推送到 develop
      - 攒够一批后跑本脚本，在 master 上产生一个 --no-ff 合并点 + tag + Release

    脚本会依次做：
      1. 环境自检（仓库根、分支、工作区、与远端同步、tag 是否已存在）
      2. 跑 npm test（除非 -SkipTests）
      3. 改 package.json 版本号并提交到 develop
      4. 推送 develop
      5. 切 master，--no-ff 合并 develop
      6. 打 annotated tag vX.Y.Z
      7. 推送 master 与 tag
      8. npm pack 出 tgz，改名后作为 Release 资产上传
      9. 切回 develop

.PARAMETER Bump
    版本递增方式：patch / minor / major。与 -Version 二选一。

.PARAMETER Version
    显式指定版本号，如 2.3.0。与 -Bump 二选一。

.PARAMETER Notes
    Release 说明正文。不传则依次尝试：docs/release-notes/vX.Y.Z.md、gh 自动生成。

.PARAMETER SkipTests
    跳过 npm test。

.PARAMETER NoPush
    只做本地合并、打 tag、打包，不推送也不建 Release。用于演练。

.PARAMETER DryRun
    只做自检并打印将要做的事，然后退出，不改任何东西。

.EXAMPLE
    ./scripts/release.ps1 -Bump patch

.EXAMPLE
    ./scripts/release.ps1 -Version 2.3.0 -Notes "## 新增`n`n- 隧道列表支持搜索"

.EXAMPLE
    ./scripts/release.ps1 -Bump minor -DryRun
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump,

    [string]$Version,

    [string]$Notes,

    [switch]$SkipTests,

    [switch]$NoPush,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 输出helper

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Green
}

function Write-Info([string]$Text) {
    Write-Host "    $Text" -ForegroundColor DarkGray
}

function Write-Warn2([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Yellow
}

function Fail([string]$Text) {
    Write-Host ''
    Write-Host "中止：$Text" -ForegroundColor Red
    exit 1
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $out = & git @GitArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail "git $($GitArgs -join ' ') 失败：`n$out"
    }
    return $out
}

# ---------------------------------------------------------------- 0. 定位仓库

$repoRoot = & git rev-parse --show-toplevel 2>$null
if (-not $repoRoot) { Fail '当前目录不是 git 仓库。' }
Set-Location $repoRoot
Write-Info "仓库：$repoRoot"

$pkgPath = Join-Path $repoRoot 'package.json'
if (-not (Test-Path $pkgPath)) { Fail '找不到 package.json。' }
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentVersion = $pkg.version

# ---------------------------------------------------------------- 1. 环境自检

Write-Step '环境自检'

if ($Bump -and $Version) { Fail '-Bump 与 -Version 只能给一个。' }
if (-not $Bump -and -not $Version) { Fail '必须给 -Bump 或 -Version。' }

# 分支：必须在 develop
$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'develop') {
    Fail "当前在 '$branch' 分支。发布只从 develop 发起，请先 `git switch develop`。"
}
Write-Ok "当前分支：develop"

# 工作区干净
$dirty = & git status --porcelain
if ($dirty) {
    Write-Warn2 '工作区有未提交改动：'
    $dirty | ForEach-Object { Write-Info $_ }
    Fail '请先提交或 stash 干净后再发布。'
}
Write-Ok '工作区干净'

# 与远端同步（无远端时跳过）
$hasRemote = (& git remote) -contains 'origin'
if ($hasRemote) {
    & git fetch origin --tags --quiet 2>&1 | Out-Null
    $local = (& git rev-parse develop).Trim()
    $remote = (& git rev-parse origin/develop 2>$null)
    if ($remote -and $local -ne $remote.Trim()) {
        Fail "develop 与 origin/develop 不同步，请先 `git pull --rebase` 或 `git push`。"
    }
    Write-Ok 'develop 与远端同步'
} else {
    Write-Warn2 '没有 origin 远端，跳过同步检查'
}

# 计算目标版本
function Get-NextVersion([string]$Cur, [string]$Kind, [string]$Explicit) {
    if ($Explicit) {
        if ($Explicit -notmatch '^\d+\.\d+\.\d+$') { Fail "版本号 '$Explicit' 不是 x.y.z 形式。" }
        return $Explicit
    }
    if ($Cur -notmatch '^(\d+)\.(\d+)\.(\d+)$') { Fail "package.json 当前版本 '$Cur' 不是 x.y.z 形式。" }
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]; $pat = [int]$Matches[3]
    switch ($Kind) {
        'major' { $maj++; $min = 0; $pat = 0 }
        'minor' { $min++; $pat = 0 }
        'patch' { $pat++ }
    }
    return "$maj.$min.$pat"
}

$targetVersion = Get-NextVersion -Cur $currentVersion -Kind $Bump -Explicit $Version
$tagName = "v$targetVersion"
Write-Ok "版本：$currentVersion -> $targetVersion  (tag $tagName)"

# tag 已存在？
$existingTag = & git tag --list $tagName
if ($existingTag) { Fail "tag $tagName 已存在，换个版本号。" }
Write-Ok "tag $tagName 可用"

# 依赖工具
$needGh = -not $NoPush
if ($needGh) {
    $ghCmd = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $ghCmd) { Fail '找不到 gh CLI（建 Release 需要）。想只做本地发布可用 -NoPush。' }
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'gh 未登录，先 `gh auth login`。' }
    Write-Ok 'gh 已登录'
}

# ---------------------------------------------------------------- DryRun 出口

if ($DryRun) {
    Write-Step 'DryRun：以下动作不会执行'
    Write-Info "1) npm test"
    Write-Info "2) 改 package.json 到 $targetVersion 并提交到 develop"
    Write-Info "3) 推送 develop"
    Write-Info "4) 切 master，git merge --no-ff develop"
    Write-Info "5) git tag -a $tagName"
    Write-Info "6) 推送 master 与 $tagName"
    Write-Info "7) npm pack 生成 dsh-sakurafrp.tgz"
    Write-Info "8) gh release create $tagName"
    Write-Info "9) 切回 develop"
    Write-Host ''
    Write-Ok 'DryRun 通过，环境可以发布。'
    exit 0
}

# ---------------------------------------------------------------- 2. 测试

if ($SkipTests) {
    Write-Step '跳过测试（-SkipTests）'
} else {
    Write-Step '跑测试'
    & npm test
    if ($LASTEXITCODE -ne 0) { Fail 'npm test 未通过，发布会中止。' }
    Write-Ok '测试通过'
}

# ---------------------------------------------------------------- 3. 改版本 + 提交

Write-Step "升级版本到 $targetVersion"

$rawPkg = Get-Content $pkgPath -Raw
# 只替换顶层 "version" 字段，避免误伤依赖里的同名字段
$newRaw = [regex]::Replace($rawPkg, '("version"\s*:\s*")[^"]*(")', "`${1}$targetVersion`${2}", 1)
if ($newRaw -eq $rawPkg) { Fail '替换版本号失败，package.json 结构可能变了。' }
Set-Content -Path $pkgPath -Value $newRaw -NoNewline -Encoding utf8
Write-Ok "package.json -> $targetVersion"

Invoke-Git add package.json
Invoke-Git commit -m "chore: 升到 $targetVersion" | Out-Null
Write-Ok '已提交到 develop'

# ---------------------------------------------------------------- 4. 推 develop

if ($hasRemote) {
    Write-Step '推送 develop'
    Invoke-Git push origin develop | Out-Null
    Write-Ok 'origin/develop 已更新'
}

# ---------------------------------------------------------------- 5. 合并到 master

Write-Step '合并 develop -> master'

Invoke-Git switch master | Out-Null
if ($hasRemote) {
    Invoke-Git pull --ff-only origin master | Out-Null
}

$mergeMsg = "release: $tagName"
Invoke-Git merge --no-ff develop -m $mergeMsg | Out-Null
Write-Ok "已生成 --no-ff 合并点：$mergeMsg"

# ---------------------------------------------------------------- 6. 打 tag

Write-Step "打 tag $tagName"
Invoke-Git tag -a $tagName -m "release $tagName" | Out-Null
Write-Ok "$tagName 已创建"

# ---------------------------------------------------------------- 7. 推 master 与 tag

if ($hasRemote) {
    Write-Step '推送 master 与 tag'
    Invoke-Git push origin master | Out-Null
    Invoke-Git push origin $tagName | Out-Null
    Write-Ok '远端已更新'
}

# ---------------------------------------------------------------- 8. 打包

Write-Step '打包 tgz'
$packOut = & npm pack --silent 2>&1
$packOut = ($packOut | Select-Object -Last 1).Trim()
if (-not (Test-Path $packOut)) { Fail "npm pack 未产出文件（输出：$packOut）。" }
$tgzPath = Join-Path $repoRoot 'dsh-sakurafrp.tgz'
Move-Item -Path $packOut -Destination $tgzPath -Force
Write-Ok "已生成 $tgzPath"

# ---------------------------------------------------------------- 9. 建 Release

if (-not $NoPush) {
    Write-Step "建 GitHub Release $tagName"

    $notesFile = Join-Path $repoRoot "docs/release-notes/$tagName.md"
    $useAutoNotes = $false

    if ($Notes) {
        $Notes | Out-File -FilePath $notesFile -Encoding utf8 -NoNewline
        Write-Info "用 -Notes 参数作为正文"
    } elseif (Test-Path $notesFile) {
        Write-Info "用 $notesFile 作为正文"
    } else {
        $useAutoNotes = $true
        Write-Info '没有正文来源，改用 gh 自动生成'
    }

    $relArgs = @('release', 'create', $tagName, $tgzPath, '--title', $tagName)
    if ($useAutoNotes) {
        $relArgs += '--generate-notes'
    } else {
        $relArgs += @('--notes-file', $notesFile)
    }

    & gh @relArgs
    if ($LASTEXITCODE -ne 0) { Fail '建 Release 失败。master 与 tag 已推送，可手动补 Release。' }
    Write-Ok "Release $tagName 已发布"
}

# ---------------------------------------------------------------- 10. 回 develop

Write-Step '切回 develop'
Invoke-Git switch develop | Out-Null

# 若 master 比 develop 多了提交（hotfix 场景），提示合并
$ahead = & git rev-list --count develop..master
if ([int]$ahead -gt 0) {
    Write-Warn2 "master 比 develop 多 $ahead 个提交（合并点或 hotfix）。"
    Write-Info '如需让 develop 同步 master 的修复，执行：git merge master'
}

# ---------------------------------------------------------------- 完成

Write-Host ''
Write-Host '发布完成' -ForegroundColor Green
Write-Host "    版本   $targetVersion"
Write-Host "    tag    $tagName"
if (-not $NoPush) {
    Write-Host "    Release https://github.com/MentholTea/dsh-sakurafrp/releases/tag/$tagName"
}
Write-Host ''
Write-Info "下一步仍是日常：在 develop 上继续小步提交。"
