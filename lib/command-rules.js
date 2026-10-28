/**
 * 命令授权规则：决定某条 bash 命令是否可以自动批准沙箱升权。
 *
 * ## 为什么这个模块必须写得保守
 *
 * 自动批准的是 `danger-full-access` 升权 —— 一旦放行，**整条命令**完全不受
 * 文件沙箱限制。而 bash 命令是任意 shell 程序：
 *
 *     go build ./...                      ← 你想放行的
 *     go build ./... && rm -rf ~/Documents  ← 危险，但前缀一模一样
 *
 * 所以「按前缀放行」在这里是不安全的。本模块因此只提供两种模式：
 *
 * - `exact`：命令必须与规则**逐字符相同**（去掉首尾空白后）。
 *   最安全，但模型每次生成的命令常带不同路径/参数，命中率有限。
 * - `safe-args`：命令以规则词开头，且**不含任何 shell 组合与重定向**。
 *   比 exact 实用，仍能挡住 `cmd && rm`、`cmd > file`、`cmd $(...)` 这类。
 *
 * 不提供正则与前缀通配：正则写错就是漏洞，而前缀通配等于上面那个反例。
 *
 * @module lib/command-rules
 */

/** 模式取值。 */
export const APPROVAL_MODES = Object.freeze(['off', 'exact', 'safe-args'])

/**
 * shell 里能改变执行流的构造 —— 出现任何一个，`safe-args` 就拒绝放行。
 *
 * 用简单的字符包含判断而不是解析 shell：解析器写错同样会漏判，
 * 而这里的目标是「只要看起来复杂就不放行」，保守方向正确。
 */
const SHELL_COMPOSITION = [
  '&&', // 顺序执行
  '||', // 条件执行
  ';', // 命令分隔
  '|', // 管道
  '>', // 重定向
  '<', // 输入重定向
  '`', // 命令替换
  '$(', // 命令替换
  '${', // 变量展开（可注入）
  '&', // 后台
]

/**
 * 把命令规范化成用于比较的形式。
 *
 * 只去掉首尾空白与多余的尾部换行；**不做任何其他改写** ——
 * 任何「聪明」的归一化都可能让两条不同命令被判为相同。
 *
 * @param {string} command - 原始命令。
 * @returns {string} 规范化后的命令。
 */
export function normalizeCommand(command) {
  return String(command ?? '').trim()
}

/**
 * 判断命令是否含有 shell 组合构造。
 *
 * @param {string} command - 规范化后的命令。
 * @returns {string | undefined} 命中的构造（用于日志），没有则 undefined。
 */
export function compositionIn(command) {
  for (const token of SHELL_COMPOSITION) {
    if (command.includes(token)) return token
  }
  return undefined
}

/**
 * 判定一条命令是否可自动批准。
 *
 * @param {object} options - 判定输入。
 * @param {string} options.command - 待判定的命令。
 * @param {'off' | 'exact' | 'safe-args'} options.mode - 授权模式。
 * @param {string[]} options.rules - 规则列表（每条是完整命令或命令词）。
 * @returns {{ allowed: boolean, reason: string, rule?: string }} 判定结果与原因。
 */
export function decideAutoApproval({ command, mode, rules }) {
  if (mode === 'off') return { allowed: false, reason: '自动授权已关闭' }

  const text = normalizeCommand(command)
  if (text.length === 0) return { allowed: false, reason: '命令为空' }

  const list = (rules ?? []).map((rule) => normalizeCommand(rule)).filter((rule) => rule.length > 0)
  if (list.length === 0) return { allowed: false, reason: '没有配置任何规则' }

  if (mode === 'exact') {
    if (list.includes(text)) return { allowed: true, reason: '命令与规则完全匹配', rule: text }
    return { allowed: false, reason: '命令与任何规则都不完全匹配' }
  }

  if (mode === 'safe-args') {
    // 先挡组合构造：含 && ; | > 等一律不自动放行。
    const composition = compositionIn(text)
    if (composition !== undefined) {
      return { allowed: false, reason: `命令含有 shell 组合构造 "${composition}"，不自动放行` }
    }
    for (const rule of list) {
      if (text === rule) return { allowed: true, reason: '命令与规则匹配', rule }
      // 必须是「规则 + 空白 + 参数」的形式，避免 `go` 匹配 `google-chrome`。
      if (text.startsWith(`${rule} `)) {
        return { allowed: true, reason: '命令以规则开头且无组合构造', rule }
      }
    }
    return { allowed: false, reason: '命令不以任何规则开头' }
  }

  return { allowed: false, reason: `未知模式 "${mode}"` }
}
