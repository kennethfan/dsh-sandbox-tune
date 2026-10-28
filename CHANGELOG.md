# Changelog

## 0.11.2

README 精简：移除「故障排查」章节（30 行）。

该章节记录的是**开发期问题**（设置页不显示、bash 工具消失、改了没生效），
不是使用者需要的内容。这些知识已转入长期记忆，需要时可直接调用。

同时清理目录中对应的失效链接。README 从 538 行降到 507 行。


## 0.11.1

补充文档：说明重定向为什么不做路径判断。

`>` `<` 一律不放行，即使目标目录可写。原因不是「懒得判断」，而是
**两个层面的事不能混**：

- 能不能写这个路径 → 沙箱白名单（`sandboxRoots` / `userDirs`）
- 要不要升权 → 命令内容（命令授权规则）

如果规则要判断目标路径，就得解析命令再解析路径，而重定向路径可以写成
任意形式（`../`、`$(echo /tmp)/`、符号链接），静态分析无法可靠判断，
判错就是放行任意文件写入。

同时补充说明：**重定向本身不触发审批**，只有目标真被沙箱拒绝时才产生
审批请求。所以规则不放行重定向，不会让「本来能过的命令」多弹一次。

想让某目录可写，正确做法是授权目录（粒度是「该目录可写」），
而不是放行重定向命令（粒度是「该命令可执行」，且路径判不准）。

其他修正：
- 模式对比表里 safe-args 的说明从「不含 shell 组合构造」改为
  「按段校验，每段都须匹配规则」—— 前者是 0.11.0 之前的行为，已过时。


## 0.11.0

safe-args 改为**拆分检测**：`&&` `||` `;` `|` 连接的命令按段校验。

原行为：只要含组合构造就整体拒绝，即使 A 和 B 都在规则里，
`A && B` 也弹窗。这与实际使用习惯冲突 —— 模型经常串联步骤。

新行为分两步：
1. **不可拆分的构造整体拒绝**：重定向 `> <`、命令替换 `` ` `` `$(`、
   变量展开 `${`、后台 `&`。这些拆开看每段都放行，但实际效果危险
   （`cmd > ~/.zshrc` 会改写配置）。
2. **可拆分的按段校验**：`&&` `||` `;` `|` 拆开后，**每段都必须在规则里**
   才放行。`go build && go test`（两段都放行）通过，
   `go build && rm -rf /`（第二段未命中）拒绝。

细节：
- 管道两段都要放行：`go build | tee log` 需要规则里有 `go build` 和 `tee`。
- 拒绝时指出**具体哪一段没通过**，便于区分「漏配规则」和「命令有问题」。
- 引号内的分隔符会被误拆（`echo "a && b"`），但误判方向是**更严格**，
  不会放行本该拒绝的命令。保守方向正确，不写 shell 词法分析器。


## 0.10.0

**行为变更**：数组类字段的会话覆盖从「替换」改为「叠加」。

原行为：全局 `sandboxRoots: [/A]`，会话加 `/B` → 最终只有 `[/B]`，
`/A` 静默失效，而界面上看不出任何提示。这不符合「追加」的直觉，
也是很难排查的坑。

新行为按字段类型区分：
- `presets` / `userDirs` / `sandboxRoots`：叠加并去重，全局在前 → `[/A, /B]`
- `env`：按 key 合并，同名 key 会话优先
- `mode` / `enabled` / `cacheRoot` / `autoDetect`：仍为替换（标量无叠加概念）

已知取舍：叠加后**会话无法移除全局项**，想移除只能改全局配置。
这是选择叠加时接受的代价 —— 相比整体替换，叠加更符合直觉，也不会让
全局授权静默失效。已在 README 与弹窗提示中写明。


## 0.9.2

全局设置页的列表字段同步改成表格形态。

上一版只改了会话级 Modal，全局页仍用旧的「多行文本框」（LinesField），
两边交互不一致。这次统一：

- 「授权规则」（autoApproveCommands）→ ListEditor：逐条添加、每行带删除按钮
- 「额外授权目录」（sandboxRoots）→ ListEditor
- 固定选项的「工具预设」「探测哪些工具」保持 Chips 标签按钮 ——
  只有 5 个固定值，点选比「输入再添加」快，也能一眼看出哪些开启
- 移除死代码 LinesField

与会话级的差异：全局页是「先编辑后保存」，所以 ListEditor 只写草稿
（onCommit 传 setDraft）；会话级是即时提交（onCommit 走命令）。


## 0.9.1

列表字段改为逐条添加 / 删除的表格。

原来 presets / userDirs / sandboxRoots / env 四个字段是「逗号分隔的文本框」，
问题有两个：
- 路径和值本身可能含空格与逗号（macOS 的 `Application Support`、env 的
  `A=1,B=2`），挤在一个文本框里容易输错；
- 看不出当前到底有几项、分别是什么。

改成：输入框 + 「添加」按钮，已添加项显示为表格行，每行右侧有删除按钮。
每次增删立刻提交给 Host（不做本地暂存），避免界面显示与真实配置不一致。

env 字段也改成列表形态（每行一条 `KEY=VALUE`），提交时用逗号拼接，
Host 侧仍解析成对象 —— 链路已实测：`['A=1','B=2']` → `{A:'1',B:'2'}`。


## 0.9.0

会话级设置改用官方 Modal 弹窗。

原来是自己画的下拉层（320px 宽、绝对定位），8 个字段挤在一列里很难看，
而且缺焦点陷阱、遮罩、aria 语义。

- 改用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`：它自带
  portal、焦点陷阱、Escape、遮罩点击、`role="dialog"` / `aria-modal`。
  该包在平台共享模块表里，直接 require 即可，不需要写进 `dsh.client.external`。
- 布局改成两列表单（窄屏自动降为单列），字段名旁标注对应的配置键。
- 底部操作区：查看当前 / 清除覆盖 / 状态提示。
- 命令授权不可会话级这件事，改成弹窗内的一条醒目提示。


## 0.8.2

修正会话级与全局级配置关系的自相矛盾表述。

问题：`OVERRIDABLE` 里同时列着 `autoApproveMode` / `autoApproveCommands`，
而它们又在 `NON_INHERITABLE` 里。结果是 `/sandbox-tune` 的帮助文本宣称
这两个字段「可设置」，实际写入却被拒绝 —— 自相矛盾的提示比没有提示更糟。

- `OVERRIDABLE` 剔除命令授权两项，现在是 8 项
- 新增 `ALL_SETTINGS`（10 项）用于状态展示：要完整列出当前值，
  但可设置项要严格
- `validateOverride` 区分两类拒绝：命令授权是「已知但仅全局」，
  未知字段才是「拼错了」，两种提示不能混
- 状态输出分成两段：可覆盖的 8 项 + 「以下仅全局生效」的 2 项
- 会话面板补上 env / autoDetect，与 Host 侧字段完全对齐


## 0.8.1

设置页顶部加一条作用域提示。

设置页里的配置是**全局**的（写 profile，对所有会话生效），而会话级设置在
会话头部的「沙箱调优」按钮里。不加提示的话，用户会一直在设置页找会话级
选项 —— 功能存在却找不到，等于没有。

提示用「全局」徽标 + 一句话说明，并给出两种会话级入口（按钮 / 命令）。


## 0.8.0

会话级配置的图形入口：会话头部的「沙箱调优」按钮。

- 注册 `conversation.session.header.actions`（`kind: 'list'`、`scope: 'session'`），
  组件与 inject 都能拿到 sessionId —— 设置页是全局面板拿不到会话，所以
  会话级设置放在这里。
- 面板支持模式、启用、缓存目录、工具预设、用户级目录、额外授权目录，
  以及「查看当前」「清除覆盖」。
- 面板读写都走 `/sandbox-tune` 命令，与命令入口共用同一套 Host 逻辑，
  不在前后端各写一份校验（两份校验迟早会不一致）。
- 点击外部或 Escape 关闭，与其它头部弹层行为一致。

踩坑：浏览器侧访问服务必须先在 `inject` 里声明，`ctx.get('sessions')`
不是 `ctx.sessions` 的等价写法（官方包都用后者）。这与 Host 侧相反 ——
Host 侧 `ctx.get()` 反而更适合可选依赖。


## 0.7.0

会话级配置的交互入口：斜杠命令 `/sandbox-tune`。

- `/sandbox-tune` 查看本会话生效配置，**标出每个值来自会话还是全局**
  ——否则用户看不出覆盖是否生效，整个会话级功能就形同虚设。
- `/sandbox-tune set <字段> <值>` 改本会话设置，支持全部 10 个字段。
  值按字段类型解析（数组逗号分隔、布尔 true/false、env 用 KEY=VALUE）。
- `/sandbox-tune reset` 清除本会话覆盖。
- 校验在写入前完成：非法值返回 error 且不写入，不会留下半条配置。

为什么用命令而不是设置页：设置页是全局面板，拿不到「当前会话」上下文。
斜杠命令天然绑定会话（`invocation.agent.session`），前端也已有现成的
`live.command()` 通道，省掉一整套 Remote API 与跨进程鉴权。

实现细节：用 `ctx.get('commands')` 而不是 `ctx.commands` —— 后者要求插件
在 `inject` 里声明 "commands"，会让插件在没有该服务的组合里加载失败。
`ctx.get()` 是可选查询，不建立依赖关系。

测试：116 项单元（新增 22 项命令相关）+ 10 项集成。


## 0.6.0

会话级配置：同一台机器上不同会话可以有不同设置。

- 覆盖表存在进程内 Map（按 sessionId 键），优先级为
  会话覆盖 > 全局配置 > 内置默认。
- 可覆盖全部 10 个配置项（mode / cacheRoot / presets / env / enabled /
  autoDetect / userDirs / sandboxRoots / autoApproveMode / autoApproveCommands）。
- **命令授权两项永不通过会话覆盖生效**：它们放宽的是 danger-full-access
  升权，必须每次显式开启。写入时直接拒绝（而非存进去再过滤），
  避免「返回成功但实际没生效」这类静默失败。
- 内存表的退化方向是安全的：进程重启后回到全局配置，不会意外保留宽松设置。
- in-place 覆盖在后端不支持时仍安全回退 redirect。

修复两个导致插件加载失败的缺陷（表现为 bash 工具消失、报 unknown tool "bash"）：
- 移除了 `sessionProjections.register` 调用：它的 `stateSchema` 要求 **zod**
  的 `ZodType`，而本插件用 schemastery，注册时抛错导致整个插件 apply 失败
  → `ctx.shell` 不存在 → `dsh-tool-bash` 无法激活。
- 修掉编辑时残留的孤立右花括号（executor.js / session-config.js 语法错误）。

会话 id 从 `spec.sandboxPolicy.sessionId` 取，不是 `request.agent`：
tool-bash 调 `shell.resolve()` 时只传 command/workdir/dshEnv/sandboxPolicy，
不带 agent。


## 0.5.0

Windows 支持。

- **按平台选择执行器基类**：Windows 继承 `SandboxPwshExecutor`（PowerShell），
  其余平台继承 `SandboxBashExecutor`。此前一律继承 bash 版本，Windows 上会去跑
  `bash -c` 而 Windows 通常没有 bash，会把 shell 功能弄坏。
- **patch 同时禁用 `pwsh-sandbox`**：它与 `bash-sandbox` 都注册 `ctx.shell`，
  base 本身按平台二选一；只禁一个会在 Windows 上抢服务。
- **Windows 明确回退 redirect**：ACL runner 的写授权是 SID（`--write-sid`），
  无法从 argv 追加路径白名单，因此 `in-place` 在 Windows 上不可用，自动回退。
- **平台路径约定**：缓存根用 `%TEMP%`，配置目录用 `%APPDATA%`，
  缓存/数据目录用 `%LOCALAPPDATA%`（此前一律 `~/.cache`，Windows 上不是标准位置）。
- `user-cache` 预设收窄为 XDG 的 `~/.cache`，**不授权** macOS 的
  `~/Library/Caches`（系统级缓存，本机 5.9GB，远超工具缓存范围）。
- 类名 `CacheBashExecutor` → `CacheSandboxExecutor`，保留旧名别名。
- 新增 9 项 Windows 兼容性测试（含反向验证：把 `user-cache` 改回
  `Library/Caches` 时测试会失败）。


## 0.4.0

- 新增**命令授权**（`autoApproveMode` / `autoApproveCommands`）：在审批链上按规则
  自动批准沙箱升权，减少重复弹窗。默认 `off`。
  - `exact`：命令与规则逐字符相同才放行（最安全）。
  - `safe-args`：命令以规则开头且不含 `&& ; | > \` $() &` 等 shell 组合构造。
  - 刻意不提供前缀通配 —— `go build` 放行等于放行 `go build && rm -rf ~/x`。
- 实现方式：`tools/pre-execute` 记录 `callId → 命令`，`approval/request` 用
  `callId` 查回并按规则判定（审批事件本身不含命令内容）。
- 只处理以 `escalate sandbox to` 开头的沙箱升权审批，其他审批一律交回原链。
- 每次自动放行写 info 日志并保留最近 100 条记录（审计需要）。
- 设置页新增授权模式与规则编辑区，带 danger-full-access 风险提示。


## 0.3.0

- 新增**用户级目录预设**（`userDirs`）：把 `~/.config`、`~/.cache`、
  `~/.local/share`、`~/.local/state` 加入沙箱可写白名单，解决「开发工具必须写
  工作区外配置」导致的弹窗（占历史审批 27%）。默认全不授权，需显式勾选。
- 与「按命令放行」的区别：命令仍在沙箱内执行，只是多了几个可写目录，
  不会把整条命令提权到 danger-full-access。
- 设置页新增用户目录勾选区，每项展示收益与风险。
- 修正 `probeBackendCapability()`：只勾用户目录、关闭自动探测时，能力判定
  不再误报为不支持。


## 0.2.0

首个版本。两种模式消除 `go build` 类命令的提权弹窗。

- **`redirect`（默认）**：`dsh-sandbox-tune/executor` 替换 bash 执行器，
  把纯缓存（`GOCACHE` / `NPM_CONFIG_CACHE` / `BUN_INSTALL_CACHE_DIR` /
  `PIP_CACHE_DIR`）重定向到 `$TMPDIR/dsh`。任何沙箱后端都可用。
- **`in-place`**：`dsh-sandbox-tune/provider` 替换沙箱 provider，把工具
  **真实的**缓存目录追加进可写白名单（Seatbelt / bwrap）。路径不变，
  与普通终端共用缓存。
- **自动路径探测**：`go env GOCACHE` / `go env GOMODCACHE` /
  `npm config get cache` 等，避免静态默认值猜错（本机 gvm 的 GOMODCACHE
  不在 `~/go/pkg/mod`）。
- **安全回退**：`in-place` 遇到不支持的后端（Landlock / Windows ACL）
  自动降级为 `redirect`，不会停在「既不授权也不重定向」的状态。
- **依赖仓库与纯缓存分开**：`store` 类（`GOMODCACHE` / `CARGO_HOME`）
  永不重定向 —— 指到空目录会让 `go build` 直接找不到模块。

测试：25 项单元测试 + 10 项集成测试（真实插件组合下验证两种模式的
`resolve()` 输出、danger-full-access 不注入、调用方 env 保留）。
