# dsh-octopus-operation-space 仓库规则（AGENTS）

> 面向贡献者与 agent 的**项目全局规则**。逐特性设计史见 [docs/plans/](docs/plans/)；被移除的功能（整个侧边栏工作台）的历史在 git tag `archive/sidebar-workbench`。
>
> 本仓库是**单功能包**：给 DSH 内置右侧栏加一个多根作业区页签。其余一律不做——不含查看器、终端、Git、浏览器、文件变动等。

---

## 1. 仓库硬约束（必须遵守）

- **禁止修改 DSH 源码**：对官方 checkout 零写入。
- **代码改动走 `feat/*` / `fix/*` 分支**；纯文档改动（README / AGENTS.md / docs/）可直接进 main。
- **挂载只走 `cordis.patch.yml` + profile 机制**（`$DSH_HOME/profiles/<profile>/`）：插件作为独立包被 profile 引用，不反向侵入 DSH。
- **市场受管安装约束**：`dependencies` / `peerDependencies` / `optionalDependencies` **一律不得出现 `cordis`**（按名硬拒，optional 无效）；`scripts` 不得含 `preinstall` / `install` / `postinstall` / `prepare`。
- **保持零运行时依赖**：`dependencies` 为空；客户端只消费 DSH 冻结模块表里的平台模块，由宿主在挂载时注入。
- **平台 peer 范围是一次兼容性声明，平台升级时必须一起改**：7 个平台包（`dsh-client-locale` / `dsh-client-ui-primitives` / `dsh-client-ui-sidebar-right` / `dsh-host-webserver` / `dsh-invariants` / `dsh-session` / `dsh-tools`）的 peer 范围要同时接受 `^0.1.7-rc.1` 与 `^0.2.0-rc.1`。**0.x 上的 caret 锁小版本**：`^0.1.7-rc.1` = `>=0.1.7-rc.1 <0.2.0`；而且 semver 要求"带预发布的版本必须命中一个 `major.minor.patch` 相同、且自身也带预发布的比较符"，所以 `>=0.1.7-rc.1 <0.3.0` 这类写法**照样匹配不上** `0.2.0-rc.1`——只有 `^0.2.0-rc.1` 这种同元组带预发布的比较符才行。DSH 在**安装时**按这份范围判定（不匹配即拒绝：`installation rejected: Plugin … is incompatible with dsh …`，并给出 `dsh plugin allow-version … --accept-risk` 的豁免入口），已装上的不匹配 bundle 则在启动时被 `reportSkippedBundles` **跳过并报告**——界面表现是页签凭空消失、日志里没有任何插件报错。放宽范围**必须先拿到实测证据**（客户端符号/服务名静态核对 + `scripts\smoke.ps1` 在目标运行时上全绿），不能凭"应该没改"就改。

---

## 2. 门禁（提交前必须全绿）

```bash
pnpm typecheck   # tsc --noEmit：宿主 + 客户端 + 测试 + 配置
pnpm test        # vitest
pnpm build       # tsc 声明 + tsdown 三份产物
pnpm lint
```

**构建纯度门**：client bundle 禁止 value-import 非白名单 `@deepseek-ai/*`（`tsdown.config.ts` 的 `purityGatePlugin` 拦截）；`import type` 被擦除不触发——类型可共享，运行时符号不行。跨包协作只能走 cordis 服务或平台模块表。

**真实挂载冒烟**（改动宿主入口 / 清单解析 / 路由 / 包清单后至少跑一次）。**一条命令跑完**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1
```

`scripts/smoke.ps1` 做的事：打包 → 装进**全新临时** `DSH_HOME` → 起真实宿主（`--port 0`）→ 写 BOM-less 测试清单 → 打一组 HTTP 探针（含 `workspace.addFolder` 与 `workspace.setFolderAccess` 的每一个分支：无激活 403、非目录／缺路径／未知权限 400、不是本作业区的根／未声明的隐含根 400、真实追加 200 + 相对路径落盘 + 侧车备份 + 幂等 `added:false` + 重新激活后快照已含新根、权限改写 200 + 侧车备份 + 快照里的权限已翻转 + 幂等 `changed:false` 不写盘、移出 200 + 侧车备份 + 快照里那条已消失 + 再次移出 400）→ 按**监听端口**回收宿主进程并删临时目录。退出码 0 = 全过；它**绝不触碰用户真实的 `~/.dsh`**。

手工等价步骤（脚本不可用时）：

```powershell
pnpm build; pnpm pack
$env:DSH_HOME = "$env:TEMP\dsh-smoke-$(Get-Random)"   # 绝不碰用户真实的 ~/.dsh
dsh plugin --profile web add file:<tarball 绝对路径>
dsh web --port 0 --no-open                            # 用 0 端口，别占用户正在用的 GUI
```

> `dsh web` **本身就是** `--profile web`：再显式传一次会被拒（`select a profile only once`）。
>
> 写临时清单文件**不要用 PowerShell 的 `-Encoding UTF8`**——PS 5.1 会写 BOM，JSON 解析直接失败（表现为 `workspace.activate` 返回 400）。用
> `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`。
>
> **PS 5.1 的四个实测陷阱**（写这类脚本必踩，前两个已在 `smoke.ps1` 里绕开）：`[string](Get-Content $f -Raw)` 对**空文件**仍是 `$null`，`.Trim()` 直接硬报错；`$ErrorActionPreference = 'Stop'` 下把原生命令的 stderr 用 `2>&1` 并入管道**或** `2> file` 重定向，都会被当成终止性 `NativeCommandError`，必须局部降到 `Continue` 才能正常捕获；**`$PSScriptRoot` 在 `param()` 的默认值里是空的**（只在脚本体里可靠），`[string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist')` 直接抛 `Cannot bind argument to parameter 'Path' because it is an empty string`——默认值必须挪到脚本体里算，并用 `$MyInvocation.MyCommand.Path` 兜底；`… | Select-Object -First 1` 会**提前掐断上游管道**，被掐断的命令（git / pnpm）以非零码退出，`$LASTEXITCODE` 随即失去"它成功了"的含义（实测让离线包指南里的 commit 变成 `unknown`）——要取首行先落变量，并且**用 `@()` 强制成数组再索引**：只返回一行时结果是**一个字符串**，`$output[0]` 在字符串上取到的是**首字符**（实测同一处又变成 `e`）。
>
> **`.ps1` 里的输出字符串必须保持纯 ASCII**：无 BOM 的 UTF-8 脚本会被 PS 5.1 按系统 ANSI 码页（本机 GBK）读取，`…` / `──` 这类字符经 `Write-Host` 直接变成 `鈥?`。注释里的乱码看不见（`smoke.ps1` 的中文注释就是如此），但**用户会看到输出乱码**——`deploy.ps1` 因此刻意写成纯 ASCII。
>
> **整文件重写先设护栏**：`String.Replace(char, char)` 吃不下 `'...'` 这类多字符参数，抛出的异常会让结果变量变成 `$null`，紧接着的 `WriteAllText($path, $null, …)` 会把文件**清空**（本仓库真实发生过一次，靠会话转录重放 edit 才恢复）。改写整个文件前先校验长度下限与关键标记，并先落暂存文件、解析通过后再覆盖。

判据：脚本全 PASS。等价的手工判据是：宿主走到就绪行、日志无 loader / inject / `duplicate prefix route` 失败、各路由状态码符合预期、冷会话不 500。**客户端渲染需要浏览器自动化**（`@playwright/test` 已随工作台移除），没有它就不要声称验证了页签渲染——`tests/client-tab.spec.ts` 只锁注册与文案，不锁渲染。

> **客户端启动事故没有任何自动门禁能拦住它。** 实测（0.3.1）：把 `shortcuts`／`sidebarRight` 加进客户端入口的**插件级 `inject` 数组**之后，**DSH 整个起不来**——宿主 HTTP 冒烟全 PASS 也照样发生（它只探宿主，不看浏览器）；而且 `git reset --hard` 也救不回来，因为**插件已经装进 profile**，只能先把插件摘掉。因此两条硬规矩：(1) 客户端入口的 `inject` 数组由 `tests/client-tab.spec.ts` 用**精确相等**断言写死，动它之前必须先有启动验证手段；(2) 任何时候都能用恢复脚本把插件从 profile 里摘掉，它**不依赖 dsh 能否启动**（纯文件操作，不重启宿主）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-plugin.ps1 -DryRun   # 先看计划
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-plugin.ps1 -Yes      # 真摘
```

> 插件**改动过的清单**（§3.13）不在 profile 里，卸载脚本不会也不能替用户回滚它们：脚本的最后会打印这条提示，告诉用户备份在哪、怎么还原。加了新的写盘点（比如又写别的文件）时，必须同步这句话。
>
> **挂载项在 profile 的 `package.json` 里，有两个地方**（实测 `dsh plugin add` 写入）：`dependencies["dsh-octopus-operation-space"]` **和** `dsh.profile.bundles[]`。只删前者会让 profile 继续要求加载一个已经不在磁盘上的包——下次启动直接失败，正是这个脚本要防的事故。`-DryRun` + 一次性 `DSH_HOME` 演练（`deploy.ps1 -DshHome <临时目录> -SkipTests -Yes` 后接 `uninstall-plugin.ps1 -DshHome <同一目录> -Yes`）是这两处的门禁，改脚本必须重跑。

**一键部署（真实 profile）**：`scripts/deploy.ps1` 与冒烟互补——冒烟用一次性临时 `DSH_HOME`，部署脚本装进**真实** profile：四道门禁 → 构建打包 → 备份 profile 的 `package.json` 到 `octopus-deploy-backups\<时间戳>\` → **先 `remove` 再 `add`** → 校验依赖与插件清单，并把已安装的 `lib\index.js` / `lib\client.js` 与本次构建逐个做 SHA256 比对 → 打印重启与回滚命令。之所以要先移除：**同版本同路径的 `add` 是 pnpm 的空操作**，实测在真实 profile 上它报成功，而 `lib\index.js` 的 mtime 与内容都还是旧的（没有新路由），只有 SHA256 比对才暴露出来。它**绝不自动重启** `dsh web`：安装只在下次启动生效，而杀掉宿主会丢掉用户正在做的事。

> **`dsh plugin add` 的失败形态是「文件装好了、profile 什么都没挂载」**，脚本按这个形状加固（0.8.0 期间真实踩到一次）：pnpm 会把包装好、lockfile 也更新掉，然后才去**原子重命名** profile 的 `package.json`——而这一步会被瞬时文件锁拒掉（`exit -4048` + `[EPERM] operation not permitted, rename '...\package.json.<随机数>' -> '...\package.json'`）。由于安装路径为了强制真装而**先 `remove`**，挂载项此刻已经没了，于是 profile 留下"字节是新的、却什么都没挂"的状态——**下次启动会静默丢掉页签**。因此：(1) `add` **重试 3 次**（瞬时锁的整个修法就是重试）；(2) 全部失败时用**本次已做的备份**把 `package.json` 还原回去（挂载项必须在 `dependencies` 与 `dsh.profile.bundles` **两处**都在），随后照常以失败退出并明确打印"插件仍然挂着（上一版）"；(3) 旧 tarball **改到成功校验之后**才清——否则被还原的那份 spec 会指向一个刚被删掉的文件。
>
> 这两条分支的演练是**确定性**的：在一次性 `DSH_HOME` 里跑一遍 `deploy.ps1 -DshHome <临时目录> -SkipTests -Yes`，然后开一个后台任务轮询 profile 清单，**等 `remove` 把依赖项删掉之后**再用 `[System.IO.File]::Open($m, 'Open', 'ReadWrite', [System.IO.FileShare]::ReadWrite)` 锁住它（拒绝删除/重命名、允许覆盖写，正是实测那次的形态）→ 重跑部署就会看到 3 次 `-4048` + `[EPERM]`、还原 PASS、退出码 1，而清单里两个挂载项与那份 tarball 都还在；随后 `uninstall-plugin.ps1 -DshHome <同一目录> -Yes` 仍清理得干干净净。
>
> **不要用通配 `-Filter` 去清 profile 目录**：PS 5.1 的 `-Filter 'package.json.*'` 会因 8.3 短名匹配连 `package.json` **本身**一起命中。删掉它之后 `dsh plugin remove` 报 `ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS: project has no dependencies of any kind`，CLI 随即把该 profile **当作新 profile 重新初始化**（实测它把 `bundles[]` 恢复成 base + web-app，所以 **GUI 仍能启动**，但本插件的挂载项没了）。恢复方式就是官方入口：`dsh plugin --profile web add file:<tarball 绝对路径, 正斜杠>`——它会把 `dependencies` 与 `dsh.profile.bundles` 一起写回，**不需要**手工修 `cordis.yml`。
>
> **`cordis.yml` 的内容不代表挂载状态**：它的正常内容就是注释 + 空列表 `[]`，`prepareProfile()`（`dsh/lib/profile-boot-*.js`）在**每次启动时都无条件重写它**，整棵树按"`dsh.profile.bundles` 里的每个 bundle → `cordis.patch.yml` → `--patch` 覆盖层"现场组装。所以里面有没有本插件（初始化时 CLI 曾写进一份 44KB 的展开转储）**都不能用来判断插件是否挂载**——只认 profile `package.json` 的那两处。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1            # 装进 ~/.dsh 的 web profile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Uninstall # 卸载并复核依赖已移除
# 全流程演练（真实执行构建/打包/安装/校验，但目标是一次性 home，不碰真实 profile）：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -DshHome "$env:TEMP\dsh-deploy-test" -SkipTests -Yes
```

`-SkipTests` 跳过四道门禁，`-SkipBuild` 复用现有 `lib/`，`-DryRun` 只打印不落盘，`-Yes` 免确认。`-DshHome` 同时是它自己的测试入口。

**内网离线部署包**：`scripts\make-offline-package.ps1` 生成 `dist\offline\octopus-offline-<版本>\`（外加同名 zip，0.5 MB 量级；`dist` 已在 `.gitignore` 里，产物不入库）。包内是：已构建好的 `package\`（严格按 `package.json` 的 `files` 镜像，**另外显式补上 `package.json` 本身**——npm 总是隐式包含它，而安装脚本与 DSH 都要读它）、同一份产物的 tarball、`scripts\offline\install-offline.ps1`、`scripts\uninstall-plugin.ps1`、渲染好的 `INSTALL-OFFLINE.md`（`{{PLUGIN_VERSION}}` / `{{DSHWS_COMMIT}}` / `{{BUILT_AT}}` 由脚本替换，渲染后校验"没有残留占位符 + 长度下限"）、以及逐文件 `SHA256SUMS.txt`。**包内所有文件名保持 ASCII**（`Compress-Archive` 在 PS 5.1 下按系统码页写名字，中文文件名会在解压侧乱码），中文只出现在文档内容里。

`install-offline.ps1` 是**纯文件操作**的安装器，不需要 npm / pnpm / 任何网络：读 `package\package.json` 确认包完整 → 备份 profile 清单到 `octopus-offline-backups\<时间戳>\` → **探测 DSH 版本**（从 `Get-Command dsh` 的位置往上找 `@deepseek-ai/dsh/package.json`，按 `^0.1.7-rc.1 || ^0.2.0-rc.1` 即 `[0.1.7-rc.1, 0.3.0)` 判定；不匹配或读不到就**拒绝**并提示 `-Force`，因为不匹配的 bundle 只会被 `reportSkippedBundles` 静默跳过）→ 复制 `package\` 进 `profiles\<profile>\node_modules\<name>\`（旧目录改名保留为 `…replaced-<时间戳>`，而不是直接删掉）→ 写**两处**挂载项 → 逐文件比对 `SHA256SUMS.txt` 并回读清单 → 任何失败还原清单、还原旧目录、清掉半成品。它**绝不重启宿主**，profile 不存在时也**不会凭空造一个**（要求先让 DSH 自己把 profile 建好）。纯文件操作为什么在这里是忠实的：本包零运行时依赖、peer 全部由 DSH 自己的安装提供，而官方安装后 `profiles\<profile>\node_modules` 里也只有插件本体一个**真目录**（实测），所以"复制目录 + 写两处挂载项"与 `dsh plugin add` 的结果结构一致——离线包里的 `lib\index.js` / `lib\client.js` 与已部署并 SHA256 核对过的那次构建**逐字节相同**。

> **离线安装器的演练是确定性的**（改它就重跑）：`install-offline.ps1 -PackageDir <包>\package -DshHome <临时目录> -Yes` → 断言两处挂载项各自出现**恰好一次**、安装版本正确、装后的 `lib\index.js` 与包内哈希相同、备份目录已建；**再跑一次**（升级分支）断言 bundles 里仍只有一条且 `.replaced-*` 已被清理；然后**篡改包副本里的一个字节**重跑，断言脚本失败、清单**逐字节还原**、上一份能用的安装被还原、挂载项没有重复；接着 `uninstall-plugin.ps1 -DshHome <同一目录> -Yes` 断言两处挂载项消失而基座 bundle（`@deepseek-ai/dsh-web-app`）存活；最后对一个没有 profile 的 home 断言拒绝且不新建 `profiles\`。夹具用**真实 profile 清单去掉本插件那两条**（而不是手写 JSON），这样"未挂载"的起始态与现场一致。

> **CI 与发布自动化已随工作台一并移除**（`.github/` 不在本包内）。需要 CI 时重新添加；当前发版是手动步骤。

---

## 3. 本包的 DSH 契约要点（对 0.1.7-rc.2 与 0.2.0-rc.1 实测所得）

1. **页签注册**：`ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`，页体与标题分别注册进座位 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，且必须经 `ctx.slots.inject(key, cb)` 包一层以等待座位声明。服务名是 `sidebarRightTabs`。**这个服务还必须写进客户端入口的 `inject` 数组，不能只在 `apply` 里用 `ctx.get` 探测**：提供方 `ui-sidebar-right` 自己的依赖更长（`slots`/`layout`/`locale`/`resources`/`sessions`/`uiSession`/`shortcuts`），cordis 会先激活依赖更少的本插件，探测于是拿到 `undefined`，`registerMultiRootTab` 直接返回 no-op 并且**永不重试**——表现为页签根本不出现，而控制台与宿主日志里**一句报错都没有**（真实踩过）。DSH 所有内置插件都把它列为依赖。`tests/client-tab.spec.ts` 锁定这一条。**同一个陷阱还有两种形态，都已实测踩过**：(a) 读**未声明**的服务属性，cordis 4.0.4 **直接抛错**（`cannot get property "shortcuts" without inject`）——`ctx.get(name)` 是唯一无需声明就能用的取法，缺失时返回 `undefined` 而不抛错；(b) 反过来，把服务名加进**插件级 `inject` 数组**同样可能致命：本包是从 **profile patch 层**挂载的外部插件，声明基础 bundle 里某个 plugin 提供的服务（如 `shortcuts`）会让 **DSH 起不来**（0.3.1 实测，只能重装 DSH），而内置右侧栏在 **bundle 内部**做同样的事却没事（`ui-sidebar-right/lib/client.js:9015` 确实声明了 `shortcuts`）。结论：`inject` 数组只放**已经依赖过的提供方**（本包：`slots`／`sessions`／`locale`／`sidebarRightTabs`），其余服务一律 `ctx.inject(['name'], cb)` 包装 + 回调里 `ctx.get('name')` 读取。
2. **打开文件只能委托**：`ctx.sidebarRight.openResource(address, { params: { line? } })`。内置文档预览是**唯一**认领文件地址的页类型，其 `canOpen` 是 `parseFileAddress(a)?.scope === 'session'`——**`absolute` scope 无人认领，调用会抛错**。因此地址必须用 `session` scope 携带绝对路径（清单声明的会话根之外目录同理）。
3. **没有可嵌入的查看器**：`renderSlot` 只发给在自己 `register` 里声明了 `children` 的注册者，第三方无法把内置查看器挂进自己的页签。要么委托打开，要么自己实现渲染——本包选前者。
4. **`ctx.remote.session.openWorkspacePath` 不是查看器**：它交接给操作系统的默认程序 / 文件管理器，DSH 界面里什么都不渲染。本包不使用它。
5. **图标来自 `@deepseek-ai/dsh-client-ui-primitives`**（平台模块表内）。其导出按**粗细**命名（`…Regular` / `…Medium`），不是尺寸后缀——0.1.2 时代的 `IconFolderOpen16` 在 0.1.7 已不存在。**平台没有任何锁形图标**：279 个导出里 `Lock` 只匹配到 `Clock`。因此只读小锁是内联在 `src/client/root-markers.tsx` 里的 codicon `lock` 路径（16 网格，CC-BY-4.0，署名随源码与产物一起交付），读写的开锁标记是**同一套 codicon 的 `unlock` 路径**（同网格、同 even-odd 写法、同一份署名与来源，两个图标一起署名）——它原本来自 `react-icons/vsc`，而那是**运行时依赖**，随本包收敛为零运行时依赖一起被移除，当时临时换成的 `PermissionIconReadOnlyRegular`（**盾牌+对勾**）/ `PermissionIconFullAccessRegular`（**盾牌+感叹号**）读起来是两种不同的告警而不是同一种权限状态，已弃用。路径标记用 `IconInfoOutlineRegular`（圆圈 i）：它是**标注**而不是告警——平台把圆圈感叹号（Warning）和圆角三角（WarningTriangle）都留给真正的故障语汇，而这一行什么都没出错，只是有个值得一读的绝对路径。
6. **i18n 命名空间 `octopus`**：`zh` 是键的唯一事实来源，`en` 由 `Record<CopyKey, string>` 在编译期强制对齐（漏键即类型错误）。没有第三语言覆盖层。
7. **悬停气泡用平台 `Tooltip`，它不需要 Provider**：`TooltipSuppression` 的内联默认值就是 `createContext(null)`，19 个内置插件都直接锚定它（声明 Provider 的插件数为 0）。两个必须记住的点：(1) **`portal: true` 是必需的**——根目录列表在 `overflow: auto` 容器里滚动，非 portal 的气泡会被该容器裁掉；(2) `label` 只接受字符串或返回字符串的函数，而 Windows 路径没有断行点，所以只在**展示用**的 label 里按分隔符插入零宽空格以便折行——行的 `title` 与任何会被当作路径复用的字符串都保持原样。改客户端图标或气泡后，`tests/root-markers.spec.tsx` 会先于浏览器渲染亮红。**行的排布也是契约**：小锁（`RootPermissionToggle`）是**行按钮之外的一个真 `<button>`**，紧贴名字——按钮不能嵌套（非法 HTML，且行按钮的点击是展开目录），所以它不能像早期那样待在行按钮内部；行按钮因此改成**内容宽**（`flex: none`），紧随其后放一个空的 `flex: auto` shim，把"点行右侧空白仍然展开目录"这一行为保回来（shim 是 `aria-hidden` 装饰层，真控件的名字与 `aria-expanded` 不变）。**两种权限都画标记**（由 `Padlock` 的 `open` 决定：只读=闭合锁、读写=开锁）——早先"读写根不留任何权限标识"的决定已被"小锁同时就是切换开关"取代，那条旧不变量别再改回去。圆圈 i（ⓘ）是行的**最后一个**元素——它排在桌面动作的固定槽位**之后**（那个动作必须是真 `<button>`，不能嵌进行按钮里），槽位无论动作是否显示都占宽，所以悬停时 ⓘ 不会左右跳；又因为它落在行按钮**之外**，点它不会误触目录展开。**行尾这一段的间距由行容器统一承担**：容器 `gap: 6px` + `padding-right: 10px`（`box-sizing: border-box`，否则整行会溢出 10px），行按钮自己**不带**右内边距，于是"桌面动作 + ⓘ"这一对和内置行的内容一样收在距行右缘 10px 处；标记本身（小锁、ⓘ）**一律不带自己的外边距**，间隔只由这一层负责——小锁曾经因为自带 `margin-left: 6` 而与名字相距 12px。
8. **桌面交接是我们自己做的，而且必须无 shell**：内置 open-in-app 的目录入口绑在**会话 cwd** 上，Windows 上落到 `explorer.exe "file:///…"`，而且 runner 写死 `windowsHide: true`——**实测窗口会被建出来但不可见**（同一 URL：`windowsHide:true` → `IsWindowVisible=False`，`false` → `True`），所以它返回 200、日志干净，用户却什么也看不到。作业区恰恰是 cwd 之外的目录，所以 `workspace.reveal` 自己 spawn：**绝不拼命令字符串**（永远传 argv）、**`windowsHide: false` + `detached`**。Windows 的 argv 只认**纯宿主路径**：目录 → `explorer.exe <path>`；文件 → `/select,<path>` 放**同一个** argv 元素。两条实测禁区——**file URL 形式**（`/select,file:///…`，DSH 自己的写法）在中文路径下会被 Explorer 丢去打开**桌面**；**给路径加引号**会打开**文档**且什么都不选中。路径里含**英文逗号**时无法选中（`/select,` 按逗号切分参数），此时降级为打开**所在目录**。Explorer 的退出码 1 = 已交棒给桌面进程（与 `dsh-native-command` 同语义），超时同样算成功并 `unref`（那说明 explorer.exe 自己变成了 shell）。围栏复用**读围栏** `ensureWsReadTarget`（realpath + 声明根包含判定），所以符号链接也偷不出作业区。**测试与冒烟绝不触发它**：成功分支会在跑测试的机器上弹真实窗口——argv 由 `tests/native-reveal.spec.ts` 锁定。人工验证必须同时查**可见性与选中项**：`Shell.Application.Windows()` 会列出**不可见**的窗口登记项（实测 25 条里只有 3 条可见），只数窗口会得出完全错误的结论。
9. **工具注册：`inject` 里必须写 `'tools'`，且 `output { schema, render }` 是强制的**：服务名是 `ctx.tools`（`ToolRuntime`，dsh-tools），`register(definition)` 返回注销器，`ctx.tools` 由 base bundle 挂载。handler 的**第二个**参数才是调用上下文，会话 id 是 `exec.agent?.session.id`（`agent` 可缺——非 agent 调用者没有它，必须自己判空，否则就是替别的会话作答）。**没有 `output` 的定义根本注册不上**（注册期直接 `TypeError`），而 `execute` 的返回值又要被 `output.schema` 校验，最后 `output.render(args, value)` 才把它变成模型看到的文本——三者缺一不可。`parameters` 用原生 JSON Schema 即可：本包不需要 `defineTool` 的 DSL，于是也没有新增运行时 import（零依赖不变）。`octopus_space` 是「清单标签 → 绝对路径」唯一的模型出口，语义改动时它属于四个同步点之一。**它说什么由 `src/workspace-report.ts` 决定**：`snapshotOf` 是客户端线格式（7 条路由与整个页签都依赖它的形状），把它直接序列化给模型就是替 `sessionId` / `cwd` / `activatedAt` 和每个根的 `exists`/`listed` 付费（十根实测：线格式约 385 token，报告约 144），所以工具渲染自己那一份——按权限分组、一根一行、只额外标 `missing`（现在不在磁盘上）与 `implicit`（cwd 的隐含根，清单里没有它的条目）——而模型可见的措辞连同它的规格都在那个模块里，改文案不用碰注册。
10. **`dsh.plugin.json` 的 `contributes` 目前没有任何消费者**：对已安装的整棵 `@deepseek-ai` 树 grep `contributes` 只命中无关的英文注释，且**没有任何 DSH 包自带 `dsh.plugin.json`**，所以 `tools` / `skills` 两个数组保持为空是现状（技能的注册同样不在里面）。别照着自己的想象往里面填 schema。
11. **与内置「工作区文件」的观感一致性有唯一事实来源**：内置那个页签是 `@deepseek-ai/dsh-client-ui-sidebar-files`，它的行样式写在**内联进 bundle 的 CSS module** 里（`lib/client.js` 的 `k-1LKG_*` 块），而行本身用的是平台共享组件——文件行 `FileTypeIcon kind={classifyFileType(name)} size={16}`，目录行 `IconFolderOpenRegular` / `IconFolderCloseRegular`（**Regular 字重、不传 size、颜色取 `--dsw-alias-label-tertiary`**），页头用 `PathLabel`。这些组件**全都在纯度白名单内**（`@deepseek-ai/dsh-client-ui-primitives`），所以"一致"的做法是**同样的零件 + 同样的数值**，不是照着调参凑近。数值集中在 `src/client/tree-metrics.ts`（行 `padding:5px 10px`／`gap:6`／**每层缩进 18px**／body `8px 0 8px 8px` + `scrollbar-gutter:stable`／页头 38px + `.5px` 下边框／工具按钮 28×28 内嵌 15px 图标／note 12px + `3px 10px`），`tests/tree-metrics.spec.ts` 逐项钉住：**内置改了这里就会红**，逼着重读那份 CSS 而不是静默分叉。两处**刻意不同**，别当成 bug 改回去：(1) 内置的悬停来自 `:hover`，而本包拿不到 CSS module，悬停底色改由行已有的 hover 状态绘制；(2) 内置靠嵌套 `<ul>` 缩进，这里是扁平列表，按深度乘同一个 18px。行序照抄内置（目录优先 + `Intl.Collator({numeric:true,sensitivity:'base'})`，见 `src/client/entry-order.ts`）。**像素级一致无法自动断言**（本仓库没有浏览器 lane），只能锁数值与结构，最终必须人眼复核。

12. **开始页卡片与快捷键**：内置右侧栏的起始页（guide 页）从类型定义的 `guide` 条目画卡片——`id`、`commandId`、`order`、`title`、`description`。**`commandId` 必须与真正注册的命令 id 逐字相同**：卡片上的键帽是 guide 拿这个 id 去快捷键注册表里查**生效绑定**得到的，写错一个字符既不报错、也不显示键帽，写成别人的 id 就会显示别人的键。本包 id 是 `octopus.operationSpace`（`COMMAND_ID`，与 `TAB_KIND` 一同放在 `multiroot-tab.tsx`），`tests/client-tab.spec.ts` 锁住这条等式。`description` 只在 guide 条目不算拥挤时才渲染（条目多时 guide 退回只留标题），所以卡片必须靠标题自己站得住。图标是**组件**而不是图片 URL（`entry.icon ?? CubeGlyph`，`ui-sidebar-right/lib/client.js:461`，按 `ComponentType<IconProps>` 以 `size` 22／26 绘制）：平台只出了 `GuideArtworkFiles` / `GuideArtworkBrowser` 两幅插画，本包在 `src/client/guide-artwork.tsx` 里给卡片配了自己的插图——**图片以 data URL 内嵌**（不加宿主路由、不怕图裂，代价是包体积，所以源图居中裁剪到 128×128，`tests/guide-artwork.spec.tsx` 把 base64 长度钉在 1k～40k 之间，防止以后有人往每个客户端加载里塞照片）。**换图必须走生成脚本，不许手改 base64**：`scripts\make-guide-artwork.ps1 -Source <图片路径>`（纯文件操作、ASCII 输出、无 BOM，并会回读校验；它把文件头注释、data URL、组件一起重写，所以注释的唯一事实来源是这个脚本）。插图为装饰性内容：`alt=""` + `aria-hidden="true"`，语义由卡片标题承担；不写任何颜色，皮肤归 shell。

    **服务怎么取见 §3.1**：`shortcuts` 绝不进 `inject` 数组，而是 `ctx.inject(['shortcuts'], () => ctx.effect(() => registerOctopusShortcut(ctx)))` 包装 + 回调里 `ctx.get('shortcuts')`／`ctx.get('sidebarRight')`。这样最坏情况是"没有键帽"，**不会**影响启动——0.3.0 正是如此：注册在延迟回调里抛错，页签与卡片照常工作。

    **绑定是 `Ctrl+Alt+S`（`primary+alt+KeyS`）**。选键位不是审美问题：`register` 会**遍历全部六个 profile** 校验每条已声明的默认值并在不合格时**抛错**（`dsh-client-shortcuts/lib/client.js:590-604`），而抛错发生在**延迟回调**里——于是页签与卡片照常工作，命令却悄悄不在目录里：卡片没有键帽、设置 → 快捷键里搜不到、按键毫无反应、宿主日志也干净。前两次选择都是这样死的，两次都是靠读**已安装的 bundle**（不是靠推理）才定案：

    - `Ctrl+O`：桌面运行时已被内置 `workspace.add` 占用，注册表对重叠默认值直接抛 `Conflicting shortcut defaults`；web 运行时更早拦下——`isWebBindingAllowed` 对一个修饰键的组合只放行 `primary+Comma`／`primary+Backslash`／`control+Backquote`，其余抛 `Unsupported Web shortcut`（内置文件页因此在 web 用 `Ctrl+Alt+P`、桌面用 `Ctrl+P`）；`Ctrl+O` 本身还是浏览器的"打开文件"。
    - `Ctrl+Alt+W`（0.3.0／0.3.2 都已发出）：内置 `dsh-client-ui-sidebar-right` 的 `page.close`（关闭页签）在桌面是 `primary+KeyW`、**在 web 就是 `primary+alt+KeyW`**（`ui-sidebar-right/lib/client.js:274-291`），逐字相同 → 抛 `Conflicting shortcut defaults: octopus.operationSpace and page.close (web:windows)`。那个 `KeyW` 写成**三元表达式**（`code: kind === "close" ? "KeyW" : "KeyR"`，line 275），`code: "KeyW"` 这种 grep 看不到；`dsh-client-ui-workspace` 更把键位当**位置参数**传给本地 `register(...)`。**结论（选键位前必做）：对"已安装树"（`<global dsh>/node_modules/@deepseek-ai/dsh-client-*/lib/client.js`）grep 裸字符串 `"Key<X>"`，不要 grep `code: "Key<X>"`，也不要只搜本仓库的 `node_modules`（那里只有少数几个客户端包）。** `tests/shortcut-binding.spec.ts` 会拿当前安装的 DSH 自动重跑这道扫描。

    `KeyS` 通过了这道扫描（已安装客户端 bundle 里没有任何 `"KeyS"` 绑定；唯一命中是 xterm 的键码枚举文件 `client.terminal.js`，不是绑定）。形状在所有已声明 profile 上都合法：`primary+alt` 正是 web 认的两修饰键形状（`dsh-client-shortcuts/lib/client.js:115`），`KeyS` 不在保留集（`:222-240` 保留 `Escape/Tab/Space/Backspace/Delete/方向键`、不带 Alt 的 `Enter`、`primary+KeyC/V/X/Z/Y/Q/H`、以及不带 Shift 的 `primary+KeyA`），桌面 Windows/macOS 更是直接跳过保留检查（`:216`）。`web:linux` **故意不声明**，与内置文件页一致（web 规则对 Linux 只认极少数组合，声明了就是抛错）。

    **键帽 ≠ 派发。** 起始页的键帽只取自目录行（`ui-sidebar-right/lib/client.js:489`，按 `entry.commandId` 匹配，`:528`），而真正派发走的是另一张表，只有在快捷键配置可用（`config.status !== "loading"`，`dsh-client-shortcuts/lib/client.js:622-623`）时才被填上。现场实测：**内置 `workspace.files` 卡片有键帽、它自己的键按下去也没反应**——所以那条链路的问题在 shell 层，本插件的默认值只决定目录／卡片／设置页显示什么。

    `resolve` 必须用 `ctx.sidebarRight.commandTarget(input.target)` 先捕获"用户此刻所在的那块侧边栏面板"，再 `openTabFromTarget(TAB_KIND, target)`：多个会话同时挂载时凭猜就会开错地方；捕获不到（没有挂载的会话）是带理由的拒绝，不是猜。

13. **右键空白处加文件夹，右键行移出或改权限，点小锁也能改权限**：面板空白处的 `onContextMenu`（先 `preventDefault`，且只在 `event.target === event.currentTarget` 时接管——落在根目录行上的那一次由行自己的 handler 接管，两个 handler 因此不会互相抢）打开平台 `Menu`，用 `portal` + `getAnchorRect` 把 1×1 的矩形当锚点，于是卡片出现在右键点，而不是某个触发按钮上（平台文档正是为这种"自持触发点"提供该属性）。**菜单只有一项，且写死只读**：加入文件夹是授权发生的那一刻，所以不再给"再加一个读写"的第二项（早期两项的版本已收敛），升级改成行上小锁的第二个动作。

    **小锁就是第二个写盘点**，走新路由 `workspace.setFolderAccess`，与加入共用一个事务：客户端只发 `{ path, access }`（`path` 取**快照里已有的** `root.path`，不是用户输入的字符串），宿主在该会话已激活的清单里找**解析后路径一致**的条目——用的是策略建根时的同一个 `resolveFolderPath(raw, baseDir)`，所以清单里的相对路径也能配上；只认**已声明**的根（`root.listed === false` 的隐含 cwd 根一律 400，因为清单里没有条目可以持久化它），找不到条目或多个候选都是明确报错、绝不猜。改写规则：对象条目已有 `"access"` 就**只换那个字符串**，没有就在最后一个成员之后补 `, "access": …`（同样遵守"逗号在有效内容之后"的规则，尾随注释不被吞），**字符串简写条目会被改写成对象形式**并原样保留那个字符串 token；改完的权限永远是**显式**值。权限已经是该级别时返回 `changed:false` 且**一个字节都不写**（也就不留备份）。写完仍用**原 `activatedAt`** 重新激活，所以行上的标记、写围栏与违规扫描的下界同时跟着文件走。

    **选目录不能自己弹窗**：页面拿不到真实路径（`showDirectoryPicker()` 只给 `FileSystemDirectoryHandle`），所以只能走宿主——`ctx.get('uiWorkspace')?.pickDirectory()`（内置 `dsh-client-ui-workspace` 的封装，宿主端能力域是 `DirectoryPickerNativeCapability.pick`，返回**绝对路径**或 `null`=用户取消；`directory-picker/unavailable` 表示当前部署没有选择器，要原样报给用户，不能静默）。**服务名一律不进 `inject` 数组**（§3.1 同规矩）；它的结构镜像在 `context-types.ts` 的 `UiWorkspaceFace`。

    **拿到路径后只发一个字段给宿主**，其余全由宿主决定：新路由 `workspace.addFolder` 只收 `{ path, access }`，清单路径取自 `wsReg.get(sessionId).manifestPath`（客户端**无法**指定要改哪份清单），无激活作业区一律 403，目标必须 `stat.isDirectory()`，已经在作业区内的目录回 `added:false` 而不是重复追写。写入走 `src/manifest-edit.ts`：保注释的文本扫描（插入点是**最后一个有效条目之后**，所以尾随 `// 注释` 不会被逗号吞掉）→ 时间戳侧车备份（后缀 `.octopus-backup`，刻意不是认领的清单扩展名，否则会被 cwd 发现逻辑当成候选）→ 写临时文件再原子替换 → 用产品自己的 `parseWorkspaceManifest` 回读校验，任何一步失败都还原原文件并清掉自己的备份与临时文件。写完用**原来的 `activatedAt`** 重新激活（违规扫描以它为时间下界，改清单绝不能抬高这条线），于是新根立刻出现在返回的快照里，不需要重启。权限**显式写死**：只读那一项写 `"access": "readOnly"`，否则清单里 `defaultAccess: "readWrite"` 会把一次只读选择悄悄升级成可写根。

    **行右键菜单是第三个入口**（内容在 `src/client/row-menu.tsx`，纯函数 `buildRowMenu` / `rowMenuIntent`；卡片仍复用空白处那张 `PointerContextMenu`，因为只有行内容不同）：`移出作业区`（平台 `MenuItem` 的 `danger` 行，破坏性着色）与`改为只读 / 改为读写`（与行上小锁**同一条路由**，所以两条入口绝不会让行状态分叉）。`path` 依旧取快照里已有的 `root.path`。隐含 cwd 根（`listed === false`）两项**禁用而不是隐藏**，并追加一行 `MenuLabel` 说明"清单里没有它的条目"——菜单静悄悄少几行会被读成 bug。移出**不用**浏览器原生 `confirm`，而用平台自带的 `RiskConfirmation`（`acknowledged` 勾选前确认按钮不可用；测试桩 `tests/stubs/dsh-client-ui-primitives.ts` 里已同步补上这个零件），因为"移出"最容易被误解成删文件夹，那句"只删清单里的声明、磁盘不动"必须明说。

    **移除走 `workspace.removeFolder`**，与另外两个入口共用同一个事务、同一条围栏：只认**已声明**的根（隐含 cwd 根 400）；删哪一条由宿主用与建根相同的 `resolveFolderPath` 反查，无匹配或多匹配都是明确报错、绝不猜。文本手术要连同**恰好一个分隔逗号**一起删（优先删后面那个，没有就删前面那个），所以结果里既不会出现 `,,` 也不会留下悬空逗号；注释与 CRLF 照旧保留。**三种情况都在动任何字节之前就拒绝**：无匹配、匹配到多条、以及"这是清单里唯一一条"——`workspace-schema.ts:253` 要求 `folders` **非空**，所以"删成 `[]`"既不可能也不该靠回读校验兜底。三个拒绝都**不开事务**，因此不留备份、不留临时文件，原文件逐字节不动。**反直觉但必须照实说的一条**：被删掉的那条如果正好解析成会话 cwd，`workspace-policy.ts` 的 `if (!seen.has(realCwd))` 会立刻把隐含的 `readWrite` cwd 根补回来——所以客户端按返回快照里同一 path 的 `listed === false` 分两句提示（`folderRemoved` / `folderRemovedImplicit`），不是猜的。移除同样用**原 `activatedAt`** 重新激活。

    这也是本包**唯一**写用户磁盘的地方（三个入口：右键空白处加入、点小锁改权限、行右键移出），所以 `src/index.ts` 文件头对"只读是结构性的"已改成精确表述：改的是**策略文件**（清单），不是声明范围内的内容，且只能由界面上的一次授权动作触发。测试：`tests/manifest-edit.spec.ts`（尾随注释、空数组、CRLF、无 `folders` 时拒绝、回读失败必须还原且不留残留，以及改写权限、删除条目两组）、`tests/body-menu.spec.tsx`（只有一项、飞行中禁用而非隐藏、退役的读写 id 不再映射）、`tests/row-menu.spec.tsx`（两项、danger、权限行说的是目标级别、隐含根禁用且带说明）、`tests/root-markers.spec.tsx`（两种状态、按钮与不可点两种形态）、`tests/host-routes.spec.ts` 与冒烟里各自的探针。

14. **模型可见的第二条通道：运行时上下文（`systemPrompt.context`），只放标签、不放路径**：0.9.0 起，作业区的**标签表**随每次组装进入模型的运行时上下文，所以"看一下 VS调试"里的标签**第一轮**就可解析，不必等模型想起调工具。注册形态是 `ctx.inject(['systemPrompt'], (scope) => ctx.effect(() => scope.systemPrompt.context(createSpaceContext(registry)), '…'))`——**`systemPrompt` 绝不进插件级 `inject` 数组**（§3.1 的 patch 层致命形态），effect 归注入回调所有，卸载与 HMR 都能收回注册。四条已被测钉住的约束：(1) **空文本等于没有贡献**（服务丢弃空串），所以无 `agent`（诊断组装：`agent` 在那个接口里是可选的合并扩展字段）、无激活作业区都返回 `''`，不用作业区的会话一分钱不付；(2) `text` 是**每次组装求值的 provider**，不是注册时定格的字符串，所以后应用的作业区**下一轮**就出现（读的是活 `registry`）；`name` 唯一（重名注册直接抛），`order` 是**数字**（服务自带的运行时上下文是 110 沙箱策略 / 115 审批 / 120 子代理委派，本包取 130，排在策略之后）；(3) **绝对路径不进上下文**——上下文按**每轮**付费，工具结果按**每次调用**付费，同一份十根快照下标签表的长度不到报告的一半（体积守卫在 `tests/workspace-report.spec.ts`），路径仍只有 `octopus_space` 能给；(4) 措辞与规格都在 `src/workspace-report.ts` 的 `renderSpaceLabels`（与报告共用 `implicit` / `missing` 标记逻辑），工具名由调用方传入，避免报告模块反向 import 工具模块成环。**一个只在构建里现形的坑**：`AssembleContext.agent` 不是 system-prompt 包自己声明的字段，而是 `dsh-agent` 对该接口的**合并扩展**——增强只对"加载了那个模块"的程序生效，于是 src-only 的 `tsconfig.build.json` 看不到它（`pnpm typecheck` 因为测试程序另有导入而通过，`pnpm build` 却报 `TS2339`）。修法是 `workspace-context.ts` 里一句 `import type {} from '@deepseek-ai/dsh-agent'`（仅类型、运行时被擦除，两个包因此都只是 devDependencies，零运行时依赖不变）。宿主**真的收下**这份注册由冒烟兜底（注册发生在 `apply` 内，服务拒收就是插件加载失败，冒烟的 loader/inject 检查会红）；宿主接线由 `tests/host-routes.spec.ts` 的假 `systemPrompt` 锁。

---

## 4. 开发规则速查

- **先读后改**：对已存在文件执行 `edit` / `write` 前必须先 `read`（链式工具强制）；批量修改时先并行读全部目标文件，再逐个编辑。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` 令牌（唯一例外是内置文件页自己也在用的 `--dsh-content-font-size-secondary`——**与内置对齐优先于令牌洁癖**），不硬编码颜色；没有 CSS module 到达这个界面，样式是内联的，所以内置那套 `:hover` 只能用状态复刻，`.level .level` 那种嵌套缩进只能按深度乘出来。凡是"要和内置一致"的度量，一律进 `src/client/tree-metrics.ts`，不要在组件里散落数字。
- **地址语法不手抄**：`src/client/file-address.ts` 之所以自己构造字符串，是因为它所在包不在客户端模块表内（导入会被纯度门拒）。它的正确性由 `tests/file-address.spec.ts` 对着**产品自己的 `parseFileAddress`** 做往返锁定——改实现必须同步该测试，否则就是猜。
- **语义改动有四个同步点**：`workspace-schema.ts`（解析与默认值）↔ `workspace-policy.ts`（读/写基集）↔ `workspace-skill.ts`（模型可见的技能文案）↔ 模型可见的工具与上下文措辞（`workspace-tool.ts` 的工具定义、`workspace-report.ts` 的 `renderSpaceReport` 与 `renderSpaceLabels`，以及把后者注册成运行时上下文的 `workspace-context.ts`：清单标签到绝对路径的唯一出口）。改一个就要看其余几个。《`snapshotOf` 是客户端合同，不要为了让模型少花 token 去改它——该改的是报告。》
- **`context-types.ts` 必须保持无 Node 类型**：它在客户端可达的声明图里；它用交叉类型而非 `declare module` 增强，因为宿主与客户端为 `sessions` 声明了不同类型，合并会 TS2717。

---

## 5. 文档与测试地图

- **用户文档**：[README.md](README.md)（安装、清单格式、权限模型、限制）。
- **设计史**：[docs/plans/](docs/plans/)。已移除功能的完整历史见 git tag `archive/sidebar-workbench`。
- **关键测试守护**：
  - `tests/host-routes.spec.ts` —— 唯一宿主路由的端到端行为（信任围栏、方法分派、信封、作业区生命周期、根围栏、只读越权报告与还原、冷会话路径、cwd 清单发现、桌面交接的三种拒绝，以及三个写盘路由 `addFolder` / `setFolderAccess` / `removeFolder` 的每一个分支，含"被移出的那条正好是 cwd 时隐含读写根会补回来"与"activatedAt 不因改清单而移动"，以及挂载面本身的三条等式：恰好一条 prefix 路由、恰好一个 `octopus_space` 工具、恰好一份运行时上下文注册——后者的 provider 按组装上下文求值，无 `agent` 与无激活作业区都返回空串，激活后给出标签且不含任何绝对路径）；
  - `tests/native-reveal.spec.ts` —— 桌面交接的 argv 构造（`/select,` 与目标必须是**一个** argv 元素、目标里不得出现引号或 file URL、含逗号的文件名降级为打开所在目录、路径永不被拼进命令字符串、三个平台各一条），**刻意不启动任何进程**；成功分支会在跑测试的机器上弹真实窗口，所以按设计只人工验证，而且要查**可见性与选中项**而不是窗口数量；
  - `tests/tree-metrics.spec.ts` —— 与内置文件页的**度量契约**：行盒、间距、18px 缩进、页头 38px、工具按钮、note 与悬停令牌逐项钉死（内置一改就红）；**刻意不断言渲染**，像素级一致只能人眼复核；
  - `tests/entry-order.spec.ts` —— 与内置一致的行序（目录优先 + 自然序、大小写不敏感、不改动入参）；
  - `tests/client-tab.spec.ts` —— 页签三重注册的身份一致性（type `id` 与两个座位 `key`）＋ 文案零死键（`multiroot-tab.tsx`、`shortcut.ts`、`body-menu.tsx` 与 `row-menu.tsx` 一起扫；扫描**按文本**匹配 `t('key')`，所以键名必须写成字面量，塞进三元表达式里会被判成死键）＋ **`inject` 数组的精确相等断言**（防止再把服务声明进去）＋ 开始页卡片（`commandId` 与命令 id 的等式、两语说明）＋ 快捷键命令（按 profile 的默认绑定、捕获不到面板时的拒绝、每次注册都由 effect 拥有）；
  - `tests/root-markers.spec.tsx` —— 根行标记的渲染契约：**两种状态都画锁**且画的是**真的锁形几何**（两条子路径、闭合与打开用的是各自的 codicon 路径数据，断言到 `d` 的开头），小锁在声明的根上是真 `<button>`（带状态名与动作气泡、飞行中 `disabled` 而不是消失）、在隐含 cwd 根上**没有按钮**而只有固定说明气泡，圆圈 i（`RootTrailingBadge`，行的最后一个元素、不伸缩）把绝对路径原样交给气泡（剥离零宽空格后必须逐字节相等）；
  - `tests/shortcut-binding.spec.ts` —— 拿**当前安装的 DSH** 全量扫描 `dsh-client-*/lib/client.js` 里的 `"Key<X>"` 裸字符串，证明本插件选的键没有被内置命令占用（没有安装时明确跳过，不假装验证过）；踩坑史见 §3.12；
  - `tests/host-types.spec.ts` —— 手写结构镜像对真实宿主类型的编译期可赋值性（`inspect` 那类漂移的守门人；含 `ShortcutCommand` 镜像：方向只能是"真实命令 → 镜像"，因为真实 `id` 是 branded 字符串，反方向由 `client-tab.spec.ts` 在运行时锁）；
  - `tests/file-address.spec.ts` —— 文件地址对产品解析器的往返（最容易静默失配的一处）；
  - `tests/workspace-schema.spec.ts` —— 清单解析、JSONC、默认值；
  - `tests/workspace-report.spec.ts` —— **模型拿到的那份报告的账本**：按权限分组（级别只在标题里出现一次，不逐根重复）、一根一行 `label = absolute path`、组内保持清单顺序、空组不出现、`missing` 与 `implicit` 两个标记（以及两者同时出现时的顺序）、不含任何模型用不上的线格式字段（`sessionId`/`cwd`/`ci`/`activatedAt`/`access` 键）、以及**体积守卫**（同一份快照，报告长度必须小于线格式的一半——否则"直接序列化快照"看起来像个合理改动，实际把成本翻倍）；外加"未激活"那一句必须说明作业区从哪来；同一文件里还有**标签表** `renderSpaceLabels` 的一组：按权限一行列出标签、空组不出现、组内保持清单顺序、两个标记照旧、**任何一个根的绝对路径都不得出现**、工具名来自 `workspace-tool.ts` 的唯一来源、以及"标签表长度不到报告一半"的体积守卫；
  - `tests/workspace-context.spec.ts` —— **每轮那份标签表的账本**（用真实 `WorkspaceRegistry` + 临时清单，不手搓快照）：名字与 `order` 稳定且排在策略类上下文之后、激活后给出标签与工具名而**没有任何绝对路径**、无激活作业区／未知会话／无 `agent`（诊断组装）三种情况都返回空串、provider 读**活**注册表（后应用的作业区下一轮就出现）、会话之间互不串台；
  - `tests/manifest-edit.spec.ts` —— **唯一写盘点**的编辑器：追加后的文本逐字节断言（尾随 `// 注释` 必须留在原行、逗号在条目之后）、空数组就地展开、注释留在空数组里、CRLF 保持、没有 `folders` 时明确拒绝、备份等于原文且不是认领的清单扩展名、回读失败必须**原文件逐字节还原且不留备份/临时文件**；改写权限的一组：已有 `access` 只换值、没有就补成员且注释存活、字符串简写改写成对象形式且 token 原样、已是该级别时 `changed:false` 且不留备份、找不到/匹配多个都报错；删除条目的一组（15 例）：中间条目 / 末条（前一条无尾逗号，以及数组本身带 JSONC 尾逗号——后者会把前一个分隔逗号留成数组的尾逗号，两种都不出现 `,,`）、首条、字符串简写条目（含 `\/` 转义按 JSON 解码）、CRLF、同行注释随条目一起删、对象条目内部的注释与空行随它一起走、单行数组只吃掉自己那一段、无匹配与匹配多条都报错、仅剩一条**写之前就拒绝**（`folders` 必须非空）、以及"追加 → 删除"的逐字节往返；`removeFolderEntryInManifest` 一组（4 例）：写入后目录里只多出侧车备份且它与原文相等、回读失败逐字节还原且无残留、未知条目连文件带目录都不动、仅剩一条的拒绝同样不留任何东西；
  - `tests/body-menu.spec.tsx` —— 空白处菜单的契约：**只有一项**且映射到 `readOnly`（退役的 `addFolder.readWrite` id 必须仍是 `undefined`，防止它复活）、文案非空、选择器飞行中**禁用而不是隐藏**；它同时证明 `vitest.config.ts` 的 primitives 别名能解析新值导入的 `Menu`；
  - `tests/row-menu.spec.tsx` —— 行菜单的契约：声明过的根才有两项且移出在前、移出是 `danger` 行而权限行不是、权限行**说的是要切到哪一级**（两个级别的文案必须不同，否则看着像空操作）、飞行中两行禁用而非隐藏、隐含 cwd 根两行禁用并**带一行文字说明**（不能只留一个没人会打开的 tooltip）、只有自己那两个 id 能映射出意图（`addFolder.readOnly` 不许被当成行操作）；
  - `tests/workspace-policy.spec.ts` —— 根解析与读/写基集分类；
  - `tests/workspace-discovery.spec.ts` —— cwd 清单发现（只认已声明扩展名、只扫一层、稳定排序与候选上限、`autoActivate` 与不可解析候选都必须上报而不是被丢弃）；
  - `tests/discovery-decision.spec.ts` —— 自动加载的判定规则（唯一且未 opt-out 才自动应用；多个、opt-out、解析失败一律列出，绝不猜）；
  - `tests/fs-tree.spec.ts` / `tests/fs-tree-symlink.spec.ts` / `tests/session-path.spec.ts` —— 基础设施模块。

> 测试里**不要 import 真实的 `@deepseek-ai/dsh-client-ui-primitives`**：它是宿主注入的平台模块，其传递依赖（`clsx` 等）不在本仓库的 dev 依赖树里，导入会直接解析失败。`vitest.config.ts` 把该 specifier 别名到 `tests/stubs/dsh-client-ui-primitives.ts`；类型检查仍对着真实包的声明，只有运行时用桩。
