# 章鱼作业区 · 内网离线部署说明

> 包版本 **{{PLUGIN_VERSION}}**　构建自提交 `{{DSHWS_COMMIT}}`　生成时间 {{BUILT_AT}}
>
> 这个包给**不能访问 npm 仓库**的机器用。它自带已经构建好的插件产物，安装过程是**纯文件操作**：不需要 npm、不需要 pnpm、不需要任何网络。

## 1. 包里有什么

| 路径 | 作用 |
| --- | --- |
| `install-offline.ps1` | **推荐入口**：把插件装进某个 DSH profile，并写好两处挂载项；装前备份、装后校验、失败自动回滚 |
| `uninstall-plugin.ps1` | 卸载（纯文件操作，不依赖 `dsh` 能否启动） |
| `package/` | 已经构建好的插件包（`lib/`、`src/`、`package.json`、`dsh.plugin.json`、`cordis.patch.yml`、`README.md`、`LICENSE`） |
| `dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz` | 同一份产物的 npm tarball（内网若有 registry 或已有 pnpm 缓存，也可以走官方 `dsh plugin add`） |
| `SHA256SUMS.txt` | 上面每个文件的 SHA256，安装脚本会拿它逐文件核对 |
| `INSTALL-OFFLINE.md` | 本文件 |

插件本身**零运行时依赖**（`package/package.json` 的 `dependencies` 为空），它的 `peerDependencies`（`@deepseek-ai/dsh-*`、`react`）全部由 DSH 自己的安装提供——所以离线安装不需要解析任何依赖树，这也是"复制目录 + 写两处挂载项"就能与官方安装结果一致的原因。

## 2. 前置条件

1. **这台机器上已经装好 DSH**（全局 `dsh` 命令可用），版本要落在插件声明的兼容范围内：

   ```
   ^0.1.7-rc.1 || ^0.2.0-rc.1      即 0.1.7-rc.1 <= 版本 < 0.3.0
   ```

   已在 **0.1.7-rc.2** 与 **0.2.0-rc.1** 上实测。查版本：

   ```powershell
   (Get-Content "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\package.json" | ConvertFrom-Json).version
   ```

   > 本包**不包含 DSH 本身**。如果内网机器还没装 DSH，需要先另行准备 DSH 的离线安装（那是另一套依赖树），本包只负责把插件挂上去。
   >
   > 版本不匹配时**必须拒绝安装**：不匹配的 bundle 会在启动时被 DSH 的 `reportSkippedBundles` 静默跳过——界面表现是页签凭空消失，而日志里**没有**任何插件报错。`install-offline.ps1` 因此会先探测版本，读不到或超出范围就停下（确实要装时用 `-Force`）。

2. **该 profile 已经成形**：目标 `${DSH_HOME}\profiles\<profile>\package.json` 必须存在。全新机器上先让 DSH 自己建好 profile：

   ```powershell
   dsh web --port 0 --no-open      # 起来后 Ctrl+C 停掉；它会写 profile 与基座 bundle
   ```

3. **`DSH_HOME`**：默认 `%USERPROFILE%\.dsh`；如果你设了 `$env:DSH_HOME`，脚本会自动跟随（也可用 `-DshHome` 显式指定）。

4. **PowerShell 5.1 即可**（Windows 自带）；脚本输出刻意保持纯 ASCII，中文只在文档里。

## 3. 安装

### 方式 A（推荐）：离线安装脚本

把整个包目录拷到内网机器上，然后在**包目录**里执行：

```powershell
# 先看计划，不写任何东西
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -DryRun

# 真正安装
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes
```

它会依次做这些事（每一步都打印 `PASS`/`FAIL`）：

1. 读 `package/package.json`，确认包完整（`lib\index.js`、`lib\client.js`、`lib\client-registry.js`、`lib\invariant.js`、`dsh.plugin.json`、`cordis.patch.yml` 一个都不能少）；
2. 找到目标 profile，**先备份**它的 `package.json` 到 `profiles\<profile>\octopus-offline-backups\<时间戳>\`；
3. 探测 DSH 版本并判定兼容性（不通过就拒绝，除非 `-Force`）；
4. 复制 `package/` → `profiles\<profile>\node_modules\dsh-octopus-operation-space\`（若已装过旧版，旧目录被改名保留为 `…replaced-<时间戳>`，而不是直接删掉）；
5. 写**两处**挂载项：`dependencies["dsh-octopus-operation-space"]`（`file:` 指向包里的 tarball）**和** `dsh.profile.bundles[]`；
6. 逐文件比对 `SHA256SUMS.txt`，回读 `package.json` 确认两处挂载项都在；
7. 任何一步失败：**还原** profile 清单、还原被替换的旧目录、清掉半成品，然后以失败退出。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-DryRun` | 只打印计划，不落盘 |
| `-Yes` | 不再交互确认 |
| `-DshHome <目录>` | 指定另一个 DSH home（也是脚本自己的演练入口） |
| `-Profile <名字>` | 默认 `web` |
| `-Force` | 版本探测无法确认兼容时仍安装 |

### 方式 B：官方 CLI（内网有 registry 或 pnpm 缓存时）

```powershell
dsh plugin --profile web add file:D:/path/to/dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz
```

这条路与联网安装完全一样；它需要 pnpm 能解析（至少要从 registry 取元数据）。内网**没有** registry 时请用方式 A。

### 方式 C：手工两步（脚本被策略拦住时的兜底）

1. 复制目录：`package\` → `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-octopus-operation-space\`
2. 编辑 `%USERPROFILE%\.dsh\profiles\web\package.json`，**两处都要写**：

   ```jsonc
   {
     "dependencies": {
       "dsh-octopus-operation-space": "file:D:/path/to/dsh-octopus-operation-space-{{PLUGIN_VERSION}}.tgz"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-octopus-operation-space"
         ]
       }
     }
   }
   ```

   > **只写 `dependencies` 不写 `bundles`＝什么都没挂上；只写 `bundles` 不写 `dependencies`＝profile 要求加载一个它找不到的包，下次启动直接失败。** 这两处必须同时存在（AGENTS.md §2）。
   >
   > 写文件时用 **UTF-8 无 BOM**（Windows PowerShell 5.1 的 `-Encoding UTF8` 会写 BOM）。`install-offline.ps1` 走 .NET 写入就是为了避开这一点。

## 4. 安装后怎么验证

1. **重启 `dsh web`**（安装脚本**绝不**替你重启：装好只在下次启动生效，杀掉正在跑的宿主会丢掉用户手上的事）。
2. 侧边栏应出现「章鱼作业区」页签；内置起始页出现同名卡片，带说明文字与快捷键 **Ctrl+Alt+S**（macOS 是 ⌘⌥S）。
3. 宿主日志（`dsh web` 的控制台）里应当**没有** `loader` / `inject` / `duplicate prefix route` 之类的失败行。
4. 打开页签，放一份 `*.dsh-octopus` 清单到会话工作目录，或在面板里粘贴清单路径；随后应看到按权限分组的根目录列表。
5. **模型侧**（{{PLUGIN_VERSION}} 新增）：新开一个会话，直接说「看一下 &lt;某个标签&gt;」——标签表已经随每轮请求进入模型上下文，模型应当**直接**把它解析成绝对路径，不需要先试探；需要绝对路径时它会调用 `octopus_space` 工具。

## 5. 升级

把新的离线包解开，用同样的命令再跑一次即可：脚本会替换 `node_modules` 里那份并保留旧目录、重新备份清单、重新校验哈希。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-offline.ps1 -Yes
```

装完确认 `-DryRun` 输出里的 `package` 版本是你期望的那个，然后重启 `dsh web`。

## 6. 卸载与回滚

```powershell
# 推荐：纯文件操作，不依赖 dsh 能否启动
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-plugin.ps1 -Yes

# 彻底回到安装前：把备份的清单放回去
Copy-Item '%USERPROFILE%\.dsh\profiles\web\octopus-offline-backups\<时间戳>\package.json' `
          '%USERPROFILE%\.dsh\profiles\web\package.json' -Force
```

> 卸载脚本**不会**回滚插件界面改动过的 `.dsh-octopus` 清单文件——那些文件在用户自己的项目目录里（旁边留有 `.octopus-backup` 时间戳备份），不在 profile 里，任何卸载工具都不该替用户改它们。

## 7. 已知坑（都踩过）

- **不要用通配 `-Filter` 去清 profile 目录**：PowerShell 5.1 的 `-Filter 'package.json.*'` 会因 8.3 短名匹配连 `package.json` **本身**一起命中。删掉它之后 `dsh plugin remove` 会把该 profile 当成新 profile 重新初始化，本插件的挂载项随之消失。
- **`cordis.yml` 的内容不代表挂载状态**：它每次启动都被无条件重写（正常内容就是注释 + 空 `[]`）。判断插件是否挂载只认 profile `package.json` 的那两处。
- **不要把 `dsh web` 的进程杀掉再"重启"**：如果你手上还有未完成的会话，那会一并丢掉。
- **不要改 DSH 自己的安装**：本插件是独立包，靠 profile 引用挂载，不侵入 DSH。

## 8. 完整性校验

```powershell
# 在包目录里，逐文件核对（与安装脚本用的是同一份清单）
Get-Content .\SHA256SUMS.txt |
  ForEach-Object { if ($_ -match '^([0-9A-Fa-f]{64})\s+\*?(.+)$') {
      $want = $Matches[1].ToUpper(); $file = $Matches[2]
      $got = (Get-FileHash $file -Algorithm SHA256).Hash
      "{0}  {1}" -f $(if ($got -eq $want) { 'OK  ' } else { 'BAD ' }), $file } }
```
