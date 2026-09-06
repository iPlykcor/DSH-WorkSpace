# DSHWS：多根工作区（`.dsh-workspace`）设计

> 分支 `DSHWS_Develop`（fork omdsh-dev/DSH-better-sidebar @ 0.18.0 基线）。
> 目标：给现有右铡栏加"多根工作区"能力——打开 `*.dsh-workspace` 清单文件后，
> 资源管理器以清单内各目录为多根显示；每目录带 `readOnly` / `readWrite` 权限，
> 在插件能力范围内**硬拦截**（服务端 403 + UI 禁用），并对模型 agent 写入只读目录
> 做**会话事件检测 + 告警 + 最佳努力还原**。无清单激活时行为与上游完全一致。

## 1. 背景与已核实事实

- better-sidebar 单根模型：explorer 根 = 会话 cwd（`Sidebar.tsx` 从 session 列表取
  `summaryCwd` / `api.sessionCwd` 兜底）；服务端全部 fs 路由经
  `ensureWorkspacePath / ensureWorkspaceWritePath`（`src/path-security.ts`）把路径围栏
  锚在会话 cwd；总开关 `workspaceFence`（`src/config.ts` PrefsSchema）。
- 文件"打开"走 viewer 注册表（`ctx.betterSidebar.registerFileViewer`，按扩展名/detect
  匹配，内置 6 viewer，`code` 为兜底 catch-all）。扩展名 viewer 是拦截"打开 .dsh-workspace"
  的自然钩子。
- 会话布局持久化在浏览器 localStorage `dsh-sidebar:v1:<sessionId>`（`state.ts`），
  reload 恢复；host 进程无该状态。
- 会话事件日志 `ctx.sessions.get(id).snapshotEvents()` 只读可用；`src/client/changes/ops.ts`
  的 `extractFileOps()` 是"原始事件 → 文件操作（write/edit/read + 路径 + 载荷 + 旧内容）"
  的纯函数——host 端可直接移植做检测与还原；`/sidebar/api` 已有 `changes.ops` 路由先行。
- DSH 宿主沙箱把 agent 工具限制在会话工作区（单根）。**因此模型只可能写会话 cwd 之内**；
  清单中位于会话 cwd 之外的只读根，agent 天然写不到（无需检测），插件侧 sidebar 读写
  按本设计放行/拦截。

## 2. 设计决策（记录备查）

- **默认安全**：清单内未显式标注的目录 `access = readOnly`（用户拍板"安全优先"）；
  顶置 `settings.defaultAccess: "readWrite"` 可整体翻转；目录显式
  `{ "access": "readWrite" }` 放行。
- **包含会话 cwd**：激活清单时，若 cwd 未被清单列出，自动以隐含根
  `access: readWrite` 加入（保持"当前项目目录始终可写可用"的直觉，避免激活动作
  锁死当前会话）；若 cwd 被列出则以清单标注为准。
- **重叠取最长前缀**：路径归属取"匹配最长的根"（并列时先列者胜），从而支持在
  隐含 rw cwd 内把某子目录标为 readOnly。
- **激活范围替换**：有活动工作区时，服务端路径围栏从"锚 cwd"换成"活动策略
  （根集合 + 每根 access + 隐含 cwd 规则）"；无活动工作区走原路径（原逻辑零改动）。
  清单激活是显式信任动作（类比 VSCode 信任窗口），授予对所列目录的 读/写（按 access）。
- **权威在 host**：活动工作区状态存 host 进程 Map<sessionId, ActiveWorkspace>；
  client 把解析快照写入 SidebarState（localStorage 持久化）用于即时渲染与刷新恢复，
  会话 attach / reload 后 client 调 `workspace.state`，空则按快照里 manifestPath
  自动重新激活（host 重读文件解析；文件已删则报错并回退单根）。
- **清单解析**：strict JSON 优先，失败退 JSONC（去注释/尾逗号，字符串安全）；
  相对路径相对**清单文件所在目录**解析（同 VSCode code-workspace）。
- **agent 检测（强度 A）**：host 扫描活动工作区会话的 `snapshotEvents()`，按
  `extractFileOps` 同款映射取 write/edit 类 op，路径解析到绝对后命中只读根 →
  记 violation（去重 by callId/时间窗），经 `workspace.violations` 下发；
  "还原"用事件载荷做最佳努力（反向 edit / 已知旧内容回写），不可还原则指引打开复查。
- **i18n/皮肤**：新增 UI 文案 zh/en 同步 ja；只用 `--dsw-alias-*`/`--ds-*` 令牌。
- 分支纪律：全部改动提交/推送到 `DSHWS_Develop`；关键路径加 `[dshws]` 前缀日志
  （host `ctx.logger` / client `console`，`localStorage['dshws.debug']` 开 debug）。

## 3. 文件格式

```jsonc
{
  "version": 1,                       // 可选，未来迁移用
  "name": "我的多根工作区",            // 可选；树顶标题/缺省用文件名
  "folders": [
    { "path": "C:/repo/a", "access": "readWrite" },
    { "path": "../docs", "access": "readOnly" },   // 相对清单文件目录
    "C:/repo/b"                                      // 字符串简写（默认 access）
  ],
  "settings": {
    "defaultAccess": "readWrite",     // 可选；readWrite|readOnly（默认 readOnly）
    "autoActivate": true              // 可选；打开文件即应用（默认 true）
  }
}
```

校验：folders 为空/缺省 → 错误；path 非空绝对或相对可解析；access 非法 → 行级错误；
目录不存在 → `exists:false` 标灰不阻断；重复 canonical 根 → 去重并提示。

## 4. 模块与改动面

### host 新增
- `src/workspace-schema.ts`（共享/无 Node）：类型（`DshWorkspaceFolder`/`AccessMode`/
  `ResolvedWorkspaceRoot`/`DshWorkspaceFile`）、JSONC strip、`parseWorkspaceText()`、
  默认值/错误（行级、`SidebarError` 语义之外用结构化 error）。
- `src/workspace-policy.ts`（Node）：`resolveWorkspaceFile(dir, text)` → 解析并 realpath
  各根（缺失标 exists:false）、相对路径解析、隐含 cwd 根合并、`WorkspacePolicy` 纯判定：
  `classify(absolutePath)` → `{ root?, access, inRoots }`（最长前缀 + 大小写容忍，win32）。
- `src/workspace-state.ts`（Node）：`Map<sessionId, ActiveWorkspace>`；activate（读文件、
  parse、构建 policy、存状态、返回快照）/ get / deactivate / clearForSession；日志。
- `src/workspace-route.ts` 或并入 index.ts：API `workspace.state` / `workspace.activate` /
  `workspace.deactivate`；`workspace.violations` + `workspace.rollback`（复用事件→op 映射，
  映射常量与 ops.ts 一致并注释同源）。
- 路由门控（index.ts / fs-operations 调用点 / upload / git / file 路由）：
  读类 op 用 `policyReadTarget(...)`：有活动策略→目标必须落在根集合（含隐含 cwd）；
  写类 op 用 `policyWriteTarget(...)`：落根且该根 `readWrite`，否则 `SidebarError('forbidden',
  …, 403)`（"read-only workspace folder"）。无策略时原逻辑不动（零回归）。
  Git 写类（stage/unstage/commit/checkout/discard/revert/cherry-pick）以仓库根（selected
  或 cwd）命中只读根为据拒绝；读类放行。上传路由同写类。

### client 改动
- `state.ts`：`SidebarState.workspace?: SidebarWorkspaceState`（manifestPath/name/roots/
  每个 root {path,label,access,exists}）；sanitize 白名单 + 序列化 + reducer
  `setWorkspace/clearWorkspace`。
- `api.ts`：`workspaceState/activate/deactivate/violations/rollback` 调用。
- `workspace-model.ts`（共享纯函数 client 侧副本，仅用于 UI 判定；权威仍在 host）：
  `rootOf(path, roots)` 最长前缀匹配、`isReadOnlyPath(...)`。
- `Sidebar.tsx`：会话 attach/hydrate 后拉 `workspace.state` → set/clear store.workspace
  （store 按会话隔离，天然不串）。
- `FileTree.tsx`：根区从"单 cwd 头行"变为"`roots` 列表头行"（每根：名 + 锁徽标 +
  @引用/上传；drop 目标为该根）；`renderLevel(root.path,1)` 照旧；锁根内隐藏
  重命名/删除/在此上传菜单、禁止拖放上传、@引用/复制/下载/打开保留；无工作区时
  渲染完全等同现状（roots=[cwd] 兼容路径，头行样式不变）。行内锁定判定用
  workspace-model。
- `TreePanel.tsx`：非查询态顶部在"有活动工作区"时渲染工作区条（名 + N 根 +
  "退出多根"按钮）+ 只读越权告警 chip（轮询 violations，>0 高亮，弹层列出路径与
  时间，每条"还原/打开"）。
- viewer：`builtins/viewers.tsx` 增加 `dsh-workspace` viewer（exts:['dsh-workspace'],
  priority 高于 code），组件 `WorkspaceFileView`：解析展示（根/权限/exists 灰显）、
  默认自动 apply（manifest `settings.autoActivate` 与全局 pref 双控）、"应用/刷新/
  退出"按钮、raw JSON `<details>`。内置 viewer 数 6→7（同步 builtins 相关测试）。
- 文本编辑器：内容落在只读根时工具栏存盘禁用 + 打开提示（save 依赖服务端 403 兜底）。

### 测试新增/同步
- `tests/workspace-schema.spec.ts`、`tests/workspace-policy.spec.ts`、client 锁判定单测；
- `builtins.spec.ts` viewer 清单 7；i18n 新增 key 同步 locales(zh/en) + ja + locales.spec；
- 若 manifest-consistency/其它枚举 src 文件清单的测试被新增文件触发，同步之。

## 5. 验收场景

1. 清单含 A(会话内, rw) B(cwd 外, rw) C(cwd 内子目录, ro) → 打开自动应用：树多根、
   C 有锁；C 内新建/重命名/删除/上传/保存 403 + UI 禁用；A 正常；刷新恢复。
2. 模型写 C 下文件 → 告警 chip 出现且可还原（事件窗内）；写 A 无告警。
3. 退出多根 → 立即回到单 cwd 树；无清单会话零变化。
4. 两会话各自独立清单互不干扰；清单文件缺失 → 激活报错并回退。

## 6. 非目标 / 已知限制

- agent 原生工具对 cwd 外目录的读写由 DSH 宿主沙箱决定，插件不改宿主（强度 B 外移）。
- fs.search 仍以会话 cwd 为根（多根全局搜索留待后续）。
- 还原为事件窗内的最佳努力（无宿主级快照）。
