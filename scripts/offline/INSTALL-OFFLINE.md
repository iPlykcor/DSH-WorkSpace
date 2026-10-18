# 章鱼作业区 · 内网离线部署说明

> 包版本 **{{PLUGIN_VERSION}}**　构建自提交 `{{DSHWS_COMMIT}}`　生成时间 {{BUILT_AT}}
>
> 这个包给**不能访问 npm 仓库**的机器用。它自带已经构建好的插件产物，安装过程是**纯文件操作**：不需要 npm、不需要 pnpm、不需要任何网络。
>
> 两类 DSH 都支持：**命令行安装版**（全局 `dsh` 命令）与 **桌面安装版**（Electron 应用，如 `DeepSeek Harness.exe`）。桌面版的差别集中在第 2.2 与 3.3 节。

## 一键安装（只想要结果的话看这一节）

**双击 `deploy-offline.cmd`**，然后按提示按一下回车关窗口。就这样——不需要打开终端，不需要记参数，不需要 `-ExecutionPolicy`。

> **如果拿到的是 `octopus-oneclick-<版本>.zip`**，那是**单文件形态**：里面只有一个 `deploy.cmd`，解压后双击它即可，本指南其余部分都不用看。它内嵌了与这里**逐字节相同**的安装器，所以做完的事完全一样，参数也同名（`-DryRun` / `-Profile` / `-Uninstall` / `-Force` / `-DshHome`）。单文件形态为什么是 `.cmd` 而不是 `.ps1`，见下面那条说明。

它做的事和下面的 `install-offline.ps1 -Yes` **完全一样**（同一份安装逻辑：备份 → 复制 → 写两处挂载项 → 逐文件校验 → 失败整体回滚），只是替你补齐了三件鼠标操作容易漏的事：

| 鼠标操作的坑 | `deploy-offline` 怎么处理 |
| --- | --- |
| 右击/双击**不传任何参数** | 自动补上 `-Yes` 与 `-Profile all`（装进所有已存在的 profile） |
| 工作目录不是包目录（Explorer 从 `C:\Windows\System32` 起进程） | 一切路径从脚本自己所在的目录解析，并用绝对路径传下去 |
| 窗口在进程退出瞬间**关闭**，来不及看结果 | 成功和失败都会停住等你按回车 |

> **关于「右键 → 使用 PowerShell 运行」**：菜单里有这一项时，右击 `deploy-offline.ps1` 同样可用（它就是上面那个 `.cmd` 所调用的脚本）。但**有些机器根本没有这一项**——实测本机就是：`assoc .ps1` 报 `File association not found`，注册表里搜不到 `Microsoft.PowerShellScript.1` 这个 ProgId，右击 `.ps1` 只有编辑器选项。这种机器上请用 `.cmd`，或者命令行：
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-offline.ps1
> ```
>
> 顺带一句：`.cmd` 里已经写死了 `-ExecutionPolicy Bypass`，所以即使组策略把 `LocalMachine` 设成 `RemoteSigned`（本机就是这样）、脚本还带着"从网上下载"的标记，也照跑不误。

可加的参数（加在 `.cmd` 后面即可）：

```bat
deploy-offline.cmd -DryRun              :: 只打印计划，一个字节都不写
deploy-offline.cmd -Profile web         :: 只装 web 这一个 profile
deploy-offline.cmd -Uninstall           :: 反过来：把插件从 profile 里摘掉
deploy-offline.ps1 -DshHome D:\tmp\dsh  :: 装进另一个 home（演练用）
```

**装完还有一件脚本不能替你做**：如果用的是桌面应用，**从托盘图标退出它，再重新启动**——插件在**下一次启动**时才加载，而安装脚本**绝不**去杀你正在用的宿主（那会丢正在做的事）。重启后右侧栏就会多出「作业区」页签、起始页卡片和 `Ctrl+Alt+S`。

## 1. 包里有什么

| 路径 | 作用 |
| --- | --- |
| `deploy-offline.cmd` | **双击入口**：调用 `deploy-offline.ps1`，不需要参数，自带 `-ExecutionPolicy Bypass`，结束时停住窗口 |
| `deploy-offline.ps1` | 一键部署包装：定位包、补参数、失败时报清楚原因；菜单支持时右击 → 「使用 PowerShell 运行」也可以 |
| `install-offline.ps1` | 真正的安装器（也是脚本化/可审计的入口）：把插件装进 DSH profile（默认**所有**已存在的 profile），并写好两处挂载项；装前备份、装后校验、失败整体回滚 |
| `uninstall-plugin.ps1` | 卸载（纯文件操作，不依赖 `dsh` 能否启动） |
| `package/` | 已经构建好的插件包（`lib/`、`src/`、`package.json`、`dsh.plugin.json`、`cordis.patch.yml`、`README.md`、`LICENSE`） |
| `dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz` | 同一份产物的 npm tarball（内网若有 registry 或已有 pnpm 缓存，也可以走官方 `dsh plugin add`） |
| `SHA256SUMS.txt` | 上面每个文件的 SHA256，安装脚本会拿它逐文件核对 |
| `INSTALL-OFFLINE.md` | 本文件 |

插件本身**零运行时依赖**（`package/package.json` 的 `dependencies` 为空），它的 `peerDependencies`（`@deepseek-ai/dsh-*`、`react`）全部由 DSH 自己的安装提供——所以离线安装不需要解析任何依赖树，这也是"复制目录 + 写两处挂载项"就能与官方安装结果一致的原因。

## 2. 前置条件

### 2.1 通用

1. **这台机器上已经装好 DSH**，版本要落在插件声明的兼容范围内：

   ```
   ^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2      即 0.1.7-rc.1 <= 版本 < 0.3.0
   ```

   已在 **0.1.7-rc.2**、**0.2.0-rc.1**，以及桌面安装版 **0.2.0-rc.2** / **0.2.1-rc.2** 上实测（两个桌面版都跑过真实宿主冒烟，全绿）。

2. **至少一个 profile 已经成形**：`${DSH_HOME}\profiles\<profile>\package.json` 必须存在。全新机器上先让 DSH 自己建好 profile——命令行版跑一次 `dsh web --port 0 --no-open`（起来后 Ctrl+C 停掉），桌面版**启动一次应用**即可（它会创建自己的 profile）。

3. **`DSH_HOME`**：默认 `%USERPROFILE%\.dsh`；如果你设了 `$env:DSH_HOME`，脚本会自动跟随（也可用 `-DshHome` 显式指定）。**桌面版也用同一个默认 home**（实测：桌面应用的 profile 就在 `%USERPROFILE%\.dsh\profiles\` 下）。

4. **PowerShell 5.1 即可**（Windows 自带）；脚本输出刻意保持纯 ASCII，中文只在文档里。

> **本包不包含 DSH 本身**。内网机器还没装 DSH 时，需要先另行准备 DSH 的离线安装（那是另一套依赖树），本包只负责把插件挂上去。
>
> 版本不匹配时**必须拒绝安装**：不匹配的 bundle 会在启动时被 DSH 的 `reportSkippedBundles` 静默跳过——界面表现是页签凭空消失，而日志里**没有**任何插件报错。`install-offline.ps1` 因此会先探测版本，探测不到或超出范围就停下（确实要装时用 `-Force`）。

### 2.2 桌面安装版（Electron 应用）要额外知道的事

1. **它自带一整套运行时**：`<安装目录>\resources\runtime\` 下有 `cli\bin\dsh.cmd`（DSH 自己的 CLI）、`bin\node.exe`（0.2.1-rc.2 实测 Node 24.21.0）、`pnpm\`（pnpm 11.28.5）。所以**不需要**另外装 Node / pnpm / 全局 `dsh`。

2. **查版本要用它自带的 CLI，不要用 PATH 上的 `dsh`**：机器上可能同时存在一个旧的全局 CLI（实测：桌面版已是 `0.2.1-rc.2`，而 PATH 上的 `dsh` 还是 `0.2.0-rc.1`）。正确查法：

   ```powershell
   & "C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version
   # 备选：读应用自己的版本戳
   (Get-Item 'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe').VersionInfo.FileVersion
   ```

   `install-offline.ps1` 会两条路都试，并把**每个**探测到的 DSH 安装连版本、来源一起打印出来。

3. **它管理的 profile 和它启动的 profile 不一定是同一个**：实测这台机器上，应用创建并**独占管理** `profiles\desktop`（CLI 碰它会直接拒绝：`profile "desktop" is managed exclusively by the Electron application`），而它真正启动的会话组合的却是 `profiles\web`——插件挂在 `web` 里，作业区就出现在桌面应用里。**所以默认 `-Profile all`**：哪个 profile 被启动都命中。

4. **装之前先退出应用**（含托盘图标）：应用运行中会持续改写自己的配置，退出后再装最干净。安装脚本**绝不**替你重启任何宿主。

5. 内网机器上的安装目录可能不是 `C:\Program Files\DeepSeek Harness`。脚本按"正在运行的应用进程命令行 → 常见安装根目录 → `-DshInstall <目录>`"的顺序找，找不到就是**读不到版本**（此时它会拒绝安装并提示 `-Force`），不会拿错版本硬装。

## 3. 安装

### 方式 A（推荐）：离线安装脚本

一键双击（见本文开头）调用的就是这一节。要自己敲参数时，把整个包目录拷到内网机器上，然后在**包目录**里执行：

```powershell
# 先看计划，不写任何东西
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DryRun

# 真正安装（默认装进所有已存在的 profile）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes

# 只想装某一个 profile
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Profile desktop -Yes
```

它会依次做这些事（每一步都打印 `PASS`/`FAIL`）：

1. 读 `package/package.json`，确认包完整（`lib\index.js`、`lib\client.js`、`lib\client-registry.js`、`lib\invariant.js`、`dsh.plugin.json`、`cordis.patch.yml` 一个都不能少）；
2. 列出目标 profile（默认 = `profiles\` 下所有带 `package.json` 的目录）；
3. 探测 DSH 安装与版本并判定兼容性（不通过就拒绝，除非 `-Force`）；
4. 对每个 profile：**先备份**它的 `package.json` 到 `profiles\<profile>\octopus-offline-backups\<时间戳>\`；
5. 复制 `package/` → `profiles\<profile>\node_modules\dsh-octopus-operation-space\`（若已装过旧版，旧目录被改名保留为 `…replaced-<时间戳>`，而不是直接删掉）；
6. 写**两处**挂载项：`dependencies["dsh-octopus-operation-space"]`（`file:` 指向包里的 tarball）**和** `dsh.profile.bundles[]`（已有则不重复追加）；
7. 逐文件比对 `SHA256SUMS.txt`，回读 `package.json` 确认两处挂载项各出现**恰好一次**；
8. 任何一步失败：**所有**本次动过的 profile 一起回滚——还原清单、还原被替换的旧目录、清掉半成品，然后以失败退出。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-DryRun` | 只打印计划，不落盘 |
| `-Yes` | 不再交互确认 |
| `-Profile <名字\|all>` | 默认 `all`（所有已存在的 profile） |
| `-DshHome <目录>` | 指定另一个 DSH home（也是脚本自己的演练入口） |
| `-DshInstall <目录>` | 显式指定桌面应用的安装根目录（自动探测失败时用） |
| `-Force` | 版本探测无法确认兼容时仍安装 |

### 方式 B：官方 CLI

命令行安装版：

```powershell
dsh plugin --profile web add file:D:/path/to/dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz
```

桌面安装版（用它自带的 CLI；把 `<profile>` 换成 `desktop` 或 `web`）：

```powershell
& "C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add file:D:/path/to/dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz
```

这条路与联网安装完全一样；它需要 pnpm 能解析（至少要从 registry 取元数据）。内网**没有** registry 时请用方式 A——尤其**新机器**上 profile 里还没有任何依赖，pnpm 没有本地元数据可用，官方命令会卡在网络这一步。

### 方式 C：手工两步（脚本被策略拦住时的兜底）

1. 复制目录：`package\` → `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-octopus-operation-space\`
2. 编辑 `%USERPROFILE%\.dsh\profiles\<profile>\package.json`，**两处都要写**：

   ```jsonc
   {
     "dependencies": {
       "dsh-octopus-operation-space": "file:D:/path/to/dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-octopus-operation-space"
         ]
       }
     }
   }
   ```

   > **只写 `dependencies` 不写 `bundles`＝什么都没挂上；只写 `bundles` 不写 `dependencies`＝profile 要求加载一个它找不到的包，下次启动直接失败。** 这两处必须同时存在（AGENTS.md §2）。
   >
   > 写文件时用 **UTF-8 无 BOM**（Windows PowerShell 5.1 的 `-Encoding UTF8` 会写 BOM）。`install-offline.ps1` 走 .NET 写入就是为了避开这一点。

## 4. 安装后怎么验证

1. **重启宿主**（安装脚本**绝不**替你重启：装好只在下次启动生效，杀掉正在跑的宿主会丢掉用户手上的事）：
   - 命令行版：停掉再起 `dsh web`；
   - 桌面版：**从托盘退出应用**（关窗口常常只是隐藏），确认没有残留进程后再启动。
2. 侧边栏应出现「章鱼作业区」页签；内置起始页出现同名卡片，带说明文字与快捷键 **Ctrl+Alt+S**（macOS 是 ⌘⌥S）。
3. 宿主日志里应当**没有** `loader` / `inject` / `duplicate prefix route` 之类的失败行。桌面版的日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`。
4. 打开页签，放一份 `*.dsh-octopus` 清单到会话工作目录，或在面板里粘贴清单路径；随后应看到按权限分组的根目录列表。
5. **模型侧**（{{PLUGIN_VERSION}} 新增）：新开一个会话，直接说「看一下 &lt;某个标签&gt;」——标签表已经随每轮请求进入模型上下文，模型应当**直接**把它解析成绝对路径，不需要先试探；需要绝对路径时它会调用 `octopus_space` 工具。

> 页签没出现时的自查顺序：① 应用是否真的重启了（托盘退出）；② 应用启动的**是哪个 profile**——不确定就重跑安装脚本（默认 `all`），或者 `-Profile <那个 profile>` 再装一次；③ profile `package.json` 里那两处是否都在（`cordis.yml` 的**内容不能**用来判断，它每次启动都被无条件重写）。

## 5. 升级

把新的离线包解开，用同样的命令再跑一次即可：脚本会替换 `node_modules` 里那份并保留旧目录、重新备份清单、重新校验哈希。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes
```

装完确认 `-DryRun` 输出里的 `package` 版本是你期望的那个，然后重启宿主。

## 6. 卸载与回滚

```powershell
# 推荐：纯文件操作，不依赖 dsh 能否启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-plugin.ps1 -Yes

# 彻底回到安装前：把备份的清单放回去（对每个装过的 profile 都做一遍）
Copy-Item '%USERPROFILE%\.dsh\profiles\web\octopus-offline-backups\<时间戳>\package.json' `
          '%USERPROFILE%\.dsh\profiles\web\package.json' -Force
```

> 卸载脚本**不会**回滚插件界面改动过的 `.dsh-octopus` 清单文件——那些文件在用户自己的项目目录里（旁边留有 `.octopus-backup` 时间戳备份），不在 profile 里，任何卸载工具都不该替用户改它们。

## 7. 已知坑（都踩过）

- **不要用 PATH 上的 `dsh` 判断桌面版的版本**：机器上可能并存一个旧的全局 CLI（实测差一个 rc）。桌面版请用它自带的 `resources\runtime\cli\bin\dsh.cmd --version`。
- **桌面版的 `profiles\desktop` 是应用独占的**：`dsh plugin` 命令对它直接报 `managed exclusively by the Electron application`。这不影响本包的纯文件操作安装（脚本只改 `package.json` 与 `node_modules`，实测应用启动时不重写这两个），但**官方 CLI 方式要挑应用实际启动的那个 profile**。
- **应用升级后建议重跑一次安装**：应用可能会重建自己管理的 profile，挂载项随之消失（表现同样是页签消失、日志无报错）。
- **安装前退出应用**：应用运行中会持续改写配置；退出后再装，避免写入竞争。
- **不要用通配 `-Filter` 去清 profile 目录**：PowerShell 5.1 的 `-Filter 'package.json.*'` 会因 8.3 短名匹配连 `package.json` **本身**一起命中。删掉它之后 `dsh plugin remove` 会把该 profile 当成新 profile 重新初始化，本插件的挂载项随之消失。
- **`cordis.yml` 的内容不代表挂载状态**：它每次启动都被无条件重写（正常内容就是注释 + 空 `[]`）。判断插件是否挂载只认 profile `package.json` 的那两处。
- **不要用 HTTP 探测判断插件在不在**：DSH 对未知 POST 一律回 `405`、未知 GET 回 `404`，与插件是否加载无关（0.2.1 起还要求浏览器凭据：**不带凭据一律 `401`**）；认 profile 清单。
- **不要把 `dsh web` 的进程杀掉再"重启"**：如果你手上还有未完成的会话，那会一并丢掉。
- **不要改 DSH 自己的安装**：本插件是独立包，靠 profile 引用挂载，不侵入 DSH。

## 8. 完整性校验

```powershell
# 在包目录里，逐文件核对（与安装脚本用的是同一份清单）
Get-Content .\SHA256SUMS.txt |
  ForEach-Object { if ($_ -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$') {
      $want = $Matches[1].ToUpper(); $file = $Matches[2]
      $got = (Get-FileHash $file -Algorithm SHA256).Hash
      "{0}  {1}" -f $(if ($got -eq $want) { 'OK  ' } else { 'BAD ' }), $file } }
```
