# dsh-sandbox-tune

让 DSH 沙箱适配开发工具：缓存重定向、可写目录授权、按规则自动批准升权，
减少重复的提权审批弹窗。

---

## 目录

- [问题：为什么会有弹窗](#问题为什么会有弹窗)
- [功能总览](#功能总览)
- [两种工作模式](#两种工作模式)
- [安装](#安装)
- [全局配置](#全局配置)
- [会话级配置](#会话级配置)
- [命令授权规则](#命令授权规则)
- [作用域与优先级](#作用域与优先级)
- [安全回退](#安全回退)
- [平台支持](#平台支持)
- [验证](#验证)
- [已知限制](#已知限制)
- [故障排查](#故障排查)

---

## 问题：为什么会有弹窗

DSH 的文件沙箱（`workspace-write`）只允许写三个地方：

```
工作区目录  +  /tmp  +  用户临时目录($TMPDIR)
```

而构建工具默认把缓存写到工作区之外：

| 工具 | 默认位置 | 在沙箱内 |
|---|---|---|
| Go 编译缓存 `GOCACHE` | `~/Library/Caches/go-build` | ❌ 拒绝写 |
| Go 模块缓存 `GOMODCACHE` | `~/gvm/.../pkg/mod` | 读 ✅ / 写 ❌ |
| npm `NPM_CONFIG_CACHE` | `~/.npm` | ❌ 拒绝写 |
| Cargo `CARGO_HOME` | `~/.cargo` | ❌ 拒绝写 |

于是每条编译命令都被内核拒绝（macOS Seatbelt 报 `Operation not permitted`），
模型只能申请 `danger-full-access` 提权 —— 这就是弹窗的来源。

实测对比（同一沙箱内）：

```
GOCACHE=~/Library/Caches/go-build  go build ./...   → exit 1（operation not permitted）
GOCACHE=$TMPDIR/dsh/go-build       go build ./...   → exit 0 ✅
```

## 功能总览

本插件针对四类弹窗，按占比排列（基于本机 517 次历史审批统计）：

| 弹窗原因 | 占比 | 本插件的解法 |
|---|---|---|
| Go 等构建缓存写不进去 | 28% | 缓存重定向 / 原地授权 |
| 写工作区外的用户配置目录（`~/.config` 等） | 27% | 用户级目录预设 |
| `gh` 读钥匙串 | 19% | ❌ 不支持（非文件路径问题） |
| 写 `~/.dsh` 的 profile 配置 | 11% | 部分（可用 `sandboxRoots` 授权） |
| 其余（进程管理、删除清理等） | 15% | ❌ 不适合用白名单放宽 |

### 三个能力模块

| 模块 | 作用 | 作用域 |
|---|---|---|
| **缓存处理** | 把纯缓存重定向，或授权真实缓存目录 | 全局 + 会话 |
| **可写目录授权** | 把用户级目录加入沙箱白名单 | 全局 + 会话 |
| **命令授权** | 按规则自动批准沙箱升权 | **仅全局** |

## 两种工作模式

`mode` 决定缓存怎么处理。**只在执行器（`sandbox-tune-bash`）上配置一处**，
provider 会自动跟随。

| 模式 | 做法 | 与终端共用缓存 | 后端要求 |
|---|---|---|---|
| **`redirect`**（默认） | 用环境变量把纯缓存指到 `$TMPDIR/dsh` | ❌ 两套独立 | 任何后端 |
| **`in-place`** | 路径不变，把真实缓存目录授权为可写 | ✅ 完全共用 | Seatbelt / bwrap |

**为什么默认 `redirect`**：它只依赖环境变量，任何平台都能用，不需要沙箱
支持追加白名单。

**什么时候用 `in-place`**：想与普通终端共用同一份缓存（避免冷启动、不重复占
磁盘）。代价是依赖沙箱后端能力 —— 不支持时会自动回退到 `redirect`。

### 一个必须区分的前提

缓存分两类，可重定向性**完全不同**：

| 类型 | 例子 | 丢了会怎样 | 处理方式 |
|---|---|---|---|
| **纯缓存**（`cache`） | `GOCACHE`、`NPM_CONFIG_CACHE`、`PIP_CACHE_DIR` | 只是变慢 | 可重定向 |
| **依赖仓库**（`store`） | `GOMODCACHE`、`CARGO_HOME` | **编译直接失败** | 只可原地授权 |

把 `GOMODCACHE` 指到空目录，`go build` 会立刻报「找不到模块」，**比弹窗更糟**。
所以 `redirect` 模式只动 `cache` 类；`store` 类只在 `in-place` 下被授权。

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-sandbox-tune
```

或把它加入 profile 的 `dsh.profile.bundles`。插件自带 `cordis.patch.yml`，
会自动禁用 base 的 `bash-sandbox` / `pwsh-sandbox` / `sandbox` 三行并替换成
自己的实现（同名服务不能重复注册，所以原行必须禁用）。


## 全局配置

全局配置写在 profile 的 `cordis.patch.yml`，对所有会话生效，保存后立即生效
（volatile 字段，无需重启）。

### 执行器（`sandbox-tune-bash`）

```yaml
- id: sandbox-tune-bash
  name: 'dsh-sandbox-tune/executor'
  config:
    enabled: true
    mode: redirect            # redirect | in-place
    cacheRoot: ''             # 仅 redirect 用；空 → $TMPDIR/dsh
    presets: [go, npm, bun, pip]
    env: {}                   # 额外/覆盖环境变量
    autoApproveMode: off      # off | exact | safe-args
    autoApproveCommands: []
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时完全退化为原生执行器 |
| `mode` | `redirect` | 见[两种工作模式](#两种工作模式) |
| `cacheRoot` | `$TMPDIR/dsh` | 仅 redirect 模式使用，支持 `~` |
| `presets` | `['go']` | 启用哪些工具的缓存预设 |
| `env` | `{}` | 追加或覆盖的环境变量，优先级最高 |
| `autoApproveMode` | `off` | 命令授权模式，见[命令授权规则](#命令授权规则) |
| `autoApproveCommands` | `[]` | 命令授权规则列表 |

> **`cacheRoot` 放哪？** 默认在 `$TMPDIR` 下，好处是无需额外授权就能写；
> 代价是 macOS 会周期性清理临时目录，重启后首次编译要冷启动。
> 想持久化就改成工作区内路径（如 `cacheRoot: .dsh/cache`，记得加 `.gitignore`），
> 或者直接切到 `in-place`。

### provider（`sandbox-tune-provider`）

```yaml
- id: sandbox-tune-provider
  name: 'dsh-sandbox-tune/provider'
  config:
    enabled: true
    autoDetect: true          # 自动探测真实路径
    presets: [go, npm, bun, cargo]
    sandboxRoots: []          # 手工追加的额外目录
    userDirs: []              # 用户级目录预设，默认全不授权
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不改沙箱 |
| `autoDetect` | `true` | 跑 `go env` / `npm config get cache` 等探测真实路径 |
| `presets` | `['go']` | 要探测哪些工具 |
| `sandboxRoots` | `[]` | 手工追加的额外目录，支持 `~` |
| `userDirs` | `[]` | 用户级目录预设，见下 |

### 自动探测为什么必要

本机用 gvm 管理 Go，`GOMODCACHE` 在 `~/.gvm/pkgsets/go1.26.0/global/pkg/mod`，
而静态默认值会猜 `~/go/pkg/mod` —— **猜错就会授权一个不存在的目录，等于没授权**。

探测命令（都是只读，Host 侧执行，不受沙箱限制）：

| 预设 | 探测命令 |
|---|---|
| `go` | `go env GOCACHE` / `go env GOMODCACHE` |
| `npm` | `npm config get cache` |
| `bun` | `bun pm cache` |
| `pip` / `cargo` | 无探测，用静态默认值 |

探测失败时回落到静态默认值，单个工具失败不影响其他工具。

### 用户级目录预设

| 预设 | 目录 | 收益 | 风险 |
|---|---|---|---|
| `user-config` | `~/.config` | CLI 配置目录，最常见来源 | 可读写所有 CLI 配置 |
| `user-cache` | `~/.cache` | 通用缓存（npm/pip/bun） | 较低，缓存可被篡改 |
| `user-data` | `~/.local/share` | 应用数据 | 可修改应用数据，含数据库 |
| `user-state` | `~/.local/state` | 运行状态与日志 | 较低，可被伪造 |

**默认全部关闭**：放宽文件写入边界是有代价的，必须显式勾选。

> `user-cache` 刻意**不用** macOS 的 `~/Library/Caches`：那是系统级缓存
> （本机实测 5.9GB，含 Docker / AndroidStudio / CloudKit），远超「工具缓存」
> 的范围。只用 XDG 风格的 `~/.cache`。

## 会话级配置

同一台机器上不同会话可以有不同设置：做实验时放宽，动生产代码时收紧。

### 两种入口

**入口一：会话头部按钮**

会话标题右侧有「**沙箱调优**」按钮，点开是 Modal 弹窗：

- 模式、启用、缓存根目录、工具预设、用户级目录、额外授权目录、环境变量、自动探测
- **查看当前**：在会话流里打印生效配置（标出来源）
- **清除覆盖**：回到全局配置

**入口二：斜杠命令**

```
/sandbox-tune                                  查看本会话生效配置
/sandbox-tune set mode in-place                改模式
/sandbox-tune set presets go,npm               改预设
/sandbox-tune set cacheRoot /tmp/my-cache      改缓存目录
/sandbox-tune set env A=1,B=2                  追加环境变量
/sandbox-tune reset                            清除本会话覆盖
```

### 命令语法

| 值的类型 | 语法 | 例子 |
|---|---|---|
| 字符串 | 原样（支持空格） | `set cacheRoot /Users/k/Library/Application Support/x` |
| 布尔 | `true` / `false` | `set enabled false` |
| 数组 | 逗号分隔 | `set presets go,npm,bun` |
| 对象 | `KEY=VALUE`，逗号分隔 | `set env A=1,B=2` |

非法值会在写入前被拒绝，不会留下半条配置。

### 会话级不能改的字段

`autoApproveMode` 与 `autoApproveCommands` **只能全局设置**：

它们放宽的是 `danger-full-access` 升权。如果允许按会话设置、并随 fork 或
恢复历史会话带过去，你可能几天后完全不记得那个会话开着宽松规则。

写入时会直接报错（不是「存进去但不生效」——后者更难排查）。

### 覆盖存在哪

进程内 Map（按 sessionId 键）。**进程重启后回到全局配置** ——
这个退化方向是安全的，不会意外保留宽松设置。

## 命令授权规则

有些弹窗靠放宽路径解决不了（命令要写工作区外的任意位置）。本插件提供
**命令级自动批准**，但安全边界必须说清楚。

### 它放行的是什么

自动批准的是 `danger-full-access` **升权** —— 放行后整条命令不受文件沙箱限制。
而 bash 命令是任意 shell 程序：

```
go build ./...                        ← 你想放行的
go build ./... && rm -rf ~/Documents  ← 危险，但前缀一模一样
```

所以**不提供前缀通配**，只提供两种模式：

| 模式 | 判定规则 | 安全性 | 实用性 |
|---|---|---|---|
| `off`（默认） | 一律不放行 | — | — |
| `exact` | 命令与规则**逐字符相同**（忽略首尾空白） | 最高 | 低 |
| `safe-args` | 以规则词开头**且不含 shell 组合构造** | 中 | 较高 |

### safe-args 如何判定

分两步：

**第一步：拒绝不可拆分的构造**

| 构造 | 用途 | 为什么拆分也救不了 |
|---|---|---|
| `>` `<` | 重定向 | `cmd > ~/.zshrc` 拆开看 `cmd` 放行，但实际改写配置 |
| `` ` `` `$(` | 命令替换 | 内容无法静态校验，可塞任意命令 |
| `${` | 变量展开 | 同上，可注入 |
| `&` | 后台执行 | 脱离等待，输出与退出码都拿不到 |

**第二步：按 `&&` `||` `;` `|` 拆分，逐段匹配规则**

**每一段都必须在规则里**，整条命令才放行：

| 命令 | 规则 `go build, go test` | 结果 |
|---|---|---|
| `go build ./...` | ✅ 命中 | 放行 |
| `go build && go test` | ✅ 两段都命中 | **放行** |
| `go build \|\| go test` | ✅ 两段都命中 | **放行** |
| `go build ; go test` | ✅ 两段都命中 | **放行** |
| `go build && rm -rf /` | ❌ 第二段未命中 | 弹窗 |
| `go build \| sh` | ❌ `sh` 未命中 | 弹窗 |

管道两段都要放行：`go build \| tee log` 需要规则里有 `go build` **和** `tee`。

拒绝时会指出**具体哪一段没通过**，便于判断是漏配规则还是命令本身有问题。

> **引号内的分隔符会被误拆**（`echo "a && b"` 会拆成两段）。这个误判方向是
> **更严格**（多一段要匹配规则，可能被拒），不会放行本该拒绝的命令。
> 保守方向正确，就不需要写一个容易出错的 shell 词法分析器。

### 规则匹配细节

| 规则 | 能匹配 | 不能匹配 |
|---|---|---|
| `go build` | `go build`、`go build ./...`、`go build -v` | `go buildx`、`gofmt` |
| `go test ./internal/...` | 完全相同的命令 | `go test ./other/...` |

规则后面必须跟**空白**才算命中，避免 `go` 误匹配 `google-chrome`。

### 配置示例

```yaml
- id: sandbox-tune-bash
  config:
    autoApproveMode: safe-args
    autoApproveCommands:
      - go build
      - go vet
      - go test
```

### 只作用于沙箱升权

判定条件之一是审批原因以 `escalate sandbox to` 开头。其他审批（hook 的权限
请求等）一律交回原链，不擅自放行。

### 每次放行都留日志

```
sandbox-tune: 自动批准升权 "go build ./..."（规则 "go build"）
```

审计需要，不是可选项。

## 作用域与优先级

### 优先级

```
会话覆盖  >  全局配置  >  内置默认
```

按字段独立判断，不是整块覆盖。例如会话只改了 `mode`，其余字段仍用全局值。

### 叠加还是替换

| 字段 | 会话级行为 |
|---|---|
| `presets` / `userDirs` / `sandboxRoots` | **叠加**（合并去重，全局在前） |
| `env` | **按 key 合并**（同名 key 会话优先） |
| `mode` / `enabled` / `cacheRoot` / `autoDetect` | **替换**（标量无叠加概念） |

例如全局 `sandboxRoots: [/A]`，会话加 `/B`，最终生效是 `[/A, /B]` —— 两个都可写。

> **叠加的固有限制**：会话无法「移除」某个全局项。想移除只能去改全局配置。
> 这是选择叠加语义时接受的取舍（相比整体替换，叠加更符合直觉，也不会让
> 全局授权静默失效）。

### 字段作用域总表

| 字段 | 全局 | 会话级 | 会话级语义 |
|---|---|---|---|
| `mode` | ✅ | ✅ | 替换 |
| `enabled` | ✅ | ✅ | 替换 |
| `cacheRoot` | ✅ | ✅ | 替换 |
| `autoDetect` | ✅ | ✅ | 替换 |
| `presets` | ✅ | ✅ | 叠加 |
| `userDirs` | ✅ | ✅ | 叠加 |
| `sandboxRoots` | ✅ | ✅ | 叠加 |
| `env` | ✅ | ✅ | 合并 |
| `autoApproveMode` | ✅ | ❌ | — |
| `autoApproveCommands` | ✅ | ❌ | — |

## 安全回退

`in-place` 依赖后端能追加写白名单：

| 后端 | 支持 | 原因 |
|---|---|---|
| macOS Seatbelt | ✅ | 追加 `(allow file-write* (subpath ...))` |
| Linux bwrap | ✅ | 追加 `--bind` |
| Linux Landlock | ❌ | 授权由带版本的 launcher 内部拼装，无法外部注入 |
| Windows ACL | ❌ | 授权是 SID（`--write-sid`），由 provider 内部物化 ACE |

遇到不支持的后端时，执行器**自动回退到 `redirect`**，而不是停在
「既不授权也不重定向」的中间状态 —— 那种状态下缓存仍写不进去，构建直接失败，
比弹窗更糟。

## 平台支持

| 能力 | macOS | Linux | Windows |
|---|---|---|---|
| `redirect` 模式 | ✅ | ✅ | ✅ |
| `in-place` 模式 | ✅ | ✅ | ❌ 自动回退 |
| 命令授权 | ✅ | ✅ | ✅ |
| 用户目录预设 | ✅ | ✅ | ✅ |

### 平台相关的路径约定

| 用途 | macOS | Linux | Windows |
|---|---|---|---|
| 缓存根 | `$TMPDIR/dsh` | `/tmp/dsh` | `%TEMP%\dsh` |
| 配置目录预设 | `~/.config` | `~/.config` | `%APPDATA%` |
| 缓存目录预设 | `~/.cache` | `~/.cache` | `%LOCALAPPDATA%` |
| 应用数据预设 | `~/.local/share` | `~/.local/share` | `%LOCALAPPDATA%` |

### 平台分支如何选择

`cordis.patch.yml` 同时禁用 `bash-sandbox` 与 `pwsh-sandbox`（两者都注册
`ctx.shell`），再由本插件按平台接管：

```js
const SandboxExecutorBase = process.platform === 'win32'
  ? SandboxPwshExecutor   // Windows 跑 PowerShell
  : SandboxBashExecutor   // 其余平台跑 bash
```

如果一律继承 bash 版本，Windows 上的 shell 会去跑 `bash -c`，而 Windows
通常没有 bash —— 那会把功能弄坏，比不支持更糟。

## 验证

```sh
# 单元测试（纯函数，任何环境可跑）
node --test test/*.test.mjs

# 集成测试（最后一项需要进程本身未被沙箱限制）
node test/integration.mjs
```

集成测试最后一项会在真实沙箱里跑 `go build`。**如果在 DSH 会话里执行**，
测试进程自身已被 Seatbelt 限制，无法嵌套 `sandbox-exec`，该项会标记 SKIP
并说明原因 —— 请在普通终端重跑。

## 已知限制

- 只处理**文件写入**。`gh` 读钥匙串是 mach 端口访问，`open` 是 LaunchServices，
  这些不是文件路径问题，白名单解决不了。
- `redirect` 模式下 `go mod tidy` / `go get` 仍会因要写 `GOMODCACHE` 失败；
  需要切到 `in-place`，或单独放行一次。
- `in-place` 的授权是**整目录可写**。授权 `GOMODCACHE` 意味着沙箱内进程可以
  修改你的模块缓存，请自行权衡。
- 会话级覆盖**不跨进程重启保留**。
- 叠加语义下会话无法移除全局项。
- 注入对所有命令生效（不按命令内容判断），因为判断一段 shell 语法到底
  调用哪个工具并不可靠（`make test`、`./build.sh` 里都可能有 go）。

## 故障排查

### 设置页看不到「沙箱调优」

1. 确认插件已启用：`dsh --profile web --dump-config | grep sandbox-tune`
2. 浏览器 bundle 是 Host 启动时读入内存的 —— **重启 DSH**，刷新页面不够
3. 看启动日志有没有 `did not activate` 或 `already registered`

### bash 工具消失（`unknown tool "bash"`）

通常是插件加载失败导致 `ctx.shell` 缺失。常见原因：

- 两个执行器同时启用（base 的 `bash-sandbox` 与本插件的 `sandbox-tune-bash`）
  → 报 `service "shell" has been registered`
- 插件代码有语法错误 → 看启动输出的 `Error:`

临时恢复：在 profile 的 `cordis.patch.yml` 里给 `sandbox-tune-bash` 加
`disabled: true`，并加 `- id: bash-sandbox` + `disabled: false`。

### 改了配置但没生效

| 改的是什么 | 需要什么 |
|---|---|
| 全局配置（设置页 / YAML） | 立即生效，无需重启 |
| 会话级配置 | 立即生效 |
| 插件代码 / 界面文案 | **重启 DSH**（bundle 在内存里） |

排查顺序：① 文件里改了吗 → ② 运行中进程的启动时间 vs 文件修改时间 →
③ 浏览器缓存。

## 许可

MIT
