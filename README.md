# dsh-octopus-operation-space · 章鱼作业区

给 [DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 的**内置右侧栏**加一个多根工作区页签：用一份 JSONC 清单声明若干目录及各自的读写权限，未声明的路径一律只读。

> 这个包**只做这一件事**。文件浏览、预览与渲染全部交给 DSH 自身；本插件不含任何查看器、字节路由或媒体处理。

---

## 它做什么

- **多根目录**：一份 `*.dsh-octopus`（兼容旧名 `*.dsh-workspace`）清单一次列出多个根目录，侧边栏按会话隔离地展示与浏览。
- **逐目录读写权限**：每个目录声明 `readWrite` 或 `readOnly`，**未标注默认只读**。
- **只读保证**：插件自身**没有任何写入路由**——只读是结构性的，不是一层可绕过的校验。
- **越权检测与还原**：模型（或任何写者）写入只读根时，插件折叠会话事件日志给出记录，并尽力还原。
- **运行时技能**：随插件注册 `dsh-octopus` 技能，模型无需翻找范例即可按格式创建/编辑清单。

## 它不做什么

- **不含文件查看器**：点击文件会把一个 `dsh-resource://file/session/…` 地址交给 DSH 自身，由内置文档预览页签渲染（文本 / Markdown / 代码 / 图片 / PDF / Office / Excel）。这也是本插件能覆盖会话根之外目录的原因——宿主文件路由接受工作区内外两种绝对路径。
- **不接管内置页签**：它是一个新增的页类型，从 DSH 侧边栏的页签入口打开，不覆盖任何内置类型。
- **不重新沙箱化模型的工具**：模型侧的原生文件工具仍受 DSH 自己的会话 cwd 沙箱约束；声明在工作区里的额外目录由作业区浏览，不因此对模型放开。

---

## 安装

```bash
dsh plugin --profile web add dsh-octopus-operation-space
```

包内 `cordis.patch.yml` 会让该命令同时完成挂载（把插件行 `insert` 进 profile 的 bundle 栈），无需手工改 profile。

## 使用

1. 打开右侧栏的页签菜单，选择**章鱼作业区**。
2. 在面板里填入清单文件的绝对路径，回车或点「应用此作业区」。
3. 面板列出各根目录；点目录展开，点文件即在 DSH 的文档预览页签中打开。
4. 标题栏的三个动作：**⟳ 重新读取清单**（清单是唯一事实来源）、**越权计数**（点开看记录与还原）、**✕ 退出作业区**。

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
    "autoActivate": true            // 打开清单即应用，默认 true
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
| `settings.autoActivate` | 打开清单文件即应用，默认 `true` |

**会话目录是隐含的可写根**：除非清单显式列出了会话 cwd（此时以清单为准），否则它会作为隐含的 `readWrite` 根加入，避免把当前项目锁成只读。

## 只读是怎么保证的

两层，互相独立：

1. **结构性**：插件不暴露任何写入路由，因此它自己无法写出声明范围。
2. **检测与还原**：`workspace.violations` 折叠会话事件日志，报出落在只读根内的写入调用——不论由谁发起——并标注能否还原；`workspace.rollback` 对单条记录做尽力还原。

注意第 2 层是**尽力而为**的：它只在写入前的原内容仍可取得时才能还原。

## 要求与限制

- **DSH ≥ 0.1.5**：页签依赖 `ctx.sidebarRightTabs`。更早的宿主上插件能挂载，但没有可见界面（页签注册为 no-op，不会报错）。
- 平台：Windows / macOS / Linux 均可（路径大小写折叠按宿主判定）。
- 宿主重启后，进程内的作业区注册表是空的；此时客户端用本插件自己的键 `dsh-octopus:v1:<sessionId>` 记录过的清单路径重新激活。宿主一旦有状态，以宿主为准。
- 越权检测只覆盖会话事件日志窗口内的写入。
- **模型原生文件工具不因此放开**：额外目录对模型是否可见，取决于 DSH 自身的沙箱策略，与本插件无关。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit（宿主 + 客户端 + 测试 + 配置）
pnpm test        # vitest
pnpm build       # tsc 声明 + tsdown 产物
pnpm lint
```

`lib/` 产物约 270 KB（宿主 ESM + 两份客户端 CJS 闭包 + 类型声明）。

**依赖为零**：`dependencies` 为空；客户端只消费 DSH 冻结模块表里的平台模块（`react` / `react-dom` / `cordis` / `@deepseek-ai/dsh-client-ui-*`），由宿主在挂载时注入。

关键结构：

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 宿主入口：注册技能、挂载 `/octopus/api` 围栏路由 |
| `src/workspace-schema.ts` | 清单解析（JSONC、字段归一、默认值） |
| `src/workspace-policy.ts` | 根解析与读/写基集，路径分类 |
| `src/workspace-guards.ts` | 跨多基集的路径规范化与包含判定 |
| `src/workspace-detector.ts` | 只读越权扫描与还原 |
| `src/client/multiroot-tab.tsx` | 内置右侧栏里的作业区页签 |
| `src/client/file-address.ts` | `dsh-resource://` 文件地址构造（由测试对着产品解析器锁定） |

## 由来与许可

本包从 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT，`omdsh-dev`）派生：该项目的多根工作区特性连同若干基础设施模块（`fs-tree` / `wire` / `trust-fence` / `session-path` / `context-types`）被保留并改写，其余侧边栏工作台功能全部移除。上游 MIT 署名见 [LICENSE](LICENSE)。
