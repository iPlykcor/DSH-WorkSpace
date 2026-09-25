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

`scripts/smoke.ps1` 做的事：打包 → 装进**全新临时** `DSH_HOME` → 起真实宿主（`--port 0`）→ 写 BOM-less 测试清单 → 打 23 项 HTTP 探针 → 按**监听端口**回收宿主进程并删临时目录。退出码 0 = 全过；它**绝不触碰用户真实的 `~/.dsh`**。

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

判据：脚本全 PASS。等价的手工判据是：宿主走到就绪行、日志无 loader / inject / `duplicate prefix route` 失败、各路由状态码符合预期、冷会话不 500。**客户端渲染需要浏览器自动化**（`@playwright/test` 已随工作台移除），没有它就不要声称验证了页签渲染——`tests/client-tab.spec.ts` 只锁注册与文案，不锁渲染。

> **CI 与发布自动化已随工作台一并移除**（`.github/` 不在本包内）。需要 CI 时重新添加；当前发版是手动步骤。

---

## 3. 本包的 DSH 契约要点（对 0.1.7-rc.2 实测所得）

1. **页签注册**：`ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })`，页体与标题分别注册进座位 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，且必须经 `ctx.slots.inject(key, cb)` 包一层以等待座位声明。服务名是 `sidebarRightTabs`。
2. **打开文件只能委托**：`ctx.sidebarRight.openResource(address, { params: { line? } })`。内置文档预览是**唯一**认领文件地址的页类型，其 `canOpen` 是 `parseFileAddress(a)?.scope === 'session'`——**`absolute` scope 无人认领，调用会抛错**。因此地址必须用 `session` scope 携带绝对路径（清单声明的会话根之外目录同理）。
3. **没有可嵌入的查看器**：`renderSlot` 只发给在自己 `register` 里声明了 `children` 的注册者，第三方无法把内置查看器挂进自己的页签。要么委托打开，要么自己实现渲染——本包选前者。
4. **`ctx.remote.session.openWorkspacePath` 不是查看器**：它交接给操作系统的默认程序 / 文件管理器，DSH 界面里什么都不渲染。本包不使用它。
5. **图标来自 `@deepseek-ai/dsh-client-ui-primitives`**（平台模块表内）。其导出按**粗细**命名（`…Regular` / `…Medium`），不是尺寸后缀——0.1.2 时代的 `IconFolderOpen16` 在 0.1.7 已不存在。权限语义直接用产品自己的 `PermissionIconReadOnlyRegular` / `PermissionIconFullAccessRegular`。
6. **i18n 命名空间 `octopus`**：`zh` 是键的唯一事实来源，`en` 由 `Record<CopyKey, string>` 在编译期强制对齐（漏键即类型错误）。没有第三语言覆盖层。

---

## 4. 开发规则速查

- **先读后改**：对已存在文件执行 `edit` / `write` 前必须先 `read`（链式工具强制）；批量修改时先并行读全部目标文件，再逐个编辑。
- **皮肤契约**：视觉值只消费 `--dsw-alias-*` / `--dsw-font-*` 令牌，不硬编码颜色；没有 CSS module 到达这个界面，样式是内联的。
- **地址语法不手抄**：`src/client/file-address.ts` 之所以自己构造字符串，是因为它所在包不在客户端模块表内（导入会被纯度门拒）。它的正确性由 `tests/file-address.spec.ts` 对着**产品自己的 `parseFileAddress`** 做往返锁定——改实现必须同步该测试，否则就是猜。
- **语义改动有三个同步点**：`workspace-schema.ts`（解析与默认值）↔ `workspace-policy.ts`（读/写基集）↔ `workspace-skill.ts`（模型可见的技能文案）。改一个就要看另外两个。
- **`context-types.ts` 必须保持无 Node 类型**：它在客户端可达的声明图里；它用交叉类型而非 `declare module` 增强，因为宿主与客户端为 `sessions` 声明了不同类型，合并会 TS2717。

---

## 5. 文档与测试地图

- **用户文档**：[README.md](README.md)（安装、清单格式、权限模型、限制）。
- **设计史**：[docs/plans/](docs/plans/)。已移除功能的完整历史见 git tag `archive/sidebar-workbench`。
- **关键测试守护**：
  - `tests/host-routes.spec.ts` —— 唯一宿主路由的端到端行为（信任围栏、方法分派、信封、作业区生命周期、根围栏、只读越权报告与还原、冷会话路径）；
  - `tests/client-tab.spec.ts` —— 页签三重注册的身份一致性（type `id` 与两个座位 `key`）＋ 文案零死键；
  - `tests/host-types.spec.ts` —— 手写结构镜像对真实宿主类型的编译期可赋值性（`inspect` 那类漂移的守门人）；
  - `tests/file-address.spec.ts` —— 文件地址对产品解析器的往返（最容易静默失配的一处）；
  - `tests/workspace-schema.spec.ts` —— 清单解析、JSONC、默认值；
  - `tests/workspace-policy.spec.ts` —— 根解析与读/写基集分类；
  - `tests/fs-tree.spec.ts` / `tests/fs-tree-symlink.spec.ts` / `tests/session-path.spec.ts` —— 基础设施模块。

> 测试里**不要 import 真实的 `@deepseek-ai/dsh-client-ui-primitives`**：它是宿主注入的平台模块，其传递依赖（`clsx` 等）不在本仓库的 dev 依赖树里，导入会直接解析失败。`vitest.config.ts` 把该 specifier 别名到 `tests/stubs/dsh-client-ui-primitives.ts`；类型检查仍对着真实包的声明，只有运行时用桩。
