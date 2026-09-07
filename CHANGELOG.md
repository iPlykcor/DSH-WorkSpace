# 更新日志 (Changelog)

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录显著变更。
版本号与 `package.json` 保持一致，Git 标签使用小写 `v` 前缀（`vX.Y.Z`）。

> 本 fork 基于 [@omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）改进，
> 保留上游架构与许可，仅做增益。上游 v0.12.0 ~ v0.18.x 的历史记录见上游 README / Releases，此处不重复。

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
