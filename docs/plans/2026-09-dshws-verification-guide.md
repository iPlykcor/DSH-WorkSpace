# DSHWS 多根工作区：换装与验证指南

> 分支 `DSHWS_Develop` 的功能已就绪（typecheck / build / 新增单测全绿）。以下步骤把
> 运行中的 profile 从 npm 版 `dsh-better-sidebar` 换成这份 fork 的本地构建，再逐项验收。
> 全程可回滚（见 §3）。**改 profile 前请先退出正在运行的 `dsh web`。**

## 0. 前置

- 确认已在本仓库构建：在 `DSHWS_Develop` 目录执行 `pnpm build`（产出 `lib/index.js`、
  `lib/client.js`、`lib/client-<chunk>.js`）。
- 定位 profile：默认 `C:\Users\E-peng.liu\.dsh\profiles\web`（下面以 `%PROFILE%` 代指）。

## 1. 换装（把 npm 版替换为本 fork 本地构建）

在 PowerShell 中执行（PowerShell 7；`%PROFILE%` 换成上面路径）：

```powershell
# 1) 备份（回滚用）
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json" "$env:USERPROFILE\.dsh\profiles\web\package.json.bak"
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml" "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml.bak"
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak"

# 2) 把依赖改指本地 fork（包名不变 dsh-better-sidebar，dsh.profile.bundles 不用动）
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add "file:D:/DSH_WorkSpace/dsh-workspace_Development/DSHWS_Develop"

# 3) 确认 package.json 里 dsh-better-sidebar 依赖变为 file: 指向（可选，肉眼检查）
# 4) 重新启动 dsh web，浏览器硬刷新（Ctrl+Shift+R）
```

说明：`dsh.profile.bundles` 仍引用包名 `dsh-better-sidebar`，只需换依赖来源；包内 `cordis.patch.yml`
挂载行不变。**不要**同时装 npm 原版与本 fork（同包名冲突；若想对比，用另一个 profile）。

## 2. 验收清单

### A. 无清单行为不变
1. 打开新会话/切到任意旧会话：右侧 sidebar 与之前完全一致（单根 = 会话目录树、编辑、上传、Git 均正常）。

### B. 多根工作区加载（准备素材已放在会话目录：`demo/rw`、`demo/ro`、`多根演示.dsh-workspace`）
2. 在资源管理器点开 `多根演示.dsh-workspace`（或让模型打开该文件）。
3. 预期：自动应用并聚焦“文件窗口”，树顶显示工作区条：名称 + 根数；下面每个根一个头行：
   `demo/rw`(可写)、`demo/ro`(🔒 只读，未标注默认只读)、`新人培养`(🔒 只读)、会话目录(隐含可写根，演示时会并入)。
4. 点根头行可折叠/展开；刷新页面后该会话自动恢复多根（状态持久化 + host 重激活）。

### C. 权限执行（硬拦截）
5. 在 `demo/ro` 里尝试：右键菜单 **没有** 新建/重命名/删除/上传到此处；拖文件到该根被拒（提示只读）；
   在编辑器里强改 `demo/ro/说明.txt` 后 Ctrl+S → host 403（read-only workspace folder）。
6. 在 `demo/rw` 里以上操作全部正常。
7. 工作区条“✕退出多根工作区” → 立即回到单 cwd 树；再次打开清单可重新应用。

### D. agent（模型）写入只读目录检测
8. 让模型“把一句话追加写入 demo/ro 里一个新文件” → 宿主侧模型工具仍可写（会话工作区内、RO 语义由本插件检测），
   侧边栏树顶应出现红色 chip「只读越权写入 N 处」；点开可见文件与时间，可「打开」复核或「还原」
   （事件窗内有旧内容/反向 edit 时成功，否则给出人工复查提示）。
9. 让模型写 demo/rw → 不产生告警。

### E. 会话隔离
10. 会话1 激活该清单后切到会话2：会话2 仍是单根/自己的布局；切回会话1 恢复多根。

### F. 观察日志（排查用）
11. host 侧日志出现 `[dshws] activate session=... roots=...` 与 `deactivate` 记录（`dsh web` 控制台/日志文件）。

## 3. 回滚（还原 npm 原版）

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json.bak" "$env:USERPROFILE\.dsh\profiles\web\package.json" -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml.bak" "$env:USERPROFILE\.dsh\profiles\web\pnpm-lock.yaml" -Force
pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" install
# 重启 dsh web 即可
```

## 4. 已知限制（v1）

- agent 原生工具只受宿主沙箱约束（会话工作区）；目录级只读对 agent 是“检测+告警+最佳努力还原”，非硬拦
  （强度 B 需宿主核心改造，另议）。工作区在会话 cwd 之外的根，agent 工具本来不可达。
- Git 写类拦截按仓库/工作树所在根判定；可写仓库内的嵌套只读子目录不做 git 级逐文件拦截。
- 编辑器保存按钮不做显式只读置灰（保存走 host 403 报错）。
- `fs.search`（文件名搜索）仍以会话 cwd 为根。
- 还原依赖会话事件窗内的旧内容；超窗/无前文时提示人工复查。
- 第三方覆盖语言的 workspace 文案暂为 zh-Hant(近似)+英文兜底（zh/en/ja 完整）。
