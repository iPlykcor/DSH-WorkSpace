# 单文件一键部署包（`octopus-oneclick-<版本>.zip`）

> 设计史。规则摘要见 [AGENTS.md](../../AGENTS.md) §2；面向使用者的步骤在
> [README.md](../../README.md)「内网 / 离线部署」与包内 `INSTALL-OFFLINE.md`。

## 1. 需求与结论

要求原话是「离线部署包，`.zip` 格式，导入内网后一键部署；包内只包含一个 `.ps1` 文件，
双击即自动部署完成」。

**结论：单文件形态成立，但那个文件必须是 `.cmd`，不能是 `.ps1`。** 这不是偏好问题，
是 Windows 的关联事实：双击 `.ps1` 只会「打开」，不会「执行」（见 §3）。所以交付物是

```
dist\offline\octopus-oneclick-<版本>.zip     ← 拷进内网的就是它
  deploy.cmd                                 ← zip 里唯一的文件，双击即装完
dist\offline\octopus-oneclick-<版本>\
  deploy.cmd                                 同一个文件，未压缩
  deploy.ps1                                 同一份部署器的纯 .ps1 形态
dist\offline\octopus-oneclick-<版本>.zip.sha256   传输完整性校验（不放进 zip）
```

`.ps1` 形态保留在 zip **外面**：给那些 `.ps1` 确实有「使用 PowerShell 运行」菜单的机器用，
它调用的部署器与 `.cmd` 内嵌的那份逐字节相同。

## 2. 两种形态的分工

| | 多文件包 `octopus-offline-<版本>.zip` | 单文件包 `octopus-oneclick-<版本>.zip` |
| --- | --- | --- |
| 包内文件 | 84 个（`package\` + tarball + 4 个脚本 + 中文指南 + `SHA256SUMS.txt`） | **1 个**（`deploy.cmd`） |
| 体积 | 0.53 MB | 0.32 MB |
| 双击入口 | `deploy-offline.cmd` | `deploy.cmd` |
| 可审计性 | 高：能直接读安装器、逐文件哈希、中文指南 | 低：安装器以 base64 内嵌（但逐字节等于多文件包那一份，演练会证明） |
| 适合 | 需要评审/留存/排障的场合 | 「拷进去、双击、完事」 |

两份都由同一套源生成，安装逻辑**只有一份**（`scripts\offline\install-offline.ps1`）。
单文件包不复制任何一行安装逻辑，它只做「把内嵌 payload 解到临时目录 → 调用那份安装器」。

## 3. 为什么是 `.cmd`（本机实测，可作为选型依据）

| 探测 | 结果 |
| --- | --- |
| `assoc .ps1` | `File association not found for extension .ps1` |
| `ftype Microsoft.PowerShellScript.1` | `File type ... not found or no open command associated with it` |
| `HKCR\.ps1\shell` | 键不存在（右击**没有**「使用 PowerShell 运行」这一项） |
| `HKCU\...\FileExts\.ps1\UserChoice` | `ProgId = AppXxf01pj590w7z9mxmyv3nx0a9ewj3e51g`（AppX 编辑器，即记事本一类的「打开」） |
| `assoc .cmd` / `ftype cmdfile` | 存在，双击即执行 |
| `Get-ExecutionPolicy -Scope LocalMachine` | `RemoteSigned`（所以入口必须自己带 `-ExecutionPolicy Bypass`） |

也就是说：双击 `.ps1` 在任何一台 Windows 上都是「用某个程序打开它」，默认程序是编辑器；
能执行 `.ps1` 的只有右击菜单里的动词，而本机连那个动词都没注册。因此「双击即装完」
这条要求只能由 `.cmd`（或 `.exe`）满足。

`.cmd` 里的 `-ExecutionPolicy Bypass` 不是可选项：本机 `LocalMachine` 是 `RemoteSigned`，
若文件还带着「从网上下载」标记（zip 经邮件/IM 转发时常见），不加就报「未数字签名」。

## 4. 单文件的结构

```
@echo off
rem ... 20 行前言：为什么是 .cmd、可用参数 ...
setlocal
set "OCTO_SELF=%~f0"                       ← 自身绝对路径（含中文/空格的路径靠环境变量传，不拼命令行）
set "OCTO_TMP=%TEMP%\octopus-deploy-<随机>.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "...读自身、按 marker 切出 PowerShell 部分、写 OCTO_TMP..."
if not exist "%OCTO_TMP%" goto :payload_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "%OCTO_TMP%" %*     ← 参数原样透传
set "OCTO_RC=%ERRORLEVEL%"
del "%OCTO_TMP%" >nul 2>&1
exit /b %OCTO_RC%
:payload_failed
... 提示「文件可能被截断，请重新拷贝」+ pause + exit /b 1
#OCTOPUS-PS1-BEGIN#
<# ... 部署器：纯 ASCII 的 PowerShell ... #>
```

部署器自己再内嵌三样东西（全部 base64，因此源码保持纯 ASCII）：

1. `package\` 的 zip（77 个文件，`ZipFile.CreateFromDirectory` 带基目录 → 条目 `package\...`）；
2. `install-offline.ps1` 与 `uninstall-plugin.ps1` 的**原始字节**；
3. `SHA256SUMS.txt` 与中文小结（`scripts\offline\oneclick\summary-zh.txt`，UTF-8 显式读入后 base64）。

运行顺序：解到 `%TEMP%\octopus-deploy-<8位随机>`（或 `-ExtractTo` 指定处）→ 写回
`install-offline.ps1` / `uninstall-plugin.ps1` / `SHA256SUMS.txt` → 直接 `&` 调用
`install-offline.ps1 -Yes -Profile <p>`（或多 profile 逐个调卸载器）→ 成功删除临时目录，
失败**保留**并打印路径 → `Read-Host` 停住窗口 → `exit 0/1`。

为什么源码必须纯 ASCII：无 BOM 的 UTF-8 `.ps1` 会被 PS 5.1 按系统 ANSI 码页（本机 GBK）
读取，任何非 ASCII 的**源码字节**都会被重新解释。中文小结因此是**数据**而不是源码：生成
时 base64，运行时解码。是否打印它由 `[Console]::OutputEncoding.CodePage` 是否属于
`936 / 950 / 949 / 932 / 65001` 决定 —— 英文控制台上中文只会变成 `?`，那就只留英文行。
实测本机双击控制台是 CP936，GBK 字节直接渲染正常。

## 5. 生成器做了什么校验（`scripts\make-oneclick-package.ps1`）

1. 包清单存在、`package\` / 安装器 / 卸载器 / `SHA256SUMS.txt` 都在（缺则提示先跑
   `make-offline-package.ps1`）；
2. 渲染后**没有残留 `<<...>>` 占位符**、**纯 ASCII**、长度下限；
3. `.cmd` 里 marker 恰好出现一次，且部署器本身不含 marker；
4. 用 PowerShell 解析器**分别解析** `deploy.ps1` 与 `.cmd` 里那段真实会执行的文本；
5. 内嵌 `package.json` 的 SHA256 与 `package\package.json` 相同；内嵌安装器**逐字节等于**
   多文件包里的 `install-offline.ps1`；
6. 产物 zip 里**恰好一个文件**且名为 `deploy.cmd`；另写 `<zip>.sha256`。

## 6. 踩到并修掉的坑

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 生成的 zip 被写进 `octopus-oneclick-<版本>\octopus-oneclick-<版本>.zip` | 脚本里用了 `$outDir`，与外层参数 `$OutDir` **大小写不敏感地**撞名，直接把输出根改写了 | 改名 `$artifactDir`，并在注释里写死这条 |
| 「内嵌 zip 里没有 `package/package.json`」 | .NET Framework 的 `CreateFromDirectory` 在 Windows 上写**反斜杠** entry 名（`package\package.json`） | 比较前把 `\` 归一成 `/` |
| `-Uninstall` 明明没卸掉，容器却退 0 | ① `uninstall-plugin.ps1` 的 `-Profile` 只收**一个**名字，空=全部；传 `all` 会去找 `profiles\all` → `exit 1`。② 被 `&` 调用的脚本 `exit 1` **不抛异常**，只设 `$LASTEXITCODE` | `all` 翻译成「不传 `-Profile`」，逗号列表逐个 profile 调；卸载路径**必须**查 `$LASTEXITCODE` |
| 演练里 `Start-Process -ArgumentList @()` 直接报错 | 空集合不被接受 | 参数为空时**不给** `ArgumentList` |
| 演练断言「中文没打出来」 | 演练脚本自己含中文字面量，被 PS 5.1 按 GBK 读成乱码；而子进程输出确实是 GBK 字节 | 演练保持纯 ASCII，期望值从 `summary-zh.txt` 用 UTF-8 显式读入 |
| 演练断言「临时目录没清掉」 | 该目录来自**故意失败**（`-Force` 拒绝）的那次运行，按设计保留 | 断言改成「成功的那次前后计数不变」 |

`$LASTEXITCODE` 的两种语义要分开记：`install-offline.ps1` 成功时走到末尾**不设退出码**、
失败是 `throw`（所以用 `try/catch`）；`uninstall-plugin.ps1` 相反，每条终点都 `exit N`，
**不抛异常**（所以必须查 `$LASTEXITCODE`）。两者写反就会得到「看起来成功、其实什么都没做」。

## 7. 演练（`%TEMP%`，48 项断言，不入库）

| 组 | 覆盖 |
| --- | --- |
| A | 交付 zip 里**恰好一个文件**、就是 `deploy.cmd`、解压后目录里也只有它、纯 ASCII、体积够大 |
| B | **真·双击形状**：无参数、cwd=`System32`、stdin 为 EOF → 退 0、报的是用户放置目录而非 `%TEMP%`、payload 解开、走到 READY、中文小结按 CP936 打出、两个 profile 都装上、临时目录已清 |
| C | `deploy.ps1` 单独跑（「使用 PowerShell 运行」形态） |
| D | `-DryRun` 清单**逐字节不变**；`-Uninstall` 两处挂载项消失、基座 bundle 存活、插件目录被移除 |
| E | `-Profile web` 只碰 web，desktop 的清单哈希不变 |
| F | 假的超范围桌面安装（`dsh.cmd` 打印 `0.9.9`）：**拒绝**并指名道姓、提示 `-Force`；`-Force` 能照装 |
| G | `-ExtractTo` 留下的 payload：安装器/卸载器/`SHA256SUMS.txt` 逐字节等于多文件包，`package\` 的 77 个文件哈希全等 |
| H | 真实 `~/.dsh` 两个 profile 清单哈希前后不变；用户主目录没有多出 `profiles\` |

## 8. 用法

```bat
deploy.cmd                 :: 双击等于这条；装进所有 profile
deploy.cmd -DryRun         :: 只打印计划，一个字节都不写
deploy.cmd -Profile web    :: 只装 web
deploy.cmd -Uninstall      :: 摘掉（可配 -Profile）
deploy.cmd -Force          :: 版本探测不通过时照装
deploy.cmd -DshHome D:\x   :: 装进另一个 home（演练用）
deploy.cmd -ExtractTo D:\y :: 解到指定目录并保留（排障用）
```

装完仍需**人手一步**：从托盘退出宿主再启动 —— 插件只在启动时加载，而这两个脚本都
**绝不**重启正在用的宿主。
