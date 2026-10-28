/**
 * Host 侧的会话级配置命令：让前端能通过斜杠命令读写本会话的覆盖。
 *
 * ## 为什么用命令而不是自定义 Remote API
 *
 * 前端要改「本会话」的设置，需要一个「当前会话」的上下文。设置页是全局面板，
 * 拿不到会话 id；而斜杠命令天然绑定会话（`invocation.agent.session`），
 * 且前端已有现成通道 `live.command('/xxx ...')`（见 dsh-client-ui-permission-presets
 * 的 `/permission` 用法）。
 *
 * 复用这条通道比新造一套 Remote 端点更稳：不用碰 typert 生成、不用处理
 * 跨进程鉴权，且命令调用本身会写进会话日志，天然可审计。
 *
 * ## 用法
 *
 *   /sandbox-tune                 查看当前生效配置与来源
 *   /sandbox-tune set mode in-place
 *   /sandbox-tune set presets go,npm
 *   /sandbox-tune reset           清除本会话的全部覆盖
 *
 * @module lib/session-command
 */

import { NON_INHERITABLE, OVERRIDABLE, clearOverrides, resolveSetting, validateOverride, writeOverrides } from './session-config.js'

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'sandbox-tune'

/**
 * 把命令参数解析成覆盖补丁。
 *
 * 支持 `set <key> <value>`、`reset`、无参数（查看）。
 * 值按目标字段的类型解析：数组用逗号分隔，布尔用 true/false。
 *
 * @param {string} rawInput - 命令名之后的原始文本。
 * @returns {{ action: 'show' | 'set' | 'reset' | 'error', key?: string, value?: unknown, reason?: string }}
 */
export function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text.length === 0) return { action: 'show' }

  const parts = text.split(/\s+/)
  const verb = parts[0]

  if (verb === 'reset') return { action: 'reset' }

  if (verb !== 'set') {
    return { action: 'error', reason: `未知子命令 "${verb}"，可用：set / reset（不带参数则查看）` }
  }

  const key = parts[1]
  if (key === undefined) return { action: 'error', reason: 'set 需要字段名，例如：set mode in-place' }
  if (!OVERRIDABLE.includes(key)) {
    return { action: 'error', reason: `未知配置项 "${key}"，可设置：${OVERRIDABLE.join(', ')}` }
  }

  // 值可能为空（例如 set presets 清空列表）——用 join 保留内部空格。
  const rawValue = parts.slice(2).join(' ')

  // 按字段类型解析：这些是写进配置的机器值，不做模糊猜测。
  switch (key) {
    case 'enabled':
    case 'autoDetect': {
      if (rawValue !== 'true' && rawValue !== 'false') {
        return { action: 'error', reason: `"${key}" 只能是 true 或 false` }
      }
      return { action: 'set', key, value: rawValue === 'true' }
    }
    case 'presets':
    case 'userDirs':
    case 'sandboxRoots':
    case 'autoApproveCommands': {
      const list = rawValue
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      return { action: 'set', key, value: list }
    }
    case 'env': {
      // 形如 A=1,B=2
      /** @type {Record<string, string>} */
      const env = {}
      for (const pair of rawValue.split(',')) {
        const trimmed = pair.trim()
        if (trimmed.length === 0) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) return { action: 'error', reason: 'env 的格式是 KEY=VALUE，多项用逗号分隔' }
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
      }
      return { action: 'set', key, value: env }
    }
    default:
      // mode / cacheRoot / autoApproveMode：原样作为字符串
      return { action: 'set', key, value: rawValue }
  }
}

/**
 * 渲染当前生效配置。
 *
 * 明确标出每个值来自「会话」还是「全局」——否则用户看不出覆盖是否生效，
 * 这类「看不出」会让整个会话级功能变得不可用。
 *
 * @param {object} options - 渲染输入。
 * @param {object} config - 插件全局配置（含 volatile 取值器）。
 * @param {Record<string, unknown>} overrides - 本会话覆盖表。
 * @returns {string} 面向用户的文本。
 */
export function renderStatus({ config, overrides }) {
  const lines = ['沙箱调优 — 本会话生效配置：']
  for (const key of OVERRIDABLE) {
    const fromSession = overrides && Object.hasOwn(overrides, key)
    const value = resolveSetting({ config, overrides, key, fallback: undefined })
    const shown = value === undefined ? '(未设置)' : JSON.stringify(value)
    lines.push(`  ${key}: ${shown}${fromSession ? '  ← 本会话' : '  （全局）'}`)
  }

  // 命令授权也要展示当前值（用户需要知道现在是 off 还是 safe-args），
  // 但明确标出「仅全局」，避免被误认为可以按会话改。
  lines.push('', '以下仅全局生效（放宽审批的授权必须显式开启）：')
  for (const key of NON_INHERITABLE) {
    const value = resolveSetting({ config, overrides: {}, key, fallback: undefined })
    const shown = value === undefined ? '(未设置)' : JSON.stringify(value)
    lines.push(`  ${key}: ${shown}  （仅全局）`)
  }

  if (overrides && Object.keys(overrides).length === 0) {
    lines.push('', '本会话没有覆盖，全部使用全局配置。')
  }
  lines.push(
    '',
    '改本会话：/sandbox-tune set <字段> <值>',
    '清除覆盖：/sandbox-tune reset',
  )
  return lines.join('\n')
}

/**
 * 注册命令。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} options - 注册选项。
 * @param {object} options.config - 插件全局配置。
 * @param {Map<string, Record<string, unknown>>} options.store - 覆盖表存储。
 * @returns {void}
 */
export function registerSessionCommand(ctx, { config, store }) {
  // 用 ctx.get() 而不是 ctx.commands：后者要求插件在 inject 里声明 "commands"，
  // 而本插件想在「没有 commands 服务的组合」里也能正常加载（只是少了这个入口）。
  // ctx.get() 是可选的运行时查询，不建立依赖关系。
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (typeof commands?.register !== 'function') {
    // 组合里没有命令注册表：不报错，只是不提供这个入口。
    ctx.logger?.debug?.('sandbox-tune: 未组合 commands 服务，跳过会话级命令')
    return
  }

  commands.register({
    name: COMMAND_NAME,
    description: '查看或修改本会话的沙箱调优设置',
    // 输入是机器值（字段名 + 取值），不需要模型参与，也不该记进模型上下文。
    recordInput: false,
    handler: (invocation) => {
      const session = invocation?.agent?.session
      if (session?.id === undefined) {
        return { kind: 'error', text: '当前上下文没有会话' }
      }

      const overrides = store.get(session.id) ?? {}
      const parsed = parseCommandInput(invocation.rawInput)

      if (parsed.action === 'show') {
        return { kind: 'success', text: renderStatus({ config, overrides }) }
      }

      if (parsed.action === 'error') {
        return { kind: 'error', text: parsed.reason }
      }

      if (parsed.action === 'reset') {
        const result = clearOverrides(session, store)
        if (!result.ok) return { kind: 'error', text: result.reason }
        return { kind: 'success', text: '已清除本会话的全部覆盖，回到全局配置。' }
      }

      // set：先校验再写，写错立刻报错而不是静默丢弃。
      const verdict = validateOverride(parsed.key, parsed.value)
      if (!verdict.ok) return { kind: 'error', text: verdict.reason }

      const result = writeOverrides(session, { [parsed.key]: parsed.value }, store)
      if (!result.ok) return { kind: 'error', text: result.reason }

      const next = store.get(session.id) ?? {}
      return {
        kind: 'success',
        text: `已设置 ${parsed.key} = ${JSON.stringify(parsed.value)}（仅本会话）\n\n${renderStatus({ config, overrides: next })}`,
      }
    },
  })
}
