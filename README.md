# dsh-octopus-operation-space · 章鱼作业区

给 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 的**内置右侧栏**加一个多根工作区页签：用一份 JSONC 清单声明若干目录及各自的读写权限，未声明的路径一律只读。

> 这个包**只做这一件事**。文件浏览、预览与渲染全部交给 DSH 自身；本插件不含任何查看器、字节路由或媒体处理。

---

## 它做什么

- **多根目录**：一份 `*.dsh-octopus`（兼容旧名 `*.dsh-workspace`）清单一次列出多个根目录，侧边栏按会话隔离地展示与浏览。
- **逐目录读写权限**：每个目录声明 `readWrite` 或 `readOnly`，**未标注默认只读**；根目录名字右侧是一把可点的小锁——只读是**闭合**的锁，读写是**打开**的锁，点一下就在两者之间切换（改的是你清单里那一条的 `access`，见步骤 7）。
- **一眼可见的绝对路径**：每个根目录行最右侧的圆圈 i（ⓘ），鼠标悬停（或键盘聚焦）即显示该根的绝对路径——只读行原本被"只读"文案占用的悬停位置，现在归还给路径本身。
- **开始页面上的入口**：内置右侧栏的起始页里，「章鱼作业区」卡片带一行说明（*在会话工作区内高效访问工作区外的资源。*）和打开它的快捷键 **Ctrl+Alt+S**（macOS 上是 ⌘⌥S）；焦点停在会话里任意位置都能按，没有打开会话时会明确拒绝而不是乱开页签。键位可以照常在「设置 → 快捷键」里改绑。
- **卡片插图**：起始页卡片左侧显示作业区自己的插图（`src/client/guide-artwork.tsx`）。图片以 data URL 内嵌进客户端 bundle——DSH 的 `guide[].icon` 要的是**组件**而不是图片 URL，这样也就不用加宿主路由、不怕图裂；代价是包体积，所以源图会被居中裁剪压到 128×128。**换图不要手改 base64**，用 `scripts\make-guide-artwork.ps1 -Source <图片路径>` 重新生成。
- **一键交给桌面**：任意文件夹行（根目录与子目录）悬停时出现一个打开图标（位置在**行尾、圆圈 i 左侧**，与行右缘、与 ⓘ 的间距都和内置文件页对齐），点它就在系统文件管理器里打开该目录；文件行则是"在文件管理器中选中"。它走插件自己的宿主路由，只对**当前作业区声明范围内**的路径生效。
- **模型也"看得见"作业区**：宿主注册了一个 `octopus_space` 工具，模型可直接查到当前作业区每个根的**标签、绝对路径、读写权限与是否存在**——于是"rw 里有什么""看下现场问题"这类只提标签的指令不必再猜，模型会先把标签解析成绝对路径。
- **与内置「工作区文件」同一套观感**：文件行用产品自己的类型图标（`FileTypeIcon`，按类型着色），目录行用同款 Regular 文件夹图标，行距、18px 缩进、悬停底色、页头 38px 与工具按钮尺寸都与内置文件页一致，连行序也一致（目录优先 + 自然序）。所有度量集中在 `src/client/tree-metrics.ts`，由测试钉住，内置一改就会红。
- **只读保证**：插件自身**没有任何写入路由**——只读是结构性的，不是一层可绕过的校验。
- **越权检测与还原**：模型（或任何写者）写入只读根时，插件折叠会话事件日志给出记录，并尽力还原。
- **运行时技能**：随插件注册 `dsh-octopus` 技能，模型无需翻找范例即可按格式创建/编辑清单。

## 它不做什么

- **不含文件查看器**：点击文件会把一个 `dsh-resource://file/session/…` 地址交给 DSH 自身，由内置文档预览页签渲染（文本 / Markdown / 代码 / 图片 / PDF / Office / Excel）。这也是本插件能覆盖会话根之外目录的原因——宿主文件路由接受工作区内外两种绝对路径。
- **不接管内置页签**：它是一个新增的页类型，从 DSH 侧边栏的页签入口打开，不覆盖任何内置类型。
- **不重新沙箱化模型的工具**：模型侧的原生文件工具仍受 DSH 自己的会话 cwd 沙箱约束；声明在工作区里的额外目录由作业区浏览，不因此对模型放开。

---

## 安装

本包尚未发布到 npm。**一键部署**（在仓库根执行，Windows）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

它跑四道门禁 → 构建打包 → 把 profile 的 `package.json` 备份到 `octopus-deploy-backups\<时间戳>\` → **先 `remove` 再 `add`**（版本号与 tarball 路径都不变时，直接 `add` 对 pnpm 是空操作，不会重新解包）→ 校验依赖与插件清单，并把已安装的 `lib\index.js` / `lib\client.js` 与本次构建逐个做 SHA256 比对 → 打印重启与回滚命令。它**绝不自动重启**你正在用的 `dsh web`——安装只在下次启动生效，而杀掉宿主会丢掉你手头的事。

常用开关：`-SkipTests`（跳过门禁）、`-SkipBuild`（复用现有 `lib/`）、`-DryRun`（只打印不落盘）、`-Yes`（免确认）、`-Uninstall`（卸载并复核依赖已移除）、`-DshHome <目录>`（指向别处；用它做全流程演练不会碰真实 profile）。

手工等价步骤（任意平台）：

```bash
pnpm build
pnpm pack
dsh plugin --profile web remove dsh-octopus-operation-space   # 版本号不变时必须先移除，否则 add 对 pnpm 是空操作
dsh plugin --profile web add file:D:/绝对路径/dsh-octopus-operation-space-0.1.0.tgz
```

包内 `cordis.patch.yml` 会让这条命令同时完成挂载（把插件行 `insert` 进 profile 的 bundle 栈），不需要手工改 profile。**安装后需要重启 `dsh web`** 才会加载。

卸载：

```bash
dsh plugin --profile web remove dsh-octopus-operation-space
```

> `dsh plugin` 实际是在 profile 目录里执行 pnpm，所以增删都用 pnpm 的动词（`add` / `remove`）。

## 使用

1. 打开右侧栏的页签菜单，选择**章鱼作业区**。
2. **自动检测**：页签一打开就扫描当前会话 cwd（**只扫一层**）里的 `*.dsh-octopus`。恰好一个、且未声明 `autoActivate: false` → 直接应用；只有一个但声明了 `autoActivate: false` → 列出来等你点；**多个 → 全部列出让你选**（不猜；解析失败的也会列出并标注「无法解析」，鼠标悬停可见原因）。这样清单放在 cwd 就**不需要手输路径**。
3. 清单不在 cwd 时，在面板里填入它的绝对路径，回车或点「应用此作业区」；面板的 ⟳ 按钮可随时重新扫描。
4. 面板列出各根目录；点目录展开，点文件即在 DSH 的文档预览页签中打开。
5. 标题栏：最左是**清单路径**（与内置文件页一样，目录名弱化、末段主色，悬停显示完整路径），其右是根目录数量、越权计数，以及 **⟳ 重新读取清单**、**✕ 退出作业区** 两个工具按钮（尺寸与内置文件页一致）。
6. **在面板空白处右键 →「选择文件夹加入作业区」**，可以把工作区外的文件夹加进来。它调起**宿主进程的原生「选择文件夹」对话框**（与内置「添加工作区」是同一个选择器），你选中的目录被追加进当前清单的 `folders`，并且**显式写成只读**（`"access": "readOnly"`，所以清单里 `defaultAccess: "readWrite"` 也不会把它悄悄升级）。加完立即生效：宿主重新激活清单，新根马上出现在列表里，不需要重启。改动前会在清单旁留一份 `<清单名>.<时间戳>.octopus-backup`，撤销就是把它拷回去。注意两点：右键落在**根目录行**上打开的是该行自己的菜单（见步骤 8），只有空白处才归本插件；写入的路径是**规范化后的真实路径**，且已在作业区内的目录只会得到一句「已在作业区内」，不会重复追加。
7. **点根目录名字右侧的小锁，在只读 / 读写之间切换**：闭合的锁是只读，打开的锁是读写，悬停气泡会说明点下去会变成哪种；点一下即生效（改的还是你清单里那一条的 `access`，同样先备份），下方提示写明改了哪个目录。会话 cwd 的**隐含根**（清单没显式列出 cwd 时自动带上的那个）显示的是**不可点**的开锁标记——清单里没有它的条目，没有地方可以持久化；想给它固定权限，就把它显式写进 `folders`。

8. **在某个根目录行上右键**，菜单两项：**移出作业区**（破坏性着色）与**改为只读 / 改为读写**（和步骤 7 的小锁是同一个动作、同一条路由，只是入口不同）。移出只删**清单里那一条声明**，磁盘上的文件夹**不会**被删除或移动——正因为这句话容易被误解，移出会先用平台自带的确认框问一次，勾选「我明白这只改清单」后确认按钮才可用；改权限则和小锁一样一键生效。两者都同样先留备份、写完回读校验。会话 cwd 的**隐含根**两项都是灰的，并有一行说明原因（清单里没有它的条目）。还有一个反直觉之处会写在提示里：如果移出的那条**正好解析成会话 cwd**，策略会立刻把隐含的读写根补回来，提示会明说「它仍作为会话工作区（隐含读写根）保留」，不会让你以为它真的离开了作业区。

## 清单格式

JSONC：允许注释与尾逗号。相对路径以**清单文件所在目录**为基准解析。

```jsonc
{
  "version": 1,
  "name": "我的作业区",              // 可选：页签标题
  "folders": [
    { "path": "D:/repo/app", "access": "readWrite" },
    { "path": "./docs" },           // 相对本文件；访问权限取默认值
    "D:/repo/shared"                // 字符串简写
  ],
  "settings": {
    "defaultAccess": "readOnly",    // readWrite | readOnly，默认 readOnly
    "autoActivate": true            // 在会话 cwd 被发现即自动应用，默认 true
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `version` | 清单格式版本，当前为 `1` |
| `name` | 可选，页签标题；省略时用文件名 |
| `folders` | 非空数组；每项是路径字符串或 `{ path, name?, access? }` |
| `folders[].path` | 绝对路径（Windows 盘符 / UNC 均可）或以本文件为基准的相对路径 |
| `folders[].name` | 可选，覆盖显示名 |
| `folders[].access` | `readWrite` 或 `readOnly` |
| `settings.defaultAccess` | 未标注 `access` 的目录取此值，默认 `readOnly` |
| `settings.autoActivate` | 设为 `false` 时，本清单即使被自动检测到也**不自动应用**，需你手动点选（默认 `true`） |

**会话目录是隐含的可写根**：除非清单显式列出了会话 cwd（此时以清单为准），否则它会作为隐含的 `readWrite` 根加入，避免把当前项目锁成只读。

## 只读是怎么保证的

两层，互相独立：

1. **结构性**：除清单本身以外，插件不暴露任何写入路由。而这三处写入（右键空白处加入文件夹、点小锁改权限、行右键移出）改的都是**策略文件**而不是声明范围内的内容：它们由你在界面上发起（改权限没有确认框，移出有一次勾选式确认，都不留中间态——清单本身就是审计记录，落到只读根的写入还会被报出来），路径只能来自宿主的原生选择器（页面拿不到真实路径，也就无从伪造），路由只在会话已有激活作业区时才工作（否则 403），小锁与行菜单都只能动**清单里声明过的**根（隐含 cwd 根会被拒），加入时目标还会被检查是不是真实目录。写入前先做时间戳备份，新文本写进临时文件再原子替换，写完用产品自己的解析器回读校验；任何一步失败都会把原文件还原并报错，绝不留下改到一半的清单。
2. **检测与还原**：`workspace.violations` 折叠会话事件日志，报出落在只读根内的写入调用——不论由谁发起——并标注能否还原；`workspace.rollback` 对单条记录做尽力还原。

注意第 2 层是**尽力而为**的：它只在写入前的原内容仍可取得时才能还原。

## 要求与限制

- **DSH ≥ 0.1.5**：页签依赖 `ctx.sidebarRightTabs`。更早的宿主上插件能挂载，但没有可见界面（页签注册为 no-op，不会报错）。
- 平台：Windows / macOS / Linux 均可（路径大小写折叠按宿主判定）。
- 宿主重启后，进程内的作业区注册表是空的；此时客户端用本插件自己的键 `dsh-octopus:v1:<sessionId>` 记录过的清单路径重新激活。宿主一旦有状态，以宿主为准。
- 越权检测只覆盖会话事件日志窗口内的写入。
- **模型原生文件工具不因此放开**：额外目录对模型是否可见，取决于 DSH 自身的沙箱策略，与本插件无关。
- **右键加入文件夹需要宿主提供原生目录选择器**（内置 web 运行时自带，和「添加工作区」用的是同一个）。当前部署没有选择器时，面板里会显示明确原因（`directory-picker/unavailable`），不会静默无反应。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit（宿主 + 客户端 + 测试 + 配置）
pnpm test        # vitest
pnpm build       # tsc 声明 + tsdown 产物
pnpm lint
```

`lib/` 产物约 300 KB（宿主 ESM + 两份客户端 CJS 闭包 + 两份 sourcemap + 类型声明）。

### 验证

静态与单元层：

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm lint
```

真实挂载冒烟——打包 → 装进**全新临时 profile** → 起真实宿主 → 打 HTTP 探针 → 回收，一条命令跑完：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1
```

它**不碰你真实的 `~/.dsh`**（临时 `DSH_HOME`），用 `--port 0` 取随机空闲端口（不占你正在用的 GUI），结束后按监听端口回收宿主并删掉临时目录；退出码 0 表示 27 项检查全部通过。

一键部署到真实 profile（四道门禁 → 构建打包 → 备份 → 强制重装 → SHA256 校验，**绝不自动重启**你的宿主）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

> 它**不覆盖浏览器渲染**：页签是否真的画出来需要浏览器自动化，本仓库没有那条 lane（`@playwright/test` 已随工作台移除）。冒烟只证明宿主装得上、路由通、围栏与越权还原符合预期。

**依赖为零**：`dependencies` 为空；客户端只消费 DSH 冻结模块表里的平台模块（`react` / `react-dom` / `cordis` / `@deepseek-ai/dsh-client-ui-*`），由宿主在挂载时注入。

关键结构：

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 宿主入口：注册技能、挂载 `/octopus/api` 围栏路由 |
| `src/workspace-schema.ts` | 清单解析（JSONC、字段归一、默认值） |
| `src/workspace-report.ts` | 交给模型的那份作业区报告（按权限分组的 `标签 = 绝对路径`，只标「现在不存在」与「隐含 cwd 根」）；工具注册在 `workspace-tool.ts`，客户端线格式仍由 `workspace-state.ts` 负责 |
| `src/manifest-edit.ts` | 唯一一处写盘：向 `folders` 追加一条、改写某一条的 `access`、删掉某一条（三者都是保注释的文本改写 + 备份 + 原子替换 + 回读校验） |
| `src/workspace-policy.ts` | 根解析与读/写基集，路径分类 |
| `src/workspace-discovery.ts` | 会话 cwd 的清单发现（只扫一层、只认已声明扩展名、上报 `autoActivate` 与解析错误） |
| `src/workspace-guards.ts` | 跨多基集的路径规范化与包含判定 |
| `src/workspace-detector.ts` | 只读越权扫描与还原 |
| `src/native-reveal.ts` | 把一条已围栏的路径交给系统文件管理器（无 shell 的 argv，Explorer 退出码 1 视为已交接） |
| `src/client/multiroot-tab.tsx` | 内置右侧栏里的作业区页签 |
| `src/client/body-menu.tsx` | 空白处右键菜单的内容（一项「选择文件夹加入作业区」，加入即只读）与两种菜单共用的指针锚定卡片 `PointerContextMenu` |
| `src/client/row-menu.tsx` | 根目录行右键菜单的内容（移出作业区 / 改为只读或读写；隐含根两项禁用并说明原因） |
| `src/client/shortcut.ts` | 打开页签的快捷键命令（Ctrl+Alt+S；为何不是 Ctrl+O、不是 Ctrl+Alt+W、为何不写进 `inject`，文件头有完整证据） |
| `src/client/guide-artwork.tsx` | 起始页卡片的插图（内嵌 data URL；由 `scripts\make-guide-artwork.ps1` 生成） |
| `src/client/tree-metrics.ts` | 与内置「工作区文件」共享的度量与令牌（唯一事实来源，由测试钉住） |
| `src/client/tool-button.tsx` | 内置文件页 `.tool` 外观的按钮（页头动作与行内桌面动作共用） |
| `src/client/entry-order.ts` | 与内置一致的行序：目录优先 + 自然序、大小写不敏感 |
| `src/client/root-markers.tsx` | 根行名字右侧的小锁（内联 codicon 的 `lock` / `unlock`，CC-BY-4.0；点击切换权限）与悬停显示绝对路径的圆圈 i（ⓘ） |
| `src/client/reveal-button.tsx` | 行右侧的桌面动作：悬停时出现，点它把该行路径交给系统文件管理器 |
| `src/client/file-address.ts` | `dsh-resource://` 文件地址构造（由测试对着产品解析器锁定） |

## 出问题了：把插件摘掉

如果某个版本的插件让 DSH **起不来**，先把它从 profile 里摘掉，再启动。脚本**不依赖 dsh 能否运行**（纯文件操作，也不会重启你正在用的宿主）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-plugin.ps1 -DryRun   # 只看计划，不动任何东西
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-plugin.ps1 -Yes      # 真摘（默认扫全部 profile）
```

它会先把该 profile 的 `package.json` 备份到 `octopus-uninstall-backups\<时间戳>\`，然后删掉依赖声明、**`dsh.profile.bundles` 里的挂载项**、已安装的包目录与 `.pnpm` 项，并剥掉 `cordis.patch.yml` / `cordis.yml` 里挂载它的行，最后逐项复核没有残留（其它插件不受影响）。第二条是实测补上的：只删依赖项会让 profile 继续要求加载一个已经不在磁盘上的包，下次启动就会失败。修好之后装回去：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Yes
```

> 注意：`git reset --hard` **救不了**这种事故——插件那时已经装进 profile，与仓库状态无关，必须先把插件摘掉（或重装 DSH）。
>
> 另一个方向：本插件在你确认后还会改**你自己的清单文件**（右键加入文件夹、行右键移出、点小锁改权限）。那些改动与它们旁边的 `<清单名>.<时间戳>.octopus-backup` 备份都在清单所在目录，**不在 profile 里**，所以摘掉插件不会连它们一起删——撤销就是拿备份覆盖回去，或者手工把删掉的那一行加回来、把权限改回原值。卸载脚本最后也会把这条提示打出来。

---

## 由来与许可

本包从 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT，`omdsh-dev`）派生：该项目的多根工作区特性连同若干基础设施模块（`fs-tree` / `wire` / `trust-fence` / `session-path` / `context-types`）被保留并改写，其余侧边栏工作台功能全部移除。上游 MIT 署名见 [LICENSE](LICENSE)。

界面上根行的小锁是 Microsoft VS Code Codicons 的 `lock` 与 `unlock` 两个图标（[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)，作者 Microsoft Corporation），路径数据内联在 `src/client/root-markers.tsx`，完整署名与来源见该文件顶部注释。其余图标来自 DSH 自己的平台模块 `@deepseek-ai/dsh-client-ui-primitives`，不随本包分发。
