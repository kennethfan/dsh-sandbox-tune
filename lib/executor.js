/**
 * 沙箱内的 bash 执行器：按模式给命令处理构建工具缓存。
 *
 * 它替换 base bundle 里的 `bash-sandbox` 行，继承 `SandboxBashExecutor`
 * （沙箱、审批、升权、拒绝分类全部原样保留），只覆写 `resolve()`。
 *
 * 两种模式：
 * - **redirect（默认）**：把纯缓存指到 `$TMPDIR/dsh`，任何后端都能用。
 * - **in-place**：不注入任何变量，缓存路径保持原样，由 provider 把真实
 *   目录授权为可写。前提是后端支持追加白名单。
 *
 * 安全回退：in-place 模式下若 provider 报告后端不支持（Landlock /
 * Windows ACL），这里自动降级为 redirect。否则会停留在「既没授权也没
 * 重定向」的状态 —— 缓存仍写不进去，构建直接失败，比弹窗更糟。
 *
 * 为什么覆写 `resolve()` 而不是 `execute()`：
 * - `resolve()` 是 shell seam 规定的「补齐默认值」步骤，tool-bash 在
 *   `execute` 之前调用它；在这里改 spec 属于契约内的位置。
 * - `env` 会在 subprocess 层与「清理过凭据的父环境」合并，所以注入的变量
 *   既不会覆盖敏感变量，也不会被后续层吃掉。
 *
 * 为什么不用 `ctx.shellEnv`（DSH_* 注册表）：
 * 那个注册表只允许 `DSH_` 前缀的键，而 Go 只认 `GOCACHE`，命名空间对不上。
 *
 * @module lib/executor
 */

import { mkdir } from 'node:fs/promises'

import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import z from '@deepseek-ai/schemastery'

import { buildCacheEnv, detectCachePaths, guessPresetsFor, resolveCacheRoot } from './cache-env.js'
import { CommandApproval } from './command-approval.js'
import { valueOf } from './config-value.js'
import { EXECUTOR_ROW, configOfRow, rebuildConfig, watchPatchFile } from './config-watch.js'
import { registerSessionCommand } from './session-command.js'
import { resolveSetting } from './session-config.js'
import { shared } from './shared.js'

/**
 * 在父类 Config 之上追加本插件自己的旋钮。
 *
 * 用 `Schema.set(key, schema)` 而不是手写一份完整 schema：父类 Config 里的
 * `cwd` / `timeoutMs` 等是 volatile 字段，重新声明容易漏掉 `.volatile()`
 * 或默认值，导致运行时取值器行为改变。`set` 只增不改。
 */
/**
 * 在父类 Config 之上追加本插件自己的旋钮。
 *
 * 用 `Schema.set(key, schema)` 而不是手写一份完整 schema：父类 Config 里的
 * `cwd` / `timeoutMs` 等是 volatile 字段，重新声明容易漏掉 `.volatile()`
 * 或默认值，导致运行时取值器行为改变。`set` 只增不改。
 *
 * **为什么这些字段都要 `.volatile()`**：
 * Host 的 `settings.describe` 只把「含 volatile 字段」的 config 投影成设置表单
 * （`dsh-settings` 的 `volatileForm()` 会丢弃非 volatile 的键）。不标 volatile
 * 的话，插件在设置界面里根本不会出现，也无法运行时改值。标了之后：
 * - 值以取值器形式提供（`config.mode.get()`），修改无需重启插件；
 * - 出现在「设置 → 内置插件」与插件页的配置卡片里。
 */
/**
 * 按平台选择被包装的沙箱执行器。
 *
 * base 组合本身就是平台二选一：Windows 用 pwsh-sandbox（PowerShell），
 * 其余平台用 bash-sandbox。本插件必须跟随同一约定 —— 如果一律继承 bash
 * 版本，Windows 上的 shell 会去跑 `bash -c`，而 Windows 通常没有 bash，
 * 等于把功能弄坏（比不支持更糟）。
 */
const SandboxExecutorBase =
  process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor

const Config = SandboxExecutorBase.Config.set(
  'mode',
  z.union(['redirect', 'in-place']).default('redirect').volatile(),
)
  .set('cacheRoot', z.string().default('').volatile())
  .set('presets', z.array(z.string()).default(['go']).volatile())
  .set('env', z.dict(z.string()).default({}).volatile())
  .set('enabled', z.boolean().default(true).volatile())
  // 命令授权：按规则自动批准沙箱升权，避免重复弹窗。默认 off。
  .set('autoApproveMode', z.union(['off', 'exact', 'safe-args']).default('off').volatile())
  .set('autoApproveCommands', z.array(z.string()).default([]).volatile())

/**
 * 带缓存处理的沙箱 bash 执行器。
 *
 * 继承链：`SandboxBashExecutor` → `LocalBashExecutor` → `ShellExecutor`。
 */
export class CacheSandboxExecutor extends SandboxExecutorBase {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  static Config = Config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
   * @param {object} config - 见 {@link Config}。
   */
  constructor(ctx, config) {
    super(ctx, config)
    this.cacheConfig = config
    // cacheRoot 走 valueOf：字段是 volatile 时 config.cacheRoot 是取值器。
    this.cacheRoot = resolveCacheRoot(valueOf(config.cacheRoot, ''), process.cwd())
    /** 已创建过的目录，避免每条命令都重复 mkdir。 */
    this.ensured = new Set()
    /** 是否已经触发过探测。 */
    this.detectionStarted = false

    // 命令授权与执行器共用同一份 config（都在 sandbox-tune-bash 这一行上），
    // 这样设置页只需要一个卡片就能同时改缓存模式与授权规则。
    // 始终挂载监听器，由 judge() 在每次审批时读当前 volatile 值再判定。
    // 不能只在构造时按初始值决定挂不挂：volatile 字段支持运行时改，
    // 那样在设置页把 off 改成 safe-args 会毫无效果。
    this.approval = new CommandApproval(ctx, config)
    this.approval.install()

    // 会话级覆盖：不走 sessionProjections。
    //
    // 原因：投影的 `stateSchema` 要求是 **zod** 类型（ZodType），而本插件用的是
    // schemastery（`z` 来自 @deepseek-ai/schemastery）。传 `z.any()` 进去会在
    // register 时抛错 → 整个插件 apply 失败 → ctx.shell 不存在 →
    // dsh-tool-bash 无法激活 → bash 工具直接消失（踩过这个坑）。
    //
    // 改成进程内 Map：覆盖是「本次会话的临时选择」，重启后回到全局配置，
    // 这个退化方向是安全的（不会意外保留宽松设置）。

    // 会话级命令：给前端一条按会话改配置的通道。
    // 用斜杠命令而不是新造 Remote API —— 命令天然绑定会话
    // （invocation.agent.session），且前端已有现成的 live.command() 通道。
    registerSessionCommand(ctx, { config, store: shared.sessionOverrides })

    // 配置文件自监听：改 cordis.patch.yml 后无需重启 DSH。
    //
    // 只重读本插件这一行的 config 段并重建配置对象，不触碰插件树结构。
    // 启用/禁用插件、增删 loader 行仍然需要重启（那要加载新模块）。
    this.watchConfigFile(ctx)
  }

  /**
   * 监听 profile 的 patch 文件，变化时重建配置。
   *
   * 用 ctx.effect 注册清理，插件卸载时自动关闭 watcher。
   *
   * @param {object} ctx - 插件上下文。
   * @returns {void}
   */
  watchConfigFile(ctx) {
    const patchPath = ctx.get?.('profileContext')?.patchPath
    // 拿不到 profile 上下文（非 profile 启动）时静默跳过：
    // 那种场景本来就没有 patch 文件可监听。
    if (typeof patchPath !== 'string' || patchPath.length === 0) return

    const onError = (error) => {
      ctx.logger?.warn?.(`sandbox-tune: 配置监听出错（保留当前配置）：${error.message}`)
    }

    const dispose = watchPatchFile({
      file: patchPath,
      onChange: (text) => {
        let raw
        try {
          raw = configOfRow(text, EXECUTOR_ROW)
        } catch (error) {
          // YAML 语法错误：保留旧配置，只告警。不因为一次手误让插件失效。
          onError(error)
          return
        }
        // 这一行被删掉或禁用时不动配置：那种改动本质需要重启。
        if (raw === undefined) return

        const result = rebuildConfig(CacheSandboxExecutor.Config, raw)
        if (result.error !== undefined) {
          onError(new Error(`配置非法，保留原配置：${result.error.message}`))
          return
        }

        // 换掉配置对象。resolve() 每次都读 this.cacheConfig，所以立即生效。
        this.cacheConfig = result.config
        this.cacheRoot = resolveCacheRoot(valueOf(result.config.cacheRoot, ''), process.cwd())
        // 命令授权与执行器共用同一份 config，也要跟着换。
        this.approval.config = result.config
        ctx.logger?.info?.('sandbox-tune: 配置已热更新（无需重启）')
      },
      onError,
    })

    ctx.effect?.(() => dispose, 'sandbox-tune: watch profile patch file')
  }

  /**
   * 取某个会话生效的覆盖表。
   *
   * 用**进程内内存表 + 会话 id 键**，而不是从会话日志回放。
   *
   * 为什么不用 sessionProjections：它的 `stateSchema` 要求 zod 类型
   * （`ZodType`），而本插件用的是 schemastery。传 `z.any()` 进去会在
   * register 时抛错 → 整个插件 apply 失败 → `ctx.shell` 不存在 →
   * `dsh-tool-bash` 无法激活 → **bash 工具直接消失**（踩过这个坑）。
   * 改用 zod 则要新增依赖，代价不划算。
   *
   * 为什么不用 snapshotEvents()：它已标注 `@deprecated ... new calls are
   * prohibited`，新代码不该用。
   *
   * 内存表的取舍：进程重启后覆盖丢失，回到全局配置。这个行为是**安全**的
   * 退化方向（不会意外保留宽松设置），且覆盖本身是「本次会话的临时选择」，
   * 重启后重新设一次符合直觉。
   *
   * @param {string | undefined} sessionId - 调用方会话 id。
   * @returns {Record<string, unknown>} 覆盖表。
   */
  overridesForId(sessionId) {
    if (sessionId === undefined) return {}
    return shared.sessionOverrides.get(sessionId) ?? {}
  }

  /**
   * 触发一次缓存路径探测（幂等）。
   *
   * 探测结果同时供 provider 使用，放在共享状态里只做一次。
   */
  startDetection() {
    if (this.detectionStarted || shared.detected) return
    this.detectionStarted = true
    shared.detecting ??= detectCachePaths({ presets: valueOf(this.cacheConfig.presets, []) })
      .then((paths) => {
        shared.paths = paths
        shared.detected = true
      })
      .catch((error) => {
        shared.detected = true
        this.ctx.logger.warn?.(`sandbox-tune: 缓存路径探测失败: ${String(error)}`)
      })
  }

  /**
   * 决定本次调用实际使用的模式。
   *
   * @returns {'redirect' | 'in-place' | 'off'} 生效模式。
   */
  effectiveMode(overrides = {}) {
    const enabled = resolveSetting({
      config: this.cacheConfig,
      overrides,
      key: 'enabled',
      fallback: true,
    })
    if (enabled === false) return 'off'
    const wanted = resolveSetting({
      config: this.cacheConfig,
      overrides,
      key: 'mode',
      fallback: 'redirect',
    })
    if (wanted === 'redirect') return 'redirect'
    // in-place 需要后端支持追加白名单；不支持就回退，绝不留在中间状态。
    return shared.canExtendRoots ? 'in-place' : 'redirect'
  }

  /**
   * 补齐 spec，并按模式处理缓存。
   *
   * @param {import('@deepseek-ai/dsh-shell').ShellExecRequest} request - 调用方请求。
   * @returns {import('@deepseek-ai/dsh-shell').ShellExecSpec} 完整 spec。
   */
  resolve(request) {
    const spec = super.resolve(request)

    // 会话级覆盖：同一台机器上不同会话可以有不同设置。
    //
    // 会话 id 从 spec.sandboxPolicy 里取，而不是 request.agent：
    // tool-bash 调 shell.resolve() 时只传 {command, workdir, dshEnv,
    // sandboxPolicy}，**不带 agent**。而 sandboxPolicy 由
    // sandboxPolicy.resolve({session}) 算出，里面带 sessionId
    // （见 dsh-sandbox-policy 的 `...session === void 0 ? {} : { sessionId: session.id }`）。
    const overrides = this.overridesForId(spec.sandboxPolicy?.sessionId)

    const enabled = resolveSetting({
      config: this.cacheConfig,
      overrides,
      key: 'enabled',
      fallback: true,
    })
    if (enabled === false) return spec

    // danger-full-access 下没有任何文件限制，注入缓存反而会让缓存分裂到
    // 临时目录（绕过用户本机已有缓存），所以完全不动。
    if (spec.sandboxPolicy?.mode === 'danger-full-access') return spec

    this.startDetection()

    // in-place：路径保持原样，授权由 provider 完成，这里不注入任何变量。
    if (this.effectiveMode(overrides) === 'in-place') return spec

    // 会话覆盖了 cacheRoot 就按会话重新解析；否则沿用构造时算好的全局值。
    const cacheRoot = Object.hasOwn(overrides, 'cacheRoot')
      ? resolveCacheRoot(String(overrides.cacheRoot ?? ''), process.cwd())
      : this.cacheRoot

    const { env, dirs } = buildCacheEnv({
      cacheRoot,
      presets: resolveSetting({
        config: this.cacheConfig,
        overrides,
        key: 'presets',
        fallback: [],
      }),
      extraEnv: resolveSetting({
        config: this.cacheConfig,
        overrides,
        key: 'env',
        fallback: {},
      }),
      lookup: (name) => process.env[name],
    })

    if (Object.keys(env).length === 0) return spec

    // 目录提前建好：go/npm 自己会建，但其他工具在目录缺失时行为不一，
    // 统一建掉可以少一类边界情况。失败不致命 —— 真有问题命令自己会报错。
    this.ensureDirs(dirs)

    const hit = guessPresetsFor(spec.command)
    if (hit.length > 0) {
      this.ctx.logger.debug?.(
        `sandbox-tune: ${hit.join(',')} 命令重定向缓存 ${Object.keys(env).join(',')}`,
      )
    }

    return {
      ...spec,
      // 合并而非覆盖：调用方（hooks 桥、其他插件）自己设的 env 必须保留，
      // 我们的值只补齐它没提到的那部分。
      env: { ...spec.env, ...env },
    }
  }

  /**
   * 尽力创建缓存目录（登记去重，异步执行，不阻塞命令）。
   *
   * @param {string[]} dirs - 待创建的绝对路径。
   */
  ensureDirs(dirs) {
    for (const dir of dirs) {
      if (this.ensured.has(dir)) continue
      this.ensured.add(dir)
      // recursive 保证父目录一并创建；失败仅记日志，不影响命令本身。
      mkdir(dir, { recursive: true }).catch((error) => {
        this.ctx.logger.warn?.(`sandbox-tune: 无法创建缓存目录 ${dir}: ${String(error)}`)
      })
    }
  }
}

/** 兼容旧名：插件早期只支持 bash，导出名一直是 CacheBashExecutor。 */
export const CacheBashExecutor = CacheSandboxExecutor

export default CacheSandboxExecutor
