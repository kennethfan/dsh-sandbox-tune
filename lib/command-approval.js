/**
 * 命令授权：在审批链上按规则自动批准沙箱升权。
 *
 * ## 为什么要跨两个事件
 *
 * `approval/request` 事件只带 `toolName` / `callId` / `reason`，**没有命令内容**
 * （见 dsh-user-approval 的 ApprovalRequestEvent）。而按命令放行必须有命令。
 *
 * 所以分两步：
 * 1. `tools/pre-execute` 拿得到完整 `exec.arguments`（含 `command`），
 *    在这里把 `callId → 命令` 记进内存表；
 * 2. `approval/request` 到达时用 `callId` 查回命令，按规则判定，
 *    命中就返回 `allowed-once` 直接放行，不弹窗。
 *
 * `callId` 由 tool-bash 原样传进 approveEscalation，因此两步能对上。
 *
 * ## 安全边界（必须清楚）
 *
 * 自动批准的是 `danger-full-access` 升权 —— 放行后整条命令不受文件沙箱限制。
 * 因此规则匹配必须保守（见 lib/command-rules.js），且默认关闭。
 *
 * 只处理**沙箱升权**这一种审批：reason 必须以 `escalate sandbox to` 开头。
 * 其他审批（如 hook 的权限请求）一律交回原链，不擅自放行。
 *
 * @module lib/command-approval
 */

import { valueOf } from './config-value.js'
import { decideAutoApproval, normalizeCommand } from './command-rules.js'

/** 升权审批的 reason 前缀（与 dsh-sandbox 的 approveEscalation 一致）。 */
const ESCALATION_PREFIX = 'escalate sandbox to'

/**
 * 命令授权插件。
 *
 * 注册两个监听器，并通过 `ctx.effect` 保证卸载时一并撤销。
 */
export class CommandApproval {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
   * @param {object} config - 见 executor 的 Config（共用一份）。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** callId → 命令。只在本次调用生命周期内有效。 */
    this.commands = new Map()
    /** 已自动放行的记录，供设置页与日志展示。 */
    this.granted = []
  }

  /**
   * 当前生效的授权模式。
   *
   * 命令授权**刻意不支持会话级覆盖**（见 session-config 的 NON_INHERITABLE）：
   * 它放宽的是 danger-full-access 升权，恢复或 fork 旧会话时把它带过去，
   * 用户可能几天后完全不记得那个会话开着宽松规则。所以这里只读全局配置。
   *
   * @returns {'off' | 'exact' | 'safe-args'} 模式。
   */
  mode() {
    return valueOf(this.config.autoApproveMode, 'off')
  }

  /** 当前配置的规则列表。 */
  rules() {
    return valueOf(this.config.autoApproveCommands, [])
  }

  /** 是否开启。 */
  enabled() {
    return valueOf(this.config.enabled, true) !== false && this.mode() !== 'off'
  }

  /**
   * 挂载两个监听器。
   */
  install() {
    // 1) 记下 callId → 命令，供审批阶段查询。
    this.ctx.on('tools/pre-execute', (exec, next) => {
      try {
        if (exec?.name === 'bash' && exec.callId) {
          const command = exec.arguments?.command
          if (typeof command === 'string') this.remember(exec.callId, command)
        }
      } catch (error) {
        // 记录失败绝不能影响工具执行本身。
        this.ctx.logger?.warn?.(`sandbox-tune: 记录命令失败: ${String(error)}`)
      }
      return next()
    })

    // 2) 审批阶段：命中规则就自动放行。
    this.ctx.on('approval/request', (request, next) => {
      const verdict = this.judge(request)
      if (verdict === undefined) return next()
      return Promise.resolve('allowed-once')
    })
  }

  /**
   * 记下一条命令。
   *
   * 表会随会话持续增长，因此设上限：超过就丢最旧的（Map 保持插入序）。
   * 这些命令只在对应调用等待审批期间有用，丢掉旧条目不影响正确性。
   *
   * @param {string} callId - 工具调用 id。
   * @param {string} command - 命令原文。
   */
  remember(callId, command) {
    const LIMIT = 500
    this.commands.set(callId, command)
    if (this.commands.size > LIMIT) {
      const oldest = this.commands.keys().next().value
      if (oldest !== undefined) this.commands.delete(oldest)
    }
  }

  /**
   * 判定一条审批请求是否应自动放行。
   *
   * @param {object} request - ApprovalRequestEvent。
   * @returns {object | undefined} 命中时返回判定详情，否则 undefined（交回原链）。
   */
  judge(request) {
    if (!this.enabled()) return undefined
    if (request?.toolName !== 'bash') return undefined

    // 只处理沙箱升权；其他审批不碰。
    const reason = String(request.reason ?? '')
    if (!reason.startsWith(ESCALATION_PREFIX)) return undefined

    const command = request.callId ? this.commands.get(request.callId) : undefined
    if (command === undefined) {
      this.ctx.logger?.debug?.(
        `sandbox-tune: 审批请求 ${String(request.callId)} 找不到对应命令，交回人工`,
      )
      return undefined
    }

    const decision = decideAutoApproval({
      command,
      mode: this.mode(),
      rules: this.rules(),
    })

    if (!decision.allowed) {
      this.ctx.logger?.debug?.(`sandbox-tune: 不自动放行（${decision.reason}）`)
      return undefined
    }

    const record = {
      time: Date.now(),
      command: normalizeCommand(command),
      rule: decision.rule,
      reason,
    }
    this.granted.unshift(record)
    if (this.granted.length > 100) this.granted.length = 100

    // 自动放行必须留痕：这是审计需要，不是可选项。
    this.ctx.logger?.info?.(
      `sandbox-tune: 自动批准升权 ${JSON.stringify(record.command)}（规则 ${JSON.stringify(record.rule)}）`,
    )
    return decision
  }
}
