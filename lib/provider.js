/**
 * 沙箱 provider：在原有 Seatbelt / bwrap profile 之上追加额外的可写白名单。
 *
 * 它替换 base bundle 里的 `sandbox` 行，继承 `LocalSandboxProvider`
 * （runner 选择、探测、拒绝分类全部原样保留），只覆写 `confine()` ——
 * 拿到父类包装好的 argv 后，把额外的写授权拼进 profile 参数里。
 *
 * 两种使用方式：
 * - **in-place 模式**：把工具**真实的**缓存目录（探测得到）授权为可写，
 *   路径完全不变，与普通终端共用同一份缓存。
 * - **redirect 模式**：不授权任何目录（缓存已被 executor 指到临时目录），
 *   行为与原生沙箱完全一致。
 *
 * 还有一个隐含职责：它是唯一知道「当前后端能否追加白名单」的角色，
 * 因此要把这个能力写进共享状态，让 executor 在「模式是 in-place 但后端
 * 不支持」时安全回退到 redirect —— 否则会既没授权也没重定向，构建直接坏掉。
 *
 * 已知边界：
 * - macOS 走 Seatbelt（SBPL profile 字符串，可直接追加 allow 规则）。
 * - Linux 首选 bwrap（追加 `--bind`）；Landlock 的授权由带版本的 launcher
 *   二进制内部拼装，无法从外部安全注入，因此视为不支持并回退。
 * - Windows 的 ACL runner 同理。
 *
 * @module lib/provider
 */

import { realpathSync } from 'node:fs'

import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import z from '@deepseek-ai/schemastery'

import { detectCachePaths } from './cache-env.js'
import { PROVIDER_ROW, configOfRow, rebuildConfig, watchPatchFile } from './config-watch.js'
import { valueOf } from './config-value.js'
import { USER_DIR_NAMES, expandUserDirPresets } from './user-dirs.js'
import { pickPaths, shared } from './shared.js'

/**
 * 在父类 Config 之上追加本插件自己的旋钮。
 *
 * `sandboxRoots` 只接受绝对路径 —— 相对路径在沙箱里没有稳定含义
 * （工作区因会话而异），静默按 cwd 解析会让授权范围不可预测。
 */
const Config = LocalSandboxProvider.Config.set(
  'sandboxRoots',
  z.array(z.string()).default([]).volatile(),
)
  .set('autoDetect', z.boolean().default(true).volatile())
  .set('presets', z.array(z.string()).default(['go']).volatile())
  .set('enabled', z.boolean().default(true).volatile())
  // 预置的用户级目录（~/.config 等）。默认空 = 不授权任何目录。
  .set('userDirs', z.array(z.string()).default([]).volatile())

/** SBPL 字符串字面量转义：反斜杠与双引号。 */
function sbplString(path) {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * 把路径规范化为 Seatbelt 实际比较的形式。
 *
 * Seatbelt 匹配的是解析过符号链接的真实路径（`/tmp` 就是 `/private/tmp`），
 * 直接写原始拼写会匹配不到任何东西 —— 看起来授权成功，实际仍被拒。
 * 解析失败时原样返回：不存在的目录本来就匹配不到，属于保守结果。
 *
 * @param {string} path - 待规范化的路径。
 * @returns {string} 规范化后的路径。
 */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * 判断父类产出的 argv 属于哪种 runner，并据此决定能否追加授权。
 *
 * 只看 argv 形状而不看内部枚举，是因为 `selectRunner` 是私有方法；
 * argv 形状是 `confine()` 的公开输出，属于稳定契约。
 *
 * @param {string[]} argv - 父类包装后的 argv。
 * @returns {'seatbelt' | 'bwrap' | 'unsupported'} runner 类型。
 */
export function runnerKindOf(argv) {
  if (argv[0] === 'sandbox-exec' && argv[1] === '-p' && typeof argv[2] === 'string') return 'seatbelt'
  if (argv[0] === 'bwrap' && argv.includes('--')) return 'bwrap'
  // Windows 的 ACL runner（node runner.js --workspace ... --write-sid ...）走这里：
  // 它的写授权是 SID，由 provider 内部物化 ACE，无法从 argv 追加路径白名单。
  // 返回 unsupported 是**正确行为**（失败关闭），executor 会据此回退到 redirect。
  return 'unsupported'
}

/**
 * 带额外可写白名单的本地沙箱 provider。
 */
export class CacheSandboxProvider extends LocalSandboxProvider {
  static Config = Config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
   * @param {object} config - 见 {@link Config}。
   */
  constructor(ctx, config) {
    super(ctx, config)
    this.pluginConfig = config
    /** 已规范化、准备就绪的额外可写根目录。 */
    this.extraRoots = []
    /** 本插件是否参与沙箱改造。 */
    this.rootsConfigured = valueOf(config.enabled, true) !== false

    // 加载时就确定一次后端能力：能力标志若等到第一次 confine() 才写入，
    // 第一条命令会在 executor 眼里仍是「不支持」，从而先走一次 redirect，
    // 造成「模式是 in-place 但首条命令被重定向」的不一致。
    shared.canExtendRoots = this.probeBackendCapability()

    this.watchConfigFile(ctx)
  }

  /**
   * 监听 profile 的 patch 文件，变化时重建配置。
   *
   * 与执行器同一套机制，只是读的是 provider 那一行。
   * 重建后要重算 rootsConfigured 与后端能力 —— 它们由配置推导而来。
   *
   * @param {object} ctx - 插件上下文。
   * @returns {void}
   */
  watchConfigFile(ctx) {
    const patchPath = ctx.get?.('profileContext')?.patchPath
    if (typeof patchPath !== 'string' || patchPath.length === 0) return

    const onError = (error) => {
      ctx.logger?.warn?.(`sandbox-tune: provider 配置监听出错（保留当前配置）：${error.message}`)
    }

    const dispose = watchPatchFile({
      file: patchPath,
      onChange: (text) => {
        let raw
        try {
          raw = configOfRow(text, PROVIDER_ROW)
        } catch (error) {
          onError(error)
          return
        }
        if (raw === undefined) return

        const result = rebuildConfig(CacheSandboxProvider.Config, raw)
        if (result.error !== undefined) {
          onError(new Error(`配置非法，保留原配置：${result.error.message}`))
          return
        }

        // 与执行器同理：直接赋值 fiber.config（不调 fiber.update，那会 restart），
        // 让设置页下次打开时读到新值。describe() 实时读该对象，无缓存。
        const fiber = ctx.fiber
        if (fiber !== undefined && fiber.state === 2) {
          fiber.config = result.config
        }

        this.pluginConfig = result.config
        // 这两个值由配置推导，必须一起重算，否则热更新后行为不一致。
        this.rootsConfigured = valueOf(result.config.enabled, true) !== false
        shared.canExtendRoots = this.probeBackendCapability()
        // 目录集合变了，之前缓存的探测结果不再可信。
        shared.detecting = undefined
        this.extraRoots = []
        ctx.logger?.info?.('sandbox-tune: provider 配置已热更新（无需重启）')
      },
      onError,
    })

    ctx.effect?.(() => dispose, 'sandbox-tune: watch profile patch file (provider)')
  }

  /**
   * 在不启动子进程的前提下判断当前平台的后端能否追加写白名单。
   *
   * 只按平台判断，不实际跑 runner：真正不可用的 runner 会在 confine() 时
   * 以 SANDBOX_UNAVAILABLE 失败关闭（父类负责），那时也不会走到注入路径。
   * 这里回答的是「就算 runner 可用，我们有没有注入的方言」。
   *
   * @returns {boolean} macOS Seatbelt 与 Linux bwrap 为 true。
   */
  probeBackendCapability() {
    if (!this.rootsConfigured) return false
    // 三条来源全都空着时，in-place 没有任何目录可授权，直接判定不支持，
    // 让 executor 回退到 redirect —— 否则会「声称 in-place 却什么都没做」。
    const noSource =
      valueOf(this.pluginConfig.autoDetect, true) === false &&
      valueOf(this.pluginConfig.sandboxRoots, []).length === 0 &&
      valueOf(this.pluginConfig.userDirs, []).length === 0
    if (noSource) return false
    // Windows 走 ACL runner：它的授权是 SID（--write-sid / --temp-write-sid），
    // 由 provider 内部物化 ACE，**没有可追加路径白名单的位置**。因此 Windows
    // 上 in-place 不可用，返回 false 让 executor 回退到 redirect —— redirect
    // 只依赖环境变量，在 Windows 上同样有效。
    if (process.platform === 'win32') return false
    // darwin 固定走 Seatbelt；linux 首选 bwrap（Landlock 是次选且不支持注入，
    // 届时 confine() 会纠正为 false）。
    return process.platform === 'darwin' || process.platform === 'linux'
  }

  /**
   * 准备授权目录：合并「用户显式配置」与「自动探测」两路来源。
   *
   * 必须由 `confine()` 直接 await，不能拆成「先 prepare 再读」两步 ——
   * 那样一旦有调用方忘了先 prepare，`extraRoots` 就一直是空的，
   * 授权静默失效（这个 bug 真实发生过）。
   *
   * @returns {Promise<string[]>} 去重后的授权目录。
   */
  async prepare() {
    if (this.extraRoots.length > 0) return this.extraRoots

    const explicit = valueOf(this.pluginConfig.sandboxRoots, []).filter(
      (path) => typeof path === 'string' && path.length > 0,
    )

    let detected = []
    if (valueOf(this.pluginConfig.autoDetect, true) !== false) {
      // 等探测完成（executor 触发、这里兜底）：探测是异步的，
      // 若还没结果就自己跑一次，避免首次调用拿到空列表。
      if (!shared.detected) {
        shared.detecting ??= detectCachePaths({ presets: valueOf(this.pluginConfig.presets, []) })
          .then((paths) => {
            shared.paths = paths
            shared.detected = true
          })
          .catch(() => {
            shared.detected = true
          })
      }
      await shared.detecting
      detected = pickPaths(shared.paths, 'all')
    }

    // 用户级目录预设：与缓存探测结果同属「原地授权」，
    // 默认关闭，只有使用者显式勾选才生效。
    const userDirs = expandUserDirPresets(valueOf(this.pluginConfig.userDirs, []))

    const merged = [...new Set([...explicit, ...detected, ...userDirs])]
    if (merged.length === 0) return []
    this.extraRoots = merged.map(canonical)
    this.ctx.logger.info?.(`sandbox-tune: 原地授权 ${this.extraRoots.join(', ')}`)
    return this.extraRoots
  }

  /**
   * 已就绪的可写根目录（同步只读）。
   *
   * 只反映 {@link prepare} 的结果；`confine()` 会在调用前先 await 它，
   * 因此这里不再做惰性计算，避免出现「读的时候还没准备」的空窗。
   *
   * @returns {string[]} 去重后的绝对路径。
   */
  extraWritableRoots() {
    return this.rootsConfigured ? this.extraRoots : []
  }

  /**
   * 包装 argv 后，把额外写授权拼进 profile。
   *
   * @param {readonly string[]} argv - 调用方要跑的精确 argv。
   * @param {import('@deepseek-ai/dsh-sandbox').SandboxPolicy} policy - 本次调用的策略。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<import('@deepseek-ai/dsh-sandbox').ConfinedArgv>} 包装后的 argv 与分类事实。
   */
  async confine(argv, policy, signal) {
    // superConfine 仅用于测试注入（生产环境不存在，走 super.confine）。
    // 之所以留这个缝：单元测试需要隔离 cordis 与真实 sandbox-exec，
    // 但又要走真实的 confine → prepare → patchArgv 链路。
    const confined = await (this.superConfine
      ? this.superConfine(argv, policy, signal)
      : super.confine(argv, policy, signal))

    // danger-full-access 时父类直接放行，argv 未包装，没有可追加的位置。
    if (policy.mode === 'danger-full-access') return confined

    // 记录后端能力：executor 据此决定 in-place 是否可用。
    const kind = runnerKindOf(confined.argv)
    shared.canExtendRoots = kind !== 'unsupported'

    if (!this.rootsConfigured) return confined

    // 必须先 await prepare：它是唯一填充 extraRoots 的路径。
    const roots = await this.prepare()
    if (roots.length === 0) return confined

    const patched = this.patchArgv(confined.argv, roots)
    if (patched === undefined) {
      // 走到这里说明 roots 非空但后端不支持，必须让 executor 知道，
      // 否则它会以为「已原地授权」而跳过重定向。
      shared.canExtendRoots = false
      return confined
    }

    shared.grantedRoots = roots
    return { ...confined, argv: patched }
  }

  /**
   * 按 runner 方言把写授权拼进 argv。
   *
   * @param {string[]} argv - 父类产出的 argv。
   * @param {string[]} roots - 额外可写目录。
   * @returns {string[] | undefined} 新 argv；无法安全注入时返回 undefined。
   */
  patchArgv(argv, roots) {
    const kind = runnerKindOf(argv)

    // macOS Seatbelt：`sandbox-exec -p <profile> -- <cmd...>`，
    // profile 是一整段 SBPL 字符串，追加 allow 规则即可。
    if (kind === 'seatbelt') {
      const allow = roots
        .map((root) => `(allow file-write* (subpath ${sbplString(root)}))`)
        .join(' ')
      return [argv[0], argv[1], `${argv[2]} ${allow}`, ...argv.slice(3)]
    }

    // Linux bwrap：可写目录用 `--bind <path> <path>` 表达，
    // 必须在 `--` 分隔符之前插入。
    if (kind === 'bwrap') {
      const separator = argv.indexOf('--')
      const binds = roots.flatMap((root) => ['--bind', root, root])
      return [...argv.slice(0, separator), ...binds, ...argv.slice(separator)]
    }

    // Landlock launcher 与 Windows ACL runner 的授权在内部拼装，外部注入不安全，
    // 明确告警而不是静默跳过 —— 否则用户会以为白名单生效了。
    this.ctx.logger.warn?.(
      `sandbox-tune: 当前沙箱后端 ${argv[0]} 不支持追加可写目录，将回退到缓存重定向`,
    )
    return undefined
  }
}

export default CacheSandboxProvider
