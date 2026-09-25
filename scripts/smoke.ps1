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
