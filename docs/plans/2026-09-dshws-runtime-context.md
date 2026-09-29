# 作业区标签进入运行时上下文（0.9.0）

> 规则要点见 [AGENTS.md](../../AGENTS.md) §3.14 / §4 / §5；这里记"为什么这么做"、当时量到的东西、以及踩到的那个只在构建里现形的坑。

## 问题

作业区的**标签**是清单里写的名字（`./demo/rw` → `rw`，`D:/现场问题` → `现场问题`），而它们正是用户说话时用的词。0.8.0 之前标签只存在于 `octopus_space` 工具的**输出**里：模型必须先**想起来调用**它，才能把"看一下 VS调试"里的 `VS调试` 解析成绝对路径。第一轮、以及任何一轮模型没想到调工具的时候，这个标签就是个未知 token——结果是猜一个路径，或者问一个用户觉得显而易见的问题。

## 决策

把**标签表**作为**运行时上下文**（`systemPrompt.context`）随每一次组装交给模型；**绝对路径仍然只由工具给出**。

理由是**付费频率**：动态上下文按**每轮**付费，工具结果按**每次调用**付费。同一份十根快照，报告里每个根都要 `标签 = 绝对路径`（既有实测：线格式约 385 token，报告约 144），把它整份放进上下文，等于用"每轮 144"换"每会话省一次调用"。于是分工是：

| 通道 | 内容 | 何时付费 |
| --- | --- | --- |
| 运行时上下文（`workspace-context.ts`） | 标签、权限分组、`missing` / `implicit` 标记 | 每轮组装 |
| 工具 `octopus_space`（`workspace-tool.ts` + `workspace-report.ts`） | 上面这些 **+ 每个根的绝对路径 + 清单路径** | 每次调用 |

被否掉的方案：整份报告进上下文（按上表，贵在每轮）；只把路径放进上下文、不给标签（用户说的不是路径，等于没解决问题）；按 agent 作用域注册（`dsh-agent` 的会话作用域也能做到，但需要的挂载钩子更多，而 `AssembleContext.agent` 已经在手，等有实测需求再说）。

## 实现

- `src/workspace-report.ts` 新增 `renderSpaceLabels(snapshot, toolName)`：一行、按权限分组、只列标签，与报告**共用** `markersOf` / `withMarkers`（`implicit` 先于 `missing`，理由与报告一致）。工具名由调用方传入——报告模块若 import 工具模块就成环。
- `src/workspace-context.ts` 是**纯工厂**：`createSpaceContext(registry)` 返回 `PromptContext`（`name: 'octopus-space'`、`order: 130`、`text` 是每次组装求值的 provider）。`order` 是数字，服务自带的运行时上下文是 110 沙箱策略 / 115 审批 / 120 子代理委派，作业区描述"这个会话能动什么"，排在策略之后。
- `src/index.ts` 的 `apply` 里注册：`ctx.inject(['systemPrompt'], (scope) => ctx.effect(() => scope.systemPrompt.context(createSpaceContext(registry)), '…'))`。**`systemPrompt` 绝不进插件级 `inject` 数组**——本包是从 profile patch 层挂载的外部插件，声明基础 bundle 提供的服务会让 DSH 起不来（§3.1，0.3.1 实测）。
- **空文本零成本**：服务丢弃空串，所以无 `agent`（诊断组装）与无激活作业区都返回 `''`；provider 每次求值读**活**注册表，于是后应用的作业区**下一轮**就出现，不需要重挂插件。

## 踩到的坑（值得单独记）

`AssembleContext.agent` **不是** `@deepseek-ai/dsh-system-prompt` 自己声明的字段，而是 `@deepseek-ai/dsh-agent` 对该接口的**合并扩展**——而合并增强只对"加载了那个模块"的程序生效。于是第一次跑门禁时出现了这种组合：

- `pnpm typecheck` **通过**（测试程序另有导入，把 `dsh-agent` 的类型带进了 program）；
- `pnpm build` **失败**：`src/workspace-context.ts(63,33): error TS2339: Property 'agent' does not exist on type 'AssembleContext'`（`tsconfig.build.json` 只编译 `src/`）。

修法是 `src/workspace-context.ts` 里一句 `import type {} from '@deepseek-ai/dsh-agent'`：只拉类型、无绑定、运行时被擦除，所以两个包都停在 devDependencies，零运行时依赖不变。**教训**：一行 `ctx.inject` 的服务接口如果有合并扩展，src-only 构建与全量 typecheck 看到的世界可以不一样——"四道门禁"里 typecheck 绿不代表 build 绿。

## 这次加的门禁

- `tests/workspace-context.spec.ts`（7 例，真实 `WorkspaceRegistry` + 临时清单）：名字/`order` 稳定、激活后标签与工具名到位且**没有任何绝对路径**、无激活/未知会话/无 `agent` 三种空串、provider 读活注册表、会话隔离。
- `tests/workspace-report.spec.ts`（+8 例）：标签表逐字节格式、分组与顺序、两个标记、**任何根路径都不得出现**、工具名单一来源、体积守卫（标签表长度 < 报告长度的一半）、空根返回空串。
- `tests/host-routes.spec.ts`（+2 例，假 ctx 补上 `inject` 与 `systemPrompt`）：挂载面恰好一份注册、注册名与 `order` 与常量一致、provider 在激活前后与无 `agent` 时的三种回答。
- `scripts\smoke.ps1`：宿主**真的收下**这份注册——注册发生在 `apply` 里，服务拒收就是插件加载失败，冒烟的 loader / inject 检查会红。

**仍然没有自动门禁的部分**：客户端渲染（与内置一致的那条老限制），以及"模型在一次真实会话里是否真的用上了标签"——后者只能靠一次真实会话观测。
