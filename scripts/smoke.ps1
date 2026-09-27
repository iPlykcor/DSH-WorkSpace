<#
.SYNOPSIS
  真实挂载冒烟：打包 -> 装进全新 scratch profile -> 启动真实宿主 -> 打 HTTP 探针 -> 收尾。

.DESCRIPTION
  验证的是「宿主真的能把这个插件装起来，并跑通它唯一的那条路由」。不涉及浏览器
  渲染——页签渲染需要浏览器自动化，本仓库没有那条 lane（见 AGENTS.md 第 2 节），
  所以本脚本不会、也不能声称渲染通过。

  安全性（为什么可以随便跑）：
    * DSH_HOME 指向新建的临时目录，**绝不触碰你真实的 ~/.dsh**；
    * 宿主用 --port 0 取随机空闲端口，不占你正在用的 GUI（默认 :3080）；
    * 无论成功失败，都在 finally 里按「监听端口」回收宿主进程并删除临时目录。

  退出码：0 = 全部通过；1 = 任意一项失败（失败项以红色 FAIL 打印）。

.PARAMETER ReadyTimeoutSeconds
  等待宿主打印就绪行的秒数上限（默认 120）。

.PARAMETER KeepHome
  保留 scratch profile 目录以便排查，结束时打印其路径。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1 -KeepHome -ReadyTimeoutSeconds 180

.NOTES
  Written for Windows PowerShell 5.1 (no `pwsh` required); it also runs under
  PowerShell 7. Only the .cmd launcher derivation is Windows-specific.
#>
[CmdletBinding()]
param(
  [int]$ReadyTimeoutSeconds = 120,
  [switch]$KeepHome
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$previousHome = $env:DSH_HOME
$home2 = Join-Path $env:TEMP ("dsh-octopus-smoke-" + (Get-Random))
$bootOut = Join-Path $home2 'boot.out'
$bootErr = Join-Path $home2 'boot.err'
$proc = $null
$port = 0
$failures = 0

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Pass { param([string]$Text) Write-Host "  PASS  $Text" -ForegroundColor Green }
function Write-Fail {
  param([string]$Text)
  Write-Host "  FAIL  $Text" -ForegroundColor Red
  $script:failures++
}

# POST one API method and return @{ status; body } — including for 4xx/5xx,
# where Invoke-WebRequest throws and the body must be read off the response.
function Invoke-OctopusApi {
  param([string]$Base, [string]$Method, [string]$Json)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$Base/octopus/api/$Method" `
      -ContentType 'application/json' -Body $Json
    return @{ status = [int]$response.StatusCode; body = $response.Content }
  } catch {
    $status = 0
    $body = ''
    try {
      $response = $_.Exception.Response
      $status = [int]$response.StatusCode
      $body = (New-Object System.IO.StreamReader($response.GetResponseStream())).ReadToEnd()
    } catch {
      $body = ''
    }
    return @{ status = $status; body = $body }
  }
}

function Assert-Status {
  param([hashtable]$Reply, [int]$Expected, [string]$What)
  if ($Reply.status -eq $Expected) {
    Write-Pass "$What -> $Expected"
  } else {
    Write-Fail "$What -> expected $Expected, got $($Reply.status)  $($Reply.body)"
  }
}

# Compact JSON body for one payload hashtable.
function Body { param([Hashtable]$Payload) return ($Payload | ConvertTo-Json -Compress) }

# Run a native command, capturing both streams to files, and return its exit code.
#
# Both obvious spellings FAIL here while $ErrorActionPreference is 'Stop':
# `& cmd 2>&1 | ...` and `& cmd > out 2> err` each turn the child's stderr into a
# TERMINATING NativeCommandError (verified on PS 5.1.26100). Only a local
# 'Continue' lets the child's stderr be ordinary captured text.
function Invoke-Captured {
  param([scriptblock]$Command, [string]$OutFile, [string]$ErrFile)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command > $OutFile 2> $ErrFile
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

Push-Location $repo
try {
  New-Item -ItemType Directory -Path $home2 -Force | Out-Null
  Write-Host "repo              : $repo"
  Write-Host "scratch DSH_HOME  : $home2"
  Write-Host ''

  Write-Step 'build + pack'
  # Success chatter is swallowed (pnpm echoes the build command to stderr); a
  # real failure prints the whole log before the script gives up.
  $code = Invoke-Captured -Command { & pnpm build } `
    -OutFile (Join-Path $home2 'build.out') -ErrFile (Join-Path $home2 'build.err')
  if ($code -ne 0) {
    Get-Content -Path (Join-Path $home2 'build.out'), (Join-Path $home2 'build.err') -ErrorAction SilentlyContinue | Write-Host
    throw 'pnpm build failed'
  }
  Get-ChildItem -Path $repo -Filter '*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
  $tgzName = (& pnpm pack | Select-Object -Last 1).Trim()
  $tgz = Join-Path $repo $tgzName
  if (-not (Test-Path $tgz)) { throw "pnpm pack did not produce $tgz" }
  Write-Pass "packed $tgzName"

  Write-Step 'install into the fresh profile'
  $env:DSH_HOME = $home2
  $uri = 'file:' + ($tgz -replace '\\', '/')
  $code = Invoke-Captured -Command { & dsh plugin --profile web add $uri } `
    -OutFile (Join-Path $home2 'add.out') -ErrFile (Join-Path $home2 'add.err')
  if ($code -ne 0) {
    Get-Content -Path (Join-Path $home2 'add.out'), (Join-Path $home2 'add.err') -ErrorAction SilentlyContinue | Write-Host
    throw 'dsh plugin add failed'
  }
  Write-Pass "installed into $home2\profiles\web"

  Write-Step 'boot the real host'
  # Start-Process cannot execute a .ps1 directly, so derive the sibling .cmd
  # launcher from the resolved command path. (Reading a `.Extension` property
  # off Get-Command's output does NOT work: those objects are ApplicationInfo /
  # ExternalScript, and StrictMode makes the missing property a hard error.)
  $dshPath = (Get-Command dsh).Path
  $dshCmd = [System.IO.Path]::ChangeExtension($dshPath, '.cmd')
  if (-not (Test-Path $dshCmd)) { $dshCmd = $dshPath }
  Write-Host "  launcher: $dshCmd"
  $proc = Start-Process -FilePath $dshCmd -ArgumentList @('web', '--port', '0', '--no-open') `
    -RedirectStandardOutput $bootOut -RedirectStandardError $bootErr -PassThru -NoNewWindow

  $url = $null
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $bootOut) {
      $match = Select-String -Path $bootOut -Pattern 'dsh web: (http://\S+)' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($match) { $url = $match.Matches[0].Groups[1].Value; break }
    }
    if ($proc.HasExited) {
      $detail = if (Test-Path $bootErr) { Get-Content $bootErr -Raw } else { '(no stderr)' }
      throw "host exited before becoming ready (code $($proc.ExitCode)):`n$detail"
    }
    Start-Sleep -Milliseconds 400
  }
  if (-not $url) { throw "host did not become ready within $ReadyTimeoutSeconds s" }
  $base = ([uri]$url).GetLeftPart([System.UriPartial]::Authority)
  $port = ([uri]$url).Port
  Write-Pass "host ready at $base"

  Write-Step 'fixture manifest'
  # Written BOM-less on purpose: PowerShell 5.1's `-Encoding UTF8` emits a BOM,
  # which makes the manifest fail JSON parsing (activate then answers 400).
  $fx = Join-Path $home2 'fixture'
  New-Item -ItemType Directory -Path (Join-Path $fx 'ro'), (Join-Path $fx 'rw') -Force | Out-Null
  Set-Content -Path (Join-Path $fx 'ro\guarded.txt') -Value 'original' -NoNewline
  $manifest = Join-Path $fx 'smoke.dsh-octopus'
  $manifestJson = '{ "name": "smoke", "folders": [ { "path": "ro" }, { "path": "rw", "access": "readWrite" } ] }'
  [System.IO.File]::WriteAllText($manifest, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
  Write-Pass "wrote $manifest (ro = readOnly, rw = readWrite)"

  $session = 'octopus-smoke-cold'
  $stateBody = Body @{ sessionId = $session }

  Write-Step 'route probes: cold session and the root fence'
  Assert-Status (Invoke-OctopusApi $base 'session.cwd' $stateBody) 200 'session.cwd for a cold session (regression: used to 500)'
  Assert-Status (Invoke-OctopusApi $base 'workspace.state' $stateBody) 200 'workspace.state with no active space'
  Assert-Status (Invoke-OctopusApi $base 'fs.tree' (Body @{ sessionId = $session; path = $fx })) 403 'fs.tree is fenced while no space is active'
  # The manifest-append route is fenced the same way, and answering 403 (not 404)
  # is also how this probe proves the route is registered at all.
  Assert-Status (Invoke-OctopusApi $base 'workspace.addFolder' (Body @{ sessionId = $session; path = $fx })) 403 'workspace.addFolder with no active space -> 403'
  # Same fence, same proof of registration, for the padlock route.
  Assert-Status (Invoke-OctopusApi $base 'workspace.setFolderAccess' (Body @{ sessionId = $session; path = $fx; access = 'readWrite' })) 403 'workspace.setFolderAccess with no active space -> 403'
  # Same fence, same proof of registration, for the removal route.
  Assert-Status (Invoke-OctopusApi $base 'workspace.removeFolder' (Body @{ sessionId = $session; path = $fx })) 403 'workspace.removeFolder with no active space -> 403'

  # Discovery is the deliberate exception to that fence: it runs precisely while
  # nothing is active, because it is what makes applying a manifest possible
  # without a hand-typed path.
  $discovery = Invoke-OctopusApi $base 'workspace.discover' (Body @{ sessionId = $session; cwd = $fx })
  Assert-Status $discovery 200 'workspace.discover before activation (deliberately not fenced)'
  if ($discovery.status -eq 200) {
    if ($discovery.body -match 'smoke\.dsh-octopus') { Write-Pass 'discovery finds the fixture manifest in the session cwd' }
    else { Write-Fail "discovery missed the fixture manifest: $($discovery.body)" }
    if ($discovery.body -match '"autoActivate":true') { Write-Pass 'discovery reports the default autoActivate' }
    else { Write-Fail "discovery lost autoActivate: $($discovery.body)" }
  }
  Assert-Status (Invoke-OctopusApi $base 'workspace.discover' (Body @{ sessionId = $session; cwd = (Join-Path $fx 'no-such-folder') })) 200 'discovery of a missing folder -> 200 (empty, not an error)'

  Write-Step 'route probes: operation-space lifecycle'
  $activated = Invoke-OctopusApi $base 'workspace.activate' (Body @{ sessionId = $session; path = $manifest; cwd = $fx })
  Assert-Status $activated 200 'workspace.activate'
  if ($activated.status -eq 200) {
    if ($activated.body -match '"access":"readOnly"') { Write-Pass 'activated roots include the readOnly root' }
    else { Write-Fail "activated roots have no readOnly root: $($activated.body)" }
    if ($activated.body -match '"listed":false') { Write-Pass 'the implicit session root is declared unlisted' }
    else { Write-Fail "no unlisted implicit root in: $($activated.body)" }
  }
  Assert-Status (Invoke-OctopusApi $base 'fs.tree' (Body @{ sessionId = $session; path = (Join-Path $fx 'ro') })) 200 'fs.tree inside a readOnly root (readOnly is readable)'
  Assert-Status (Invoke-OctopusApi $base 'workspace.violations' $stateBody) 200 'workspace.violations'
  $rollback = Invoke-OctopusApi $base 'workspace.rollback' (Body @{ sessionId = $session; callId = 'no-such-call' })
  Assert-Status $rollback 200 'workspace.rollback with an unknown callId'
  if ($rollback.status -eq 200 -and $rollback.body -match '"ok":false') { Write-Pass 'rollback refused an unknown callId' }
  elseif ($rollback.status -eq 200) { Write-Fail "rollback did not refuse: $($rollback.body)" }
  Write-Step 'route probes: adding a folder to the active space'
  # This is the plugin's ONLY write to the user's disk, so the probe list is
  # deliberately long: every refusal, the write itself, what the manifest then
  # says, the sidecar backup, and idempotence.
  $extra = Join-Path $fx 'extra'
  New-Item -ItemType Directory -Force -Path $extra | Out-Null
  Assert-Status (Invoke-OctopusApi $base 'workspace.addFolder' (Body @{ sessionId = $session; path = $manifest })) 400 'workspace.addFolder refuses a file (400)'
  Assert-Status (Invoke-OctopusApi $base 'workspace.addFolder' (Body @{ sessionId = $session; path = (Join-Path $fx 'no-such-folder') })) 400 'workspace.addFolder refuses a missing path (400)'
  Assert-Status (Invoke-OctopusApi $base 'workspace.addFolder' (Body @{ sessionId = $session; path = $extra; access = 'sideways' })) 400 'workspace.addFolder refuses an unknown access (400)'
  $added = Invoke-OctopusApi $base 'workspace.addFolder' (Body @{ sessionId = $session; path = $extra })
  Assert-Status $added 200 'workspace.addFolder appends a real directory'
  if ($added.status -eq 200) {
    if ($added.body -match '"added":true') { Write-Pass 'the append is reported as added' }
    else { Write-Fail "the append was not reported: $($added.body)" }
    if ($added.body -match '"access":"readOnly"') { Write-Pass 'the new root is read-only by default' }
    else { Write-Fail "the default access is not readOnly: $($added.body)" }
    if ($added.body -match '"label":"extra"') { Write-Pass 'the answer names the appended folder' }
    else { Write-Fail "the answer does not name the folder: $($added.body)" }
  }
  $manifestText = [string](Get-Content -Path $manifest -Raw)
  if ($manifestText -match '"path": "extra"') { Write-Pass 'the manifest gained a RELATIVE path (the folder sits under the manifest directory)' }
  else { Write-Fail "the manifest does not carry the new entry: $manifestText" }
  if ($manifestText -match '"name": "smoke"') { Write-Pass 'the manifest kept the keys it already had' }
  else { Write-Fail "the manifest lost content: $manifestText" }
  $backups = @(Get-ChildItem -Path $fx -Filter '*octopus-backup' -File)
  if ($backups.Count -ge 1) { Write-Pass "a sidecar backup was kept: $($backups[0].Name)" }
  else { Write-Fail 'no backup was written next to the manifest' }
  $again = Invoke-OctopusApi $base 'workspace.addFolder' (Body @{ sessionId = $session; path = $extra })
  Assert-Status $again 200 'workspace.addFolder for a folder that is already declared'
  if ($again.status -eq 200 -and $again.body -match '"added":false') { Write-Pass 'the second add reports added:false instead of duplicating' }
  elseif ($again.status -eq 200) { Write-Fail "the second add was not idempotent: $($again.body)" }
  $afterEdit = Invoke-OctopusApi $base 'workspace.state' $stateBody
  Assert-Status $afterEdit 200 'workspace.state after the edit (the host re-activated the manifest)'
  if ($afterEdit.status -eq 200 -and $afterEdit.body -match '"label":"extra"') { Write-Pass 'the re-activated snapshot already lists the new root' }
  elseif ($afterEdit.status -eq 200) { Write-Fail "the new root is missing from the snapshot: $($afterEdit.body)" }

  Write-Step 'route probes: changing a root access level (the padlock write point)'
  # The SECOND write point, sharing the append's transaction but aimed at one
  # declared entry. Same idea as the block above: every refusal that keeps a level
  # from landing in the wrong entry, then the write itself, the sidecar, and the
  # idempotent repeat.
  $outside = Join-Path $home2 'outside-the-space'
  New-Item -ItemType Directory -Force -Path $outside | Out-Null
  Assert-Status (Invoke-OctopusApi $base 'workspace.setFolderAccess' (Body @{ sessionId = $session; path = $extra; access = 'sideways' })) 400 'workspace.setFolderAccess refuses an unknown access (400)'
  Assert-Status (Invoke-OctopusApi $base 'workspace.setFolderAccess' (Body @{ sessionId = $session; path = $outside; access = 'readWrite' })) 400 'workspace.setFolderAccess refuses a path outside the space (400)'
  # The session cwd is in every snapshot as the implicit root, but no manifest entry
  # declares it, so there is nothing that could persist a level for it.
  Assert-Status (Invoke-OctopusApi $base 'workspace.setFolderAccess' (Body @{ sessionId = $session; path = $fx; access = 'readOnly' })) 400 'workspace.setFolderAccess refuses the implicit session root (400)'

  $hashBefore = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  $flipped = Invoke-OctopusApi $base 'workspace.setFolderAccess' (Body @{ sessionId = $session; path = $extra; access = 'readWrite' })
  Assert-Status $flipped 200 'workspace.setFolderAccess flips a declared root'
  if ($flipped.status -eq 200) {
    # The top-level answer only: the snapshot inside it cannot contain `changed`.
    if ($flipped.body -match '"changed":true,"label":"extra"') { Write-Pass 'the flip is reported as changed, and names the flipped folder' }
    else { Write-Fail "the flip was not reported for extra: $($flipped.body)" }
    if ($flipped.body -match '"backup":"([^"]+)"') {
      # JSON escapes the Windows separators; collapse them back into a real path.
      # (`-replace`, not `.Replace()`: the latter picks the char overload and dies
      # on the two-character pattern, see AGENTS.md section 2.)
      $backupPath = $Matches[1] -replace '\\\\', '\'
      if ((Test-Path -LiteralPath $backupPath) -and $backupPath.StartsWith($manifest) -and $backupPath.EndsWith('.octopus-backup')) {
        Write-Pass "the padlock change left a sidecar backup: $(Split-Path -Leaf $backupPath)"
      } else {
        Write-Fail "the reported backup is not a fresh sidecar next to the manifest: $backupPath"
      }
    } else {
      Write-Fail "the padlock change reported no backup: $($flipped.body)"
    }
  }
  $hashFlipped = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  if ($hashBefore -ne $hashFlipped) { Write-Pass 'the flip really rewrote the manifest (the bytes moved)' }
  else { Write-Fail 'the flip reported changed:true but the manifest bytes did not move' }
  $flippedText = [string](Get-Content -Path $manifest -Raw)
  if ($flippedText -match '"path": "extra", "access": "readWrite"') { Write-Pass 'the manifest now declares extra as readWrite, in place' }
  else { Write-Fail "the manifest did not gain the explicit readWrite for extra: $flippedText" }
  $stateAfterFlip = Invoke-OctopusApi $base 'workspace.state' $stateBody
  Assert-Status $stateAfterFlip 200 'workspace.state after the padlock change (the host re-activated the manifest)'
  if ($stateAfterFlip.status -eq 200) {
    # Parse rather than regex-match: the snapshot lists several roots, and only the
    # one LABELLED extra may report the new level.
    $snapshot = $null
    try { $snapshot = ($stateAfterFlip.body | ConvertFrom-Json).value.workspace } catch { $snapshot = $null }
    if ($null -ne $snapshot) {
      $flippedRoot = @($snapshot.roots | Where-Object { $_.label -eq 'extra' })
      if ($flippedRoot.Count -eq 1 -and $flippedRoot[0].access -eq 'readWrite') { Write-Pass 'the re-activated snapshot reports the flipped root as readWrite' }
      else { Write-Fail "the snapshot does not report extra as readWrite: $($stateAfterFlip.body)" }
    } else {
      Write-Fail "workspace.state did not answer a workspace snapshot: $($stateAfterFlip.body)"
    }
  }
  $repeated = Invoke-OctopusApi $base 'workspace.setFolderAccess' (Body @{ sessionId = $session; path = $extra; access = 'readWrite' })
  Assert-Status $repeated 200 'workspace.setFolderAccess for a root already at that level'
  if ($repeated.status -eq 200 -and $repeated.body -match '"changed":false') { Write-Pass 'the second flip reports changed:false instead of rewriting' }
  elseif ($repeated.status -eq 200) { Write-Fail "the second flip was not idempotent: $($repeated.body)" }
  $hashAfterRepeat = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  if ($hashAfterRepeat -eq $hashFlipped) { Write-Pass 'the idempotent flip left the manifest byte-identical (nothing was written)' }
  else { Write-Fail "the idempotent flip changed the manifest ($hashFlipped -> $hashAfterRepeat)" }

  Write-Step 'route probes: removing a folder from the active space'
  # The third entry to the ONE transaction behind all three routes, and the only
  # edit that can change the SET of roots. The probe list mirrors the two blocks
  # above: the refusals, the deletion itself, the sidecar that holds the
  # pre-removal bytes, the manifest text, the re-activated snapshot, the repeat,
  # and the schema floor that forbids emptying the array.
  $hashBeforeRemoval = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  Assert-Status (Invoke-OctopusApi $base 'workspace.removeFolder' (Body @{ sessionId = $session; path = $outside })) 400 'workspace.removeFolder refuses a path outside the space (400)'
  # The session cwd is in every snapshot as the implicit root, but no manifest entry
  # declares it: there is no declaration that could be deleted for it.
  Assert-Status (Invoke-OctopusApi $base 'workspace.removeFolder' (Body @{ sessionId = $session; path = $fx })) 400 'workspace.removeFolder refuses the implicit session root (400)'
  $hashAfterRemovalRefusals = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  if ($hashAfterRemovalRefusals -eq $hashBeforeRemoval) { Write-Pass 'the two refused removals left the manifest byte-identical' }
  else { Write-Fail 'a refused removal still wrote the manifest' }

  $removed = Invoke-OctopusApi $base 'workspace.removeFolder' (Body @{ sessionId = $session; path = $extra })
  Assert-Status $removed 200 'workspace.removeFolder deletes a declared entry'
  if ($removed.status -eq 200) {
    if ($removed.body -match '"changed":true,"label":"extra"') { Write-Pass 'the removal is reported as changed, and names the removed folder' }
    else { Write-Fail "the removal was not reported for extra: $($removed.body)" }
    if ($removed.body -match '"backup":"([^"]+)"') {
      $removalBackup = $Matches[1] -replace '\\\\', '\'
      if ((Test-Path -LiteralPath $removalBackup) -and $removalBackup.StartsWith($manifest) -and $removalBackup.EndsWith('.octopus-backup')) {
        Write-Pass "the removal left a sidecar backup: $(Split-Path -Leaf $removalBackup)"
        # A backup NAME carries only a second-resolution stamp, so an earlier probe in
        # the same second writes the same name. Its CONTENT is what proves this one is
        # fresh: it has to be the manifest as it was just before the removal.
        $removalBackupHash = (Get-FileHash -Path $removalBackup -Algorithm SHA256).Hash
        if ($removalBackupHash -eq $hashBeforeRemoval) { Write-Pass 'the removal backup holds the pre-removal manifest, byte for byte' }
        else { Write-Fail 'the removal backup does not hold the pre-removal manifest' }
      } else {
        Write-Fail "the reported backup is not a sidecar next to the manifest: $removalBackup"
      }
    } else {
      Write-Fail "the removal reported no backup: $($removed.body)"
    }
  }
  $hashAfterRemoval = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  if ($hashBeforeRemoval -ne $hashAfterRemoval) { Write-Pass 'the removal really rewrote the manifest (the bytes moved)' }
  else { Write-Fail 'the removal reported changed:true but the manifest bytes did not move' }
  $removedText = [string](Get-Content -Path $manifest -Raw)
  # The exact ENTRY text, not a loose 'extra' match: the fixture DIRECTORY is named
  # extra too and stays on disk, so only the declaration may be gone.
  if (-not $removedText.Contains('{ "path": "extra", "access": "readWrite" }')) { Write-Pass 'the manifest no longer declares extra (its exact entry text is gone)' }
  else { Write-Fail "the manifest still declares extra: $removedText" }
  if ($removedText.Contains('"path": "ro"') -and $removedText.Contains('"path": "rw"')) { Write-Pass 'the other declared roots survived the removal' }
  else { Write-Fail "the removal lost another entry: $removedText" }
  if (-not $removedText.Contains(',,')) { Write-Pass 'the removal left no doubled separator comma' }
  else { Write-Fail "the removal produced a doubled comma: $removedText" }
  $stateAfterRemoval = Invoke-OctopusApi $base 'workspace.state' $stateBody
  Assert-Status $stateAfterRemoval 200 'workspace.state after the removal (the host re-activated the manifest)'
  if ($stateAfterRemoval.status -eq 200) {
    # Parse rather than regex-match: the removed DIRECTORY is still on disk, so only
    # the roots list can say whether the declaration is gone.
    $removedSnapshot = $null
    try { $removedSnapshot = ($stateAfterRemoval.body | ConvertFrom-Json).value.workspace } catch { $removedSnapshot = $null }
    if ($null -ne $removedSnapshot) {
      if (@($removedSnapshot.roots | Where-Object { $_.label -eq 'extra' }).Count -eq 0) { Write-Pass 'the re-activated snapshot no longer lists the removed root' }
      else { Write-Fail "the snapshot still lists extra: $($stateAfterRemoval.body)" }
    } else {
      Write-Fail "workspace.state did not answer a workspace snapshot: $($stateAfterRemoval.body)"
    }
  }
  Assert-Status (Invoke-OctopusApi $base 'workspace.removeFolder' (Body @{ sessionId = $session; path = $extra })) 400 'workspace.removeFolder refuses a second removal of the same path (400)'
  $hashAfterSecondRemoval = (Get-FileHash -Path $manifest -Algorithm SHA256).Hash
  if ($hashAfterSecondRemoval -eq $hashAfterRemoval) { Write-Pass 'the refused second removal wrote nothing' }
  else { Write-Fail 'the refused second removal still wrote the manifest' }

  # The floor the schema puts under this route: a manifest must declare at least one
  # folder, so the ONLY entry cannot be dropped. A second, single-entry manifest is
  # activated just for this probe; it replaces the space above, which has by now
  # passed every assertion it was written for.
  $single = Join-Path $fx 'single.dsh-octopus'
  $singleJson = '{ "name": "smoke-single", "folders": [ { "path": "extra" } ] }'
  [System.IO.File]::WriteAllText($single, $singleJson, (New-Object System.Text.UTF8Encoding($false)))
  Assert-Status (Invoke-OctopusApi $base 'workspace.activate' (Body @{ sessionId = $session; path = $single; cwd = $fx })) 200 'workspace.activate for the single-entry fixture'
  $hashSingleBefore = (Get-FileHash -Path $single -Algorithm SHA256).Hash
  Assert-Status (Invoke-OctopusApi $base 'workspace.removeFolder' (Body @{ sessionId = $session; path = $extra })) 400 'workspace.removeFolder refuses to remove the only declared folder (400)'
  $hashSingleAfter = (Get-FileHash -Path $single -Algorithm SHA256).Hash
  if ($hashSingleAfter -eq $hashSingleBefore) { Write-Pass 'the refusal left the single-entry manifest byte-identical' }
  else { Write-Fail 'the refused removal of the only entry still wrote the manifest' }
  $singleBackups = @(Get-ChildItem -Path $fx -Filter 'single.dsh-octopus*octopus-backup' -File)
  if ($singleBackups.Count -eq 0) { Write-Pass 'the refusal left no sidecar next to the single-entry manifest' }
  else { Write-Fail "the refusal left $($singleBackups.Count) sidecar(s) behind" }
  $stateAfterOnly = Invoke-OctopusApi $base 'workspace.state' $stateBody
  Assert-Status $stateAfterOnly 200 'workspace.state after the refused removal (the space is unchanged)'
  if ($stateAfterOnly.status -eq 200) {
    $onlySnapshot = $null
    try { $onlySnapshot = ($stateAfterOnly.body | ConvertFrom-Json).value.workspace } catch { $onlySnapshot = $null }
    if ($null -ne $onlySnapshot -and $onlySnapshot.name -eq 'smoke-single' -and @($onlySnapshot.roots | Where-Object { $_.label -eq 'extra' }).Count -eq 1) {
      Write-Pass 'the refused removal left the operation space active, with its root'
    } else {
      Write-Fail "the space did not survive the refused removal: $($stateAfterOnly.body)"
    }
  }

  Assert-Status (Invoke-OctopusApi $base 'workspace.deactivate' $stateBody) 200 'workspace.deactivate'
  Assert-Status (Invoke-OctopusApi $base 'workspace.state' $stateBody) 200 'workspace.state after deactivate'

  Write-Step 'route probes: envelopes and method guard'
  Assert-Status (Invoke-OctopusApi $base 'does.not.exist' '{}') 404 'unknown method -> plugin 404 envelope'
  Assert-Status (Invoke-OctopusApi $base 'workspace.state' '{ not json') 400 'malformed body -> 400'
  Assert-Status (Invoke-OctopusApi $base 'workspace.state' '{}') 400 'missing required field -> 400'
  try {
    $get = Invoke-WebRequest -UseBasicParsing -Method GET -Uri "$base/octopus/api/workspace.state"
    Write-Fail "GET -> expected 405, got $([int]$get.StatusCode)"
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
    if ($code -eq 405) { Write-Pass 'GET -> 405' } else { Write-Fail "GET -> expected 405, got $code" }
  }

  Write-Step 'host log hygiene'
  $logs = @()
  if (Test-Path $bootOut) { $logs += $bootOut }
  if (Test-Path $bootErr) { $logs += $bootErr }
  $noise = if ($logs.Count -gt 0) {
    Select-String -Path $logs -Pattern 'duplicate prefix route|failed to load|cannot find module|unhandled' -ErrorAction SilentlyContinue
  } else { $null }
  if ($noise) {
    Write-Fail "host log reports wiring problems:`n$(($noise | ForEach-Object { "        $($_.Line)" }) -join "`n")"
  } else {
    Write-Pass 'no loader / inject / duplicate-prefix failures in the host log'
  }

  # An empty file makes `Get-Content -Raw` return $null, and PowerShell 5.1 does
  # NOT coerce that to '' — `[string](Get-Content $f -Raw)` on an empty file is
  # still $null (verified), so `.Trim()` on it is a hard error. That failure mode
  # is especially nasty here: it fires AFTER every probe has already passed.
  $stderrText = ''
  if (Test-Path $bootErr) {
    $raw = Get-Content $bootErr -Raw
    if ($null -ne $raw) { $stderrText = $raw.ToString() }
  }
  $stderrText = $stderrText.Trim()
  Write-Step 'host stderr'
  if ($stderrText -eq '') {
    Write-Pass 'host stderr is empty'
  } else {
    Write-Host "  NOTE  host stderr is not empty (normal on some hosts; read it if a probe failed):" -ForegroundColor Yellow
    Write-Host $stderrText
  }
}
finally {
  Write-Host ''
  Write-Step 'teardown'
  # Kill by the LISTENING PORT, not by the launcher pid: the launcher is a .cmd
  # wrapper and the actual host is its node grandchild, so stopping the wrapper
  # would strand the server.
  if ($port -gt 0) {
    $owner = $null
    try {
      $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
        Select-Object -First 1).OwningProcess
    } catch { $owner = $null }
    if ($owner) {
      Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
      Write-Pass "stopped the host (pid $owner, port $port)"
    } else {
      Write-Host "  (nothing listening on port $port any more)"
    }
  }
  if ($proc -ne $null -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  if ($previousHome) { $env:DSH_HOME = $previousHome } else { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
  Pop-Location
  if ($KeepHome) {
    Write-Host "  kept scratch profile: $home2"
  } else {
    Remove-Item $home2 -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
if ($failures -gt 0) {
  Write-Host "SMOKE FAILED: $failures check(s)" -ForegroundColor Red
  exit 1
}
Write-Host 'SMOKE PASSED' -ForegroundColor Green
exit 0
