# 更新日志 (Changelog)

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录显著变更。
版本号与 `package.json` 保持一致，Git 标签使用小写 `v` 前缀（`vX.Y.Z`）。

> 本 fork 基于 [@omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）改进，
> 保留上游架构与许可，仅做增益。上游 v0.12.0 ~ v0.18.x 的历史记录见上游 README / Releases，此处不重复。

## [v0.0.6] - 2026-09-07

### 修复
- **中间“文件”视图工具栏固定**：`预览 / 编辑 / 保存` 图标不再随内容滚动。根因是标题栏的直接父容器 `centerFileEditor` 为 `overflow:hidden`，导致 `position:sticky` 被近邻的“非滚动”容器困住、无法向真正滚动的 `scrollBody` 钉住；改为外层 `overflow:visible`、标题栏 `position:sticky; top:0`，并对滚动容器生效，工具栏始终留在顶栏；同时给标题栏加 `--dsw-alias-bg-layer-1` 不透明背景，与侧边栏一致。

## [v0.0.5] - 2026-09-07

### 修复
- **中间列 pptx 显示比例过小**：OfficeView 改为显式撑满容器宽高（`width/height:100%`），中间“文件”视图不再用居中的媒体包装——pptx 在中间列按容器宽度正常缩放，不再被缩成小缩略图。

## [v0.0.4] - 2026-09-07

### 修复
- **xlsx 预览修复**：改用 **SheetJS → 带边框表格**（合并单元格经 colspan/rowspan），替换此前不稳定的 FortuneSheet 网格——侧边栏与中间“文件”视图现在都能正确预览 `.xlsx`（只读）；office chunk 体积由 ~8MB 降到 ~3MB。
- **中间“文件”视图支持 Office**：`docx / xlsx / pptx` 现在在中间列也能预览（此前侧边栏 OK、中间列报“暂不支持”）。
- OfficeView 可从 `scope+path` 自行取字节，兼容侧边栏（customData）与中间列（自取）两种入口。

## [v0.0.3] - 2026-09-07

### 新增
- **Office 三件套内联预览**（新格式 `docx / xlsx / pptx`）：侧边栏与中间“文件”视图直接预览。
  - **docx**：`docx-preview`（MIT）——接近 Word 版式的 DOM 渲染。
  - **xlsx**：SheetJS（Apache-2.0）解析 + `@fortune-sheet/react`（MIT，x-spreadsheet 的现代 React 继任）样式化表格网格（含合并单元格）。
  - **pptx**：`@aiden0z/pptx-renderer`（Apache-2.0）——DOM/SVG 幻灯片渲染（可读版式，非像素级完美）。
- 以上库打包进**懒加载 `office` chunk**（首开 Office 约 8MB，按需加载，不拖累首屏）。
- 新增 `/sidebar` 办公室查看器：`docx` / `spreadsheet` / `presentation`。
- 移除“推荐插件目录”里的外部 office 插件（AGPL 风险，现已内置）；老版 `.doc / .ppt / .xls` 维持“下载查看”。

### 说明
- 版本号重编为 `0.0.3`（侧边卡片显示 `DSH-WorkSpace v0.0.3`）。

## [v0.0.2] - 2026-09-07

### 新增
- **mp4 / 音视频内联预览**：在侧边栏与中间“文件”视图直接播放 `.mp4` 等视频（并支持常见音频格式）。
  新增 `/sidebar/video` **流式宿主路由**，支持 HTTP Range（206），进度条可拖动、不受 20MB `mediaLimit` 限制。
- **视频查看器**：内置 `video` 查看器（扩展名覆盖 mp4/webm/mov/mkv/avi 等 + mp3/wav/ogg/flac 等），
  浏览器解码失败时自动回落“下载查看”。

## [v0.0.1] - 2026-09-06

### 新增
- **多根工作区**：`*.dsh-workspace`（JSONC）清单一次列出多个根目录；打开清单即应用为多根树，
  按会话隔离、刷新自动恢复。
- **目录读写权限**：每目录 `readWrite | readOnly`（未标注默认只读）；侧边栏读/写/改名/删除/上传与
  Git 写类按策略硬拦截（只读根 403 + UI 禁用）。
- **只读越权检测**：模型写入只读目录时，基于会话事件流检测 + 侧边栏告警 + 最佳努力还原。
- **中心列文件视图**：向 `conversation.view` 注册“文件”页签，与“对话 / 轨迹”并排；文本可编辑、图片/PDF 预览。
- **一键刷新生效 / 折叠**：改完清单点 ⟳ 即重读；新应用默认全部收起 + 一键折叠全部。

### 说明
- 基于 dsh-better-sidebar 重构为 **DSH-WorkSpace**（npm 包名 `dsh-workspace`，插件 id `dsh-external/dsh-workspace`），
  并替换旧 dsh-better-sidebar 的 profile 安装部署。
