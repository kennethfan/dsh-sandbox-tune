/**
 * 会话级配置覆盖：在全局配置之上叠加「本会话」的选择。
 *
 * ## 为什么需要分层
 *
 * 插件原有的 10 个配置项全是全局的（写 profile 的 cordis.patch.yml），
 * 但它们的性质不同：
 *
 * - **环境事实**（cacheRoot / presets / env / autoDetect / userDirs /
 *   sandboxRoots）：这台机器上缓存在哪、哪些目录可写。同一台机器所有会话
 *   共享同一批路径，按会话区分没有实际意义。
 * - **行为策略**（mode / autoApproveMode / autoApproveCommands）：
 *   「这次让 AI 多放手」的决策。做实验时可能想放宽，动生产代码时想收紧。
 *
 * 用户选择了「全部配置都支持会话级覆盖」——灵活度优先。所以这里不做
 * 硬性分类，任何字段都可以按会话覆盖；但环境事实的默认值仍然来自全局，
 * 不覆盖时行为与原来完全一致。
 *
 * ## 为什么用会话日志而不是内存表
 *
 * 复用 DSH 自己的范式（见 dsh-sandbox-policy 的 `sandbox/mode`）：
 * 覆盖写成一条**只进日志**的事件，重启后靠回放恢复，两个会话绝不互相影响。
 * 用内存 Map 存的话，进程重启就丢，且无法解释「为什么这个会话是这设置」。
 *
 * ## 命令授权为什么不继承
 *
 * `autoApproveMode` / `autoApproveCommands` 放宽的是 `danger-full-access`
 * 升权。如果恢复或 fork 旧会话时把它带过去，用户可能几天后完全不记得
 * 那个会话开着宽松规则 —— 这比全局配置危险得多（全局配置每次都会看到）。
 * 因此这两项**永不从事件回放**，必须每次显式开启。
 *
 * @module lib/session-config
 */

import { valueOf } from './config-value.js'

/**
 * 不允许通过会话覆盖生效的字段。
 *
 * 这些是「放宽审批」类授权，必须每次显式给出，不能靠历史回放复活。
 */
export const NON_INHERITABLE = Object.freeze(['autoApproveMode', 'autoApproveCommands'])

/**
 * 允许会话级覆盖的字段全集。
 *
 * 与 executor / provider 的 Config 键保持一致；拼错会在写入时被拒绝，
 * 而不是静默丢弃（静默丢弃会让用户以为设置生效了）。
 *
 * **刻意不含 autoApproveMode / autoApproveCommands**：它们放宽的是
 * danger-full-access 升权，必须每次显式开启（见 NON_INHERITABLE）。
 * 把它们列在这里会让 `/sandbox-tune` 的帮助文本宣称「可设置」，
 * 而实际写入被拒 —— 自相矛盾的提示比没有提示更糟。
 */
export const OVERRIDABLE = Object.freeze([
  // 行为策略
  'mode',
  // 环境事实
  'enabled',
  'cacheRoot',
  'presets',
  'env',
  'autoDetect',
  'userDirs',
  'sandboxRoots',
])

/**
 * 会话覆盖时**叠加**而非替换的字段。
 *
 * 数组类字段（目录列表、预设列表）叠加是更符合直觉的语义：全局授权了
 * /A，会话里加 /B，用户期望两者都可用。若整体替换，/A 会静默失效，
 * 而界面上看不出任何提示 —— 这是很难排查的坑。
 *
 * `env` 是对象，按 key 合并（同名 key 会话优先）。
 *
 * 其余字段（mode / enabled / cacheRoot / autoDetect）是标量，
 * 「会话覆盖全局」就是替换，没有叠加概念。
 */
export const ADDITIVE = Object.freeze(['presets', 'userDirs', 'sandboxRoots', 'env'])

/**
 * 全部配置项（含不支持会话级的），用于状态展示时完整列出。
 *
 * 展示要完整、可设置要严格：用户需要看到「命令授权当前是什么值」，
 * 但不能通过会话去改它。
 */
export const ALL_SETTINGS = Object.freeze([...OVERRIDABLE, ...NON_INHERITABLE])

/**
 * 校验一条覆盖值是否可用。
 *
 * @param {string} key - 字段名。
 * @param {unknown} value - 待写入的值。
 * @returns {{ ok: boolean, reason?: string }} 校验结果。
 */
export function validateOverride(key, value) {
  // 命令授权字段单独给出原因：它们不是「未知字段」，而是「已知但只能全局」。
  // 两种情况的提示要区分，否则用户会以为是自己拼错了字段名。
  if (NON_INHERITABLE.includes(key)) {
    return {
      ok: false,
      reason: `"${key}" 仅支持全局设置（它放宽的是 danger-full-access 升权，必须每次显式开启）`,
    }
  }
  if (!OVERRIDABLE.includes(key)) {
    return { ok: false, reason: `未知配置项 "${key}"，可覆盖的是：${OVERRIDABLE.join(', ')}` }
  }
  if (value === undefined) return { ok: false, reason: `"${key}" 的值不能是 undefined` }
  // 逐字段做最小类型检查：写错类型在写入时就该失败，而不是等到运行时。
  switch (key) {
    case 'mode':
      if (!['redirect', 'in-place'].includes(value)) {
        return { ok: false, reason: `mode 只能是 redirect 或 in-place，收到 ${JSON.stringify(value)}` }
      }
      return { ok: true }
    case 'autoApproveMode':
      if (!['off', 'exact', 'safe-args'].includes(value)) {
        return { ok: false, reason: `autoApproveMode 只能是 off / exact / safe-args` }
      }
      return { ok: true }
    case 'enabled':
    case 'autoDetect':
      if (typeof value !== 'boolean') return { ok: false, reason: `"${key}" 必须是布尔值` }
      return { ok: true }
    case 'cacheRoot':
      if (typeof value !== 'string') return { ok: false, reason: 'cacheRoot 必须是字符串' }
      return { ok: true }
    case 'presets':
    case 'userDirs':
    case 'sandboxRoots':
    case 'autoApproveCommands':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, reason: `"${key}" 必须是字符串数组` }
      }
      return { ok: true }
    case 'env':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, reason: 'env 必须是字符串到字符串的对象' }
      }
      return { ok: true }
    default:
      return { ok: true }
  }
}

/**
 * 从一组覆盖数据里剔除不可继承字段。
 *
 * 内存表模式下没有「事件回放」，但这个过滤仍然必须做：命令授权字段
 * 即使被写进覆盖表，也不能生效 —— 它放宽的是 danger-full-access 升权。
 *
 * @param {Record<string, unknown>} data - 原始覆盖。
 * @returns {Record<string, unknown>} 过滤后的覆盖。
 */
export function sanitizeOverrides(data) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (typeof data !== 'object' || data === null) return out
  for (const [key, value] of Object.entries(data)) {
    if (!OVERRIDABLE.includes(key)) continue
    // 不继承：放宽审批的授权不能靠任何持久化复活。
    if (NON_INHERITABLE.includes(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 解析某次调用最终生效的配置值：会话覆盖 > 全局配置 > 内置默认。
 *
 * @param {object} options - 解析输入。
 * @param {object} options.config - 插件全局配置（可能含 volatile 取值器）。
 * @param {Record<string, unknown>} options.overrides - 本会话的覆盖表。
 * @param {string} options.key - 字段名。
 * @param {unknown} options.fallback - 全局也没有时的兜底值。
 * @returns {unknown} 生效值。
 */
export function resolveSetting({ config, overrides, key, fallback }) {
  const base = valueOf(config?.[key], fallback)
  if (!overrides || !Object.hasOwn(overrides, key)) return base

  const override = overrides[key]

  // 叠加字段：在全局值之上合并会话值，而不是整体替换。
  if (ADDITIVE.includes(key)) {
    if (Array.isArray(override)) {
      const baseList = Array.isArray(base) ? base : []
      // 去重并保持顺序：全局项在前，会话新增项在后。
      return [...new Set([...baseList, ...override])]
    }
    if (override !== null && typeof override === 'object' && !Array.isArray(override)) {
      const baseMap = base !== null && typeof base === 'object' && !Array.isArray(base) ? base : {}
      // 对象按 key 合并，同名 key 会话优先。
      return { ...baseMap, ...override }
    }
  }

  return override
}

/**
 * 把一批覆盖写入会话（内存表，按 sessionId 键）。
 *
 * 不用会话日志事件的原因见 executor 的 overridesFor 注释：投影要求 zod schema
 * （本插件用 schemastery，混用会让插件加载失败），而 snapshotEvents() 已禁止
 * 新调用。内存表的退化方向是安全的——进程重启后回到全局配置，
 * 不会意外保留宽松设置。
 *
 * 每次写入都先做类型校验：写错在写入时就失败，而不是等到运行时才发现。
 *
 * @param {object} session - 目标会话（需有 id）。
 * @param {Record<string, unknown>} patch - 要覆盖的字段。
 * @param {Map<string, Record<string, unknown>>} store - 覆盖表存储。
 * @returns {{ ok: boolean, reason?: string, applied?: string[] }} 写入结果。
 */
export function writeOverrides(session, patch, store) {
  const id = session?.id
  if (id === undefined) return { ok: false, reason: '当前上下文没有可写入的会话' }
  if (!(store instanceof Map)) return { ok: false, reason: '内部错误：缺少覆盖表存储' }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, reason: '覆盖内容必须是对象' }
  }

  const applied = []
  for (const [key, value] of Object.entries(patch)) {
    // 不继承字段在**写入时**就拒绝，而不是存进去再靠读取时过滤。
    // 存进去再过滤会让调用方以为设置成功了（返回 ok），实际没生效 ——
    // 这类「静默不生效」比明确报错更难排查，对放宽审批的设置尤其危险。
    if (NON_INHERITABLE.includes(key)) {
      return {
        ok: false,
        reason: `"${key}" 不支持会话级设置（它放宽的是 danger-full-access 升权，必须每次显式开启）`,
      }
    }
    const verdict = validateOverride(key, value)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    applied.push(key)
  }
  if (applied.length === 0) return { ok: false, reason: '没有要写入的字段' }

  // 合并而非替换：只写这次给的字段，其他覆盖保持不变。
  store.set(id, { ...(store.get(id) ?? {}), ...patch })
  return { ok: true, applied }
}

/**
 * 清除某个会话的全部覆盖，回到全局配置。
 *
 * @param {object} session - 目标会话。
 * @param {Map<string, Record<string, unknown>>} store - 覆盖表存储。
 * @returns {{ ok: boolean, reason?: string }} 结果。
 */
export function clearOverrides(session, store) {
  const id = session?.id
  if (id === undefined) return { ok: false, reason: '当前上下文没有可写入的会话' }
  if (!(store instanceof Map)) return { ok: false, reason: '内部错误：缺少覆盖表存储' }
  store.delete(id)
  return { ok: true }
}
