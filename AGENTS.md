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

`scripts/smoke.ps1` 做的事：打包 → 装进**全新临时** `DSH_HOME` → 起真实宿主（`--port 0`）→ 写 BOM-less 测试清单 → 打 27 项 HTTP 探针 → 按**监听端口**回收宿主进程并删临时目录。退出码 0 = 全过；它**绝不触碰用户真实的 `~/.dsh`**。

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
> PS 5.1 的两个实测陷阱（写这类脚本必踩，都已在 `smoke.ps1` 里绕开）：`[string](Get-Content $f -Raw)` 对**空文件**仍是 `$null`，`.Trim()` 直接硬报错；`$ErrorActionPreference = 'Stop'` 下把原生命令的 stderr 用 `2>&1` 并入管道**或** `2> file` 重定向，都会被当成终止性 `NativeCommandError`，必须局部降到 `Continue` 才能正常捕获。
>
> **`.ps1` 里的输出字符串必须保持纯 ASCII**：无 BOM 的 UTF-8 脚本会被 PS 5.1 按系统 ANSI 码页（本机 GBK）读取，`…` / `──` 这类字符经 `Write-Host` 直接变成 `鈥?`。注释里的乱码看不见（`smoke.ps1` 的中文注释就是如此），但**用户会看到输出乱码**——`deploy.ps1` 因此刻意写成纯 ASCII。
>
> **整文件重写先设护栏**：`String.Replace(char, char)` 吃不下 `'...'` 这类多字符参数，抛出的异常会让结果变量变成 `$null`，紧接着的 `WriteAllText($path, $null, …)` 会把文件**清空**（本仓库真实发生过一次，靠会话转录重放 edit 才恢复）。改写整个文件前先校验长度下限与关键标记，并先落暂存文件、解析通过后再覆盖。

判据：脚本全 PASS。等价的手工判据是：宿主走到就绪行、日志无 loader / inject / `duplicate prefix route` 失败、各路由状态码符合预期、冷会话不 500。**客户端渲染需要浏览器自动化**（`@playwright/test` 已随工作台移除），没有它就不要声称验证了页签渲染——`tests/client-tab.spec.ts` 只锁注册与文案，不锁渲染。

**一键部署（真实 profile）**：`scripts/deploy.ps1` 与冒烟互补——冒烟用一次性临时 `DSH_HOME`，部署脚本装进**真实** profile：四道门禁 → 构建打包 → 备份 profile 的 `package.json` 到 `octopus-deploy-backups\<时间戳>\` → **先 `remove` 再 `add`** → 校验依赖与插件清单，并把已安装的 `lib\index.js` / `lib\client.js` 与本次构建逐个做 SHA256 比对 → 打印重启与回滚命令。之所以要先移除：**同版本同路径的 `add` 是 pnpm 的空操作**，实测在真实 profile 上它报成功，而 `lib\index.js` 的 mtime 与内容都还是旧的（没有新路由），只有 SHA256 比对才暴露出来。它**绝不自动重启** `dsh web`：安装只在下次启动生效，而杀掉宿主会丢掉用户正在做的事。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1            # 装进 ~/.dsh 的 web profile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Uninstall # 卸载并复核依赖已移除
# 全流程演练（真实执行构建/打包/安装/校验，但目标是一次性 home，不碰真实 profile）：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -DshHome "$env:TEMP\dsh-deploy-test" -SkipTests -Yes
```

`-SkipTests` 跳过四道门禁，`-SkipBuild` 复用现有 `lib/`，`-DryRun` 只打印不落盘，`-Yes` 免确认。`-DshHome` 同时是它自己的测试入口。

> **CI 与发布自动化已随工作台一并移除**（`.github/` 不在本包内）。需要 CI 时重新添加；当前发版是手动步骤。

---

## 3. 本包的 DSH 契约要点（对 0.1.7-rc.2 实测所得）

1. **页签注册**：`ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`，页体与标题分别注册进座位 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，且必须经 `ctx.slots.inject(key, cb)` 包一层以等待座位声明。服务名是 `sidebarRightTabs`。**这个服务还必须写进客户端入口的 `inject` 数组，不能只在 `apply` 里用 `ctx.get` 探测**：提供方 `ui-sidebar-right` 自己的依赖更长（`slots`/`layout`/`locale`/`resources`/`sessions`/`uiSession`/`shortcuts`），cordis 会先激活依赖更少的本插件，探测于是拿到 `undefined`，`registerMultiRootTab` 直接返回 no-op 并且**永不重试**——表现为页签根本不出现，而控制台与宿主日志里**一句报错都没有**（真实踩过）。DSH 所有内置插件都把它列为依赖。`tests/client-tab.spec.ts` 锁定这一条。
2. **打开文件只能委托**：`ctx.sidebarRight.openResource(address, { params: { line? } })`。内置文档预览是**唯一**认领文件地址的页类型，其 `canOpen` 是 `parseFileAddress(a)?.scope === 'session'`——**`absolute` scope 无人认领，调用会抛错**。因此地址必须用 `session` scope 携带绝对路径（清单声明的会话根之外目录同理）。
3. **没有可嵌入的查看器**：`renderSlot` 只发给在自己 `register` 里声明了 `children` 的注册者，第三方无法把内置查看器挂进自己的页签。要么委托打开，要么自己实现渲染——本包选前者。
4. **`ctx.remote.session.openWorkspacePath` 不是查看器**：它交接给操作系统的默认程序 / 文件管理器，DSH 界面里什么都不渲染。本包不使用它。
5. **图标来自 `@deepseek-ai/dsh-client-ui-primitives`**（平台模块表内）。其导出按**粗细**命名（`…Regular` / `…Medium`），不是尺寸后缀——0.1.2 时代的 `IconFolderOpen16` 在 0.1.7 已不存在。**平台没有任何锁形图标**：279 个导出里 `Lock` 只匹配到 `Clock`。因此只读小锁是内联在 `src/client/root-markers.tsx` 里的 codicon `lock` 路径（16 网格，CC-BY-4.0，署名随源码与产物一起交付）——它原本来自 `react-icons/vsc`，而那是**运行时依赖**，随本包收敛为零运行时依赖一起被移除，当时临时换成的 `PermissionIconReadOnlyRegular`（**盾牌+对勾**）/ `PermissionIconFullAccessRegular`（**盾牌+感叹号**）读起来是两种不同的告警而不是同一种权限状态，已弃用。路径标记用 `IconInfoOutlineRegular`（圆圈 i）：它是**标注**而不是告警——平台把圆圈感叹号（Warning）和圆角三角（WarningTriangle）都留给真正的故障语汇，而这一行什么都没出错，只是有个值得一读的绝对路径。
6. **i18n 命名空间 `octopus`**：`zh` 是键的唯一事实来源，`en` 由 `Record<CopyKey, string>` 在编译期强制对齐（漏键即类型错误）。没有第三语言覆盖层。
7. **悬停气泡用平台 `Tooltip`，它不需要 Provider**：`TooltipSuppression` 的内联默认值就是 `createContext(null)`，19 个内置插件都直接锚定它（声明 Provider 的插件数为 0）。两个必须记住的点：(1) **`portal: true` 是必需的**——根目录列表在 `overflow: auto` 容器里滚动，非 portal 的气泡会被该容器裁掉；(2) `label` 只接受字符串或返回字符串的函数，而 Windows 路径没有断行点，所以只在**展示用**的 label 里按分隔符插入零宽空格以便折行——行的 `title` 与任何会被当作路径复用的字符串都保持原样。改客户端图标或气泡后，`tests/root-markers.spec.tsx` 会先于浏览器渲染亮红。**行的排布也是契约**：只读小锁紧贴名字（是否绘制由 `RootPermissionMarker` 决定，读写根一律不画），圆圈 i（ⓘ）是行的**最后一个**元素——它排在桌面动作的固定槽位**之后**（那个动作必须是真 `<button>`，不能嵌进行按钮里），槽位无论动作是否显示都占宽，所以悬停时 ⓘ 不会左右跳；又因为它落在行按钮**之外**，点它不会误触目录展开。**行尾这一段的间距由行容器统一承担**：容器 `gap: 6px` + `padding-right: 10px`（`box-sizing: border-box`，否则整行会溢出 10px），行按钮自己**不带**右内边距，于是"桌面动作 + ⓘ"这一对和内置行的内容一样收在距行右缘 10px 处；标记本身（小锁、ⓘ）**一律不带自己的外边距**，间隔只由这一层负责——小锁曾经因为自带 `margin-left: 6` 而与名字相距 12px。
8. **桌面交接是我们自己做的，而且必须无 shell**：内置 open-in-app 的目录入口绑在**会话 cwd** 上，Windows 上落到 `explorer.exe "file:///…"`，而且 runner 写死 `windowsHide: true`——**实测窗口会被建出来但不可见**（同一 URL：`windowsHide:true` → `IsWindowVisible=False`，`false` → `True`），所以它返回 200、日志干净，用户却什么也看不到。作业区恰恰是 cwd 之外的目录，所以 `workspace.reveal` 自己 spawn：**绝不拼命令字符串**（永远传 argv）、**`windowsHide: false` + `detached`**。Windows 的 argv 只认**纯宿主路径**：目录 → `explorer.exe <path>`；文件 → `/select,<path>` 放**同一个** argv 元素。两条实测禁区——**file URL 形式**（`/select,file:///…`，DSH 自己的写法）在中文路径下会被 Explorer 丢去打开**桌面**；**给路径加引号**会打开**文档**且什么都不选中。路径里含**英文逗号**时无法选中（`/select,` 按逗号切分参数），此时降级为打开**所在目录**。Explorer 的退出码 1 = 已交棒给桌面进程（与 `dsh-native-command` 同语义），超时同样算成功并 `unref`（那说明 explorer.exe 自己变成了 shell）。围栏复用**读围栏** `ensureWsReadTarget`（realpath + 声明根包含判定），所以符号链接也偷不出作业区。**测试与冒烟绝不触发它**：成功分支会在跑测试的机器上弹真实窗口——argv 由 `tests/native-reveal.spec.ts` 锁定。人工验证必须同时查**可见性与选中项**：`Shell.Application.Windows()` 会列出**不可见**的窗口登记项（实测 25 条里只有 3 条可见），只数窗口会得出完全错误的结论。
9. **工具注册：`inject` 里必须写 `'tools'`，且 `output { schema, render }` 是强制的**：服务名是 `ctx.tools`（`ToolRuntime`，dsh-tools），`register(definition)` 返回注销器，`ctx.tools` 由 base bundle 挂载。handler 的**第二个**参数才是调用上下文，会话 id 是 `exec.agent?.session.id`（`agent` 可缺——非 agent 调用者没有它，必须自己判空，否则就是替别的会话作答）。**没有 `output` 的定义根本注册不上**（注册期直接 `TypeError`），而 `execute` 的返回值又要被 `output.schema` 校验，最后 `output.render(args, value)` 才把它变成模型看到的文本——三者缺一不可。`parameters` 用原生 JSON Schema 即可：本包不需要 `defineTool` 的 DSL，于是也没有新增运行时 import（零依赖不变）。`octopus_space` 是「清单标签 → 绝对路径」唯一的模型出口，语义改动时它属于四个同步点之一。
10. **`dsh.plugin.json` 的 `contributes` 目前没有任何消费者**：对已安装的整棵 `@deepseek-ai` 树 grep `contributes` 只命中无关的英文注释，且**没有任何 DSH 包自带 `dsh.plugin.json`**，所以 `tools` / `skills` 两个数组保持为空是现状（技能的注册同样不在里面）。别照着自己的想象往里面填 schema。
11. **与内置「工作区文件」的观感一致性有唯一事实来源**：内置那个页签是 `@deepseek-ai/dsh-client-ui-sidebar-files`，它的行样式写在**内联进 bundle 的 CSS module** 里（`lib/client.js` 的 `k-1LKG_*` 块），而行本身用的是平台共享组件——文件行 `FileTypeIcon kind={classifyFileType(name)} size={16}`，目录行 `IconFolderOpenRegular` / `IconFolderCloseRegular`（**Regular 字重、不传 size、颜色取 `--dsw-alias-label-tertiary`**），页头用 `PathLabel`。这些组件**全都在纯度白名单内**（`@deepseek-ai/dsh-client-ui-primitives`），所以"一致"的做法是**同样的零件 + 同样的数值**，不是照着调参凑近。数值集中在 `src/client/tree-metrics.ts`（行 `padding:5px 10px`／`gap:6`／**每层缩进 18px**／body `8px 0 8px 8px` + `scrollbar-gutter:stable`／页头 38px + `.5px` 下边框／工具按钮 28×28 内嵌 15px 图标／note 12px + `3px 10px`），`tests/tree-metrics.spec.ts` 逐项钉住：**内置改了这里就会红**，逼着重读那份 CSS 而不是静默分叉。两处**刻意不同**，别当成 bug 改回去：(1) 内置的悬停来自 `:hover`，而本包拿不到 CSS module，悬停底色改由行已有的 hover 状态绘制；(2) 内置靠嵌套 `<ul>` 缩进，这里是扁平列表，按深度乘同一个 18px。行序照抄内置（目录优先 + `Intl.Collator({numeric:true,sensitivity:'base'})`，见 `src/client/entry-order.ts`）。**像素级一致无法自动断言**（本仓库没有浏览器 lane），只能锁数值与结构，最终必须人眼复核。

---

## 4. 开发规则速查

- **先读后改**：对已存在文件执行 `edit` / `write` 前必须先 `read`（链式工具强制）；批量修改时先并行读全部目标文件，再逐个编辑。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` 令牌（唯一例外是内置文件页自己也在用的 `--dsh-content-font-size-secondary`——**与内置对齐优先于令牌洁癖**），不硬编码颜色；没有 CSS module 到达这个界面，样式是内联的，所以内置那套 `:hover` 只能用状态复刻，`.level .level` 那种嵌套缩进只能按深度乘出来。凡是"要和内置一致"的度量，一律进 `src/client/tree-metrics.ts`，不要在组件里散落数字。
- **地址语法不手抄**：`src/client/file-address.ts` 之所以自己构造字符串，是因为它所在包不在客户端模块表内（导入会被纯度门拒）。它的正确性由 `tests/file-address.spec.ts` 对着**产品自己的 `parseFileAddress`** 做往返锁定——改实现必须同步该测试，否则就是猜。
- **语义改动有四个同步点**：`workspace-schema.ts`（解析与默认值）↔ `workspace-policy.ts`（读/写基集）↔ `workspace-skill.ts`（模型可见的技能文案）↔ `workspace-tool.ts`（模型可见的 `octopus_space` 工具：清单标签到绝对路径的唯一出口）。改一个就要看另外三个。
- **`context-types.ts` 必须保持无 Node 类型**：它在客户端可达的声明图里；它用交叉类型而非 `declare module` 增强，因为宿主与客户端为 `sessions` 声明了不同类型，合并会 TS2717。

---

## 5. 文档与测试地图

- **用户文档**：[README.md](README.md)（安装、清单格式、权限模型、限制）。
- **设计史**：[docs/plans/](docs/plans/)。已移除功能的完整历史见 git tag `archive/sidebar-workbench`。
- **关键测试守护**：
  - `tests/host-routes.spec.ts` —— 唯一宿主路由的端到端行为（信任围栏、方法分派、信封、作业区生命周期、根围栏、只读越权报告与还原、冷会话路径、cwd 清单发现、桌面交接的三种拒绝）；
  - `tests/native-reveal.spec.ts` —— 桌面交接的 argv 构造（`/select,` 与目标必须是**一个** argv 元素、目标里不得出现引号或 file URL、含逗号的文件名降级为打开所在目录、路径永不被拼进命令字符串、三个平台各一条），**刻意不启动任何进程**；成功分支会在跑测试的机器上弹真实窗口，所以按设计只人工验证，而且要查**可见性与选中项**而不是窗口数量；
  - `tests/tree-metrics.spec.ts` —— 与内置文件页的**度量契约**：行盒、间距、18px 缩进、页头 38px、工具按钮、note 与悬停令牌逐项钉死（内置一改就红）；**刻意不断言渲染**，像素级一致只能人眼复核；
  - `tests/entry-order.spec.ts` —— 与内置一致的行序（目录优先 + 自然序、大小写不敏感、不改动入参）；
  - `tests/client-tab.spec.ts` —— 页签三重注册的身份一致性（type `id` 与两个座位 `key`）＋ 文案零死键；
  - `tests/root-markers.spec.tsx` —— 根行标记的渲染契约：只读行画的是**真的锁形几何**（两条子路径）而不是空占位、读写行**不留任何权限标识**（这条由 `RootPermissionMarker` 单独承载，因为它曾经整个消失过一次）、圆圈 i（`RootTrailingBadge`，行的最后一个元素、不伸缩）把绝对路径原样交给气泡（剥离零宽空格后必须逐字节相等）；
  - `tests/host-types.spec.ts` —— 手写结构镜像对真实宿主类型的编译期可赋值性（`inspect` 那类漂移的守门人）；
  - `tests/file-address.spec.ts` —— 文件地址对产品解析器的往返（最容易静默失配的一处）；
  - `tests/workspace-schema.spec.ts` —— 清单解析、JSONC、默认值；
  - `tests/workspace-policy.spec.ts` —— 根解析与读/写基集分类；
  - `tests/workspace-discovery.spec.ts` —— cwd 清单发现（只认已声明扩展名、只扫一层、稳定排序与候选上限、`autoActivate` 与不可解析候选都必须上报而不是被丢弃）；
  - `tests/discovery-decision.spec.ts` —— 自动加载的判定规则（唯一且未 opt-out 才自动应用；多个、opt-out、解析失败一律列出，绝不猜）；
  - `tests/fs-tree.spec.ts` / `tests/fs-tree-symlink.spec.ts` / `tests/session-path.spec.ts` —— 基础设施模块。

> 测试里**不要 import 真实的 `@deepseek-ai/dsh-client-ui-primitives`**：它是宿主注入的平台模块，其传递依赖（`clsx` 等）不在本仓库的 dev 依赖树里，导入会直接解析失败。`vitest.config.ts` 把该 specifier 别名到 `tests/stubs/dsh-client-ui-primitives.ts`；类型检查仍对着真实包的声明，只有运行时用桩。
