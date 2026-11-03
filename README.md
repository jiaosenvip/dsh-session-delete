# dsh-session-delete

为 DeepSeek Harness (DSH) 增加「彻底删除会话」能力：侧栏会话行的 `…` 菜单里多一项 **删除会话…**，另有 `/delete-session` 命令。

删除会同时清掉三样东西：

| 位置 | 内容 |
|---|---|
| `~/.dsh/sessions/<cwd>/<session-id>/` | 会话正文（`session.v4.jsonl.zstd`） |
| `~/.dsh/storages/session_projcache/sessions/<session-id>.json` | 侧栏列表用的投影索引 |
| `~/.dsh/storages/workspace.json` 的 `sessionIds` | 工作区分组成员 |

如果这条会话本次运行中还驻留在 Host 内存里（打开过），插件会先关掉写入句柄、卸载 Agent、把它移出会话表，所以**删完侧栏那一行会立刻消失，刷新后也不会回来**，不需要重启 DSH。

## 要求

- DeepSeek Harness `0.2.x`（桌面版或 `dsh web`）。
- 浏览器端需要 `dsh-client-ui-workspace`（标准 Web/桌面组合自带）。
- 无第三方依赖：Host 侧只用 Node 内置模块，浏览器侧只用 loader 提供的 `react` 和 ui-primitives。

## 安装

### 方式一：压缩包直接放进 profile（最简单）

1. 解压，把 `dsh-session-delete` 整个目录放到：

   ```
   ~/.dsh/profiles/<profile>/plugins/dsh-session-delete/
   ```

   Windows 一般是 `C:\Users\<你>\.dsh\profiles\desktop\plugins\dsh-session-delete\`。

2. 在该 profile 的 `cordis.patch.yml` **末尾追加**：

   ```yaml
   - insert:
       - id: session-delete
         name: ./plugins/dsh-session-delete/entry.js
   ```

   相对路径会按 patch 文件所在目录解析。

3. 完全退出并重开 DeepSeek Harness（Host 侧代码只在启动时加载，刷新页面不够）。

### 方式二：作为 bundle 安装（tgz）

`dsh-session-delete-0.3.0.tgz` 已经声明了 `dsh.bundle.patch`，安装后由它自己的 patch 层插入插件行，不用手写 YAML。

- **图形界面**：侧栏 **Plugins** 页 → **Add plugin** → 填入 tgz 的绝对路径（或 `file:C:\path\dsh-session-delete-0.3.0.tgz`）→ 安装。安装成功后会默认启用。
- **命令行**：

  ```powershell
  dsh plugin --profile desktop add "file:C:\path\dsh-session-delete-0.3.0.tgz"
  ```

  然后确认该 profile 的 `package.json` 里 `dsh.profile.bundles` 包含 `"dsh-session-delete"`（命令行安装不会自动加，图形界面会）。

改完重启 DSH。

> 两种方式任选其一。同时用会出现两条 entry（id 不同），表现为菜单里出现两个「删除会话…」，请删掉其中一条。

## 用法

### 侧栏菜单

会话行悬停 → `…` → **删除会话…** → 确认。结果以右上角提示条呈现：

- 3 秒左右自动消失，不打断当前对话、草稿和滚动位置；
- 如果删的正是屏幕上这条会话，主区域会自动切到**同一工作区的新会话**；拿不到导航服务时退回无会话首页；
- 删的是后台会话时，不会把你从正在看的对话里拽走。

### 命令

```
/delete-session                列出全部会话（id、标题、工作目录、大小）
/delete-session <id前缀>        按 id 前缀删除
/delete-session <标题片段>      按标题删除（命中多条时只列候选，不删）
```

### 调试

设置环境变量 `DSH_SESSION_DELETE_DEBUG=1` 后，插件会把启动与删除步骤追加到 `%TEMP%\dsh-session-delete.applied`（macOS/Linux 为 `$TMPDIR`）。默认关闭，普通使用不写任何额外文件。

## 行为与边界

- **正在运行的会话会被拒绝**（HTTP 409 / 命令返回错误）：先停止再删，避免把正在作答的一轮拆成半截。
- **不可恢复**：没有回收站，没有撤销。
- **附件不删**：`~/.dsh/attachments` 是内容寻址共享存储，可能被其他会话引用，插件刻意不动。
- **同 id 的多条命中**：命令按前缀/标题匹配，命中多条时只列候选。
- **当前会话**：命令行会拒绝删除「正在运行这条命令的会话」；侧栏菜单删当前会话是允许的（删完自动换页）。

## 卸载

1. 从 profile 的 `cordis.patch.yml` 删掉那段 `insert`（方式一），或从 `dsh.profile.bundles` 移除 `"dsh-session-delete"` 并删除依赖（方式二）。
2. 删除 `plugins/dsh-session-delete` 目录（方式一）或执行 `dsh plugin --profile desktop remove dsh-session-delete`（方式二）。
3. 重启 DSH。

已删除的会话不会因为卸载插件而回来。

## 已知限制

- 依赖 Host 内部对象（`agents` / `sessions` / `sessionPersistence` 的写入表）做热卸载，这些是带 `try/catch` 的兜底路径：某个服务缺席只会让「行立即消失」退化为「重启后消失」，不会阻断文件删除。
- 只处理 `session.v4` 的存储布局；未来若持久化格式改版，插件需要同步调整。
- 不做跨机器/远程 Host 的删除（只操作本机 `~/.dsh`）。

## 版本

- `0.3.0` — 可分发的 bundle 形态；调试标记改为按需开启。
- `0.2.2` — 删除当前会话后自动换到同工作区新会话。
- `0.2.1` — 结果改用右上角提示条，不再刷新页面。
- `0.2.0` — 热卸载驻留会话 + 清理 workspace 账本，删除立即生效。
