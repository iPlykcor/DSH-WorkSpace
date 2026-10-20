# 目录逐层展开到底层（0.9.2）

## 需求

> 现在的章鱼作业区虽然可以查看目录，但是只能查看一层（如图中 `VS调试` → `Doc` 中的内容就无法查看），请做到层层都能查看直到底层。

## 诊断：不是取不到，是画不出

宿主侧一开始就支持任意深度：`fs.tree` 只做 `readTargetOf`（`ensureWsReadTarget` 的 realpath + 声明根包含判定）再 `listDirectory(target, LIST_LIMIT)`，**没有层级概念**。所以 `VS调试\Doc` 这个路径与 `VS调试` 走的是同一条路由、同一道围栏。

问题在客户端。0.9.1 的 `multiroot-tab.tsx` 里：

- `toggle(path)` 会把路径塞进 `expanded`，并在 `children` 里没有这一层时调 `loadChildren(path)` —— **取数是通的**；
- `renderRows(parent, depth)` 只渲染 `children.get(parent)` 那一层 —— **它不递归**。

于是点开一个子目录时：状态变了、图标从闭合变成打开、网络请求也发了、`children` 里也存下了新的一层，但**没有任何代码去画它**。用户看到的就是"点了没反应"，而控制台、宿主日志、以及当时全部测试都干净——因为递归本该发生的位置在 JSX 里，没有任何断言能碰到它。

页面表现能对上：`VS调试` 是打开状态的文件夹图标、列出了 `Doc` / `Frequency Analysis` / 若干文件；`Doc` 是闭合图标，点它什么都不会多出来。

## 修法：把"该画哪些行"抽成数据

`renderRows` 里内联递归是无法测试的，所以拆成两个单元：

| 单元 | 职责 | 测试 |
| --- | --- | --- |
| `src/client/tree-rows.ts` · `treeItems(parent, depth, children, expanded)` | 纯函数：把"已展开的子树"展平成**一行一条**的序列（含 `loading` / `empty` 两种占位行），任意深度 | `tests/tree-rows.spec.ts` |
| `src/client/tree-view.tsx` · `FsTreeLevel` | 只负责画：把 `TreeItem[]` 变成行与占位行的 JSX，持有悬浮/聚焦（桌面动作）那套 plumbing | `tests/tree-view.spec.tsx` |

标签页主体现在只剩一行 `renderRows`：

```tsx
<FsTreeLevel items={treeItems(parent, depth, children, expanded)} … />
```

其它同批改动：

- **占位行跟着缩进**：新增 `noteStyleAt(depth)`（`tree-metrics.ts`）。`loading` / `empty` 以前钉死在 `padding: 3px 10px`，深层的占位行会贴在面板最左边，看着像丢了位置的幽灵行；现在与它代表的那些行同缩进（`10 + 18×depth`）。`tests/tree-metrics.spec.ts` 钉住这个式子，并断言它返回副本、不污染共享的 `noteStyle`。
- **`client-tab.spec.ts` 的死键扫描**把 `tree-view.tsx` 也算作文案调用方（`loading` / `emptyFolder` / 两个桌面动作气泡搬过去了）。

## 终止性与边界

- **不会成环**：子行的 `path` 总是父行 `path` 的延长，同一个路径不可能出现在自己下面；递归只在 `expanded` 里走，所以深度 = 用户点开的层数。路径长度本身是天然上限。
- **懒加载，不是预取**：折叠的子树一个字节都不取；展开一层 = 一次 `fs.tree`。
- **只展开目录**：`expanded` 里即使有文件路径（陈旧状态、或某个目录后来变成了文件）也会被忽略，不递归。
- **没有加人为深度上限**：能点到的深度受路径长度限制，加个魔数只会制造一个"为什么这里断了"的新问题。

## 测试

`tests/tree-rows.spec.ts`（9 例）——展平：

- 四层链（`VS调试` → `Doc` → `Scripts` → `deploy.ps1`）逐行比对顺序与深度；
- 折叠的子树即使缓存里有也不画；
- 展开但没取到的那层给 `loading` 占位，空目录给 `empty` 占位，两者深度都落在被展开目录的子层；
- 根层自己还没取到时也是 `loading`；
- 顺序与内置面板一致（目录优先 + 自然序）；
- 文件路径在 `expanded` 里不递归；
- 24 层深链不丢层（最后一项是第 25 层的 `loading`）；
- 不改动入参（列表、`children`、`expanded`）。

`tests/tree-view.spec.tsx`（6 例，jsdom）——绘制：

- 四层全部出现在渲染结果里且顺序正确，`padding-left` 依次 `28 / 46 / 64 / 82`（= `10 + 18×深度`）；
- 折叠目录的下一层不出现；
- 三个打开的目录都带 `aria-expanded="true"`，文件行没有 `aria-expanded`；
- 展开但未取到的目录下面那行占位缩进到子层（`46px`，没有 `64px`）；
- 桌面动作只在"宿主有文件管理器 + 该行悬浮"时多出一个 `<button>`（槽位常驻，所以行不会跳）；
- **点一个嵌套文件夹 → `onToggle` 收到它自己的路径**；点文件 → `onOpenFile`（这条就是"点了没反应"的回归门禁）。

## 仍无法自动断言的

仓库没有浏览器 lane（`AGENTS.md` §2），所以**像素级观感**与"展开动画/滚动位置"仍要人眼复核。层数、顺序、缩进、`aria-expanded`、点击去向这五项已经被测试钉住。
