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
/**
 * 可**拆分**的分隔符：拆开后每段独立匹配规则。
 *
 * 这些只影响「执行哪几条命令」，不改变单条命令的语义。
 * 拆开逐段校验后，`A && B` 只有在 A 和 B 都被放行时才放行。
 */
const SPLITTABLE = [
  '&&', // 顺序执行
  '||', // 条件执行
  ';', // 命令分隔
  '|', // 管道
]

/**
 * 必须**整体拒绝**的构造：拆分解决不了它们。
 *
 * - 重定向（`>` `<`）能覆盖/读取任意文件，`cmd > ~/.zshrc` 拆开看
 *   `cmd` 是放行的，但实际效果是改写配置。
 * - 命令替换（`` ` `` `$(`）与变量展开（`${`）的内容无法静态校验，
 *   可以塞进任意命令。
 * - 后台（`&`）会让命令脱离等待，输出与退出码都拿不到。
 */
const BLOCKING = [
  '>', // 重定向
  '<', // 输入重定向
  '`', // 命令替换
  '$(', // 命令替换
  '${', // 变量展开（可注入）
  '&', // 后台（注意：`&&` 已在上面被单独处理）
]

/**
 * 可安全放行的重定向形态。
 *
 * 只包含两类**不写真实文件**的重定向：
 *
 * 1. **fd 复制**：`2>&1`、`1>&2`、`>&2`
 *    只是把 stderr 并到 stdout（或反过来），改变的是输出流向，不碰文件系统。
 *
 * 2. **写入 /dev/null**：`2>/dev/null`、`>/dev/null`、`>>/dev/null`
 *    /dev/null 是黑洞设备，写入即丢弃。
 *
 * 刻意**不包含**：
 * - `> file` / `>> file`：能覆盖或追加任意文件（`> ~/.zshrc` 改写 shell 配置）
 * - `> /dev/sda` 等其他设备：写入会破坏磁盘
 * - `< file`：读取任意文件（输入重定向，语义不同，另作处理）
 */
const SAFE_REDIRECT = [
  /^\d*>&\d+$/, // 2>&1、1>&2
  /^>&\d+$/, // >&2（简写）
  /^\d*>>?\s*\/dev\/null$/, // >/dev/null、> /dev/null、2>>/dev/null
]

/**
 * 判断一个重定向 token 是否属于可安全放行的形态。
 *
 * @param {string} token - 形如 `2>&1` 的重定向片段（不含两侧空白）。
 * @returns {boolean} 是否安全。
 */
export function isSafeRedirect(token) {
  return SAFE_REDIRECT.some((pattern) => pattern.test(token))
}

/**
 * 从命令中剥离所有**安全重定向**，返回剩余文本。
 *
 * 用于「先剔除安全的、再看还剩什么危险构造」的判定顺序 ——
 * 否则 `2>&1 > out.txt` 里的 `>` 会被笼统判成危险，
 * 而实际上真正危险的是后半段。
 *
 * 匹配时要求 token 前后是空白或字符串边界，避免误伤
 * `echo "2>&1"` 之外的正常参数（引号内的情况由调用方的保守策略兜底）。
 *
 * @param {string} command - 规范化后的命令。
 * @returns {string} 剥离安全重定向后的文本。
 */
export function stripSafeRedirects(command) {
  // 全局匹配所有 `[n]>&[n]` 与 `[n]>/dev/null` 形态。
  return command
    .replace(/(^|\s)\d*>&\d+(?=\s|$)/g, '$1')
    // 允许 `> /dev/null`（带空格）与 `>/dev/null`（不带）两种写法。
    .replace(/(^|\s)\d*>>?\s*\/dev\/null(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 兼容旧名：所有构造（供测试与文档引用）。 */
const SHELL_COMPOSITION = [...SPLITTABLE, ...BLOCKING]

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
 * 找出命令中的**阻塞构造**（不可拆分的那类）。
 *
 * `&` 要特别处理：`&&` 是可拆分的分隔符，不能因为含 `&` 就判定为后台。
 * 做法是先把 `&&` 从文本里去掉再检查裸 `&`。
 *
 * @param {string} command - 规范化后的命令。
 * @returns {string | undefined} 命中的阻塞构造，没有则 undefined。
 */
export function blockingIn(command) {
  // 第一步：先剥离**安全重定向**（2>&1、>/dev/null 等）。
  //
  // 顺序很重要：`2>&1 > out.txt` 里既有安全的 fd 复制、又有危险的写文件。
  // 若直接扫 `>`，前半段就会把整条判成危险，虽然结论碰巧正确，
  // 但 `2>&1` 单独出现时也会被误拒 —— 那正是用户想放行的形态。
  const stripped = stripSafeRedirects(command)

  // 第二步：剔除 && 与 ||，它们的 & 和 | 不算阻塞。
  const withoutAndOr = stripped.replaceAll('&&', '').replaceAll('||', '')

  for (const token of BLOCKING) {
    if (token === '&') {
      // 只检查裸 &（此时 && 已被剔除）
      if (withoutAndOr.includes('&')) return '&'
      continue
    }
    if (token === '|') continue // | 是可拆分的，不在这里判
    if (stripped.includes(token)) return token
  }
  return undefined
}

/**
 * 按 `&&` `||` `;` `|` 把命令拆成若干段。
 *
 * 只做**朴素的字符串切分**，不实现完整的 shell 词法分析。这是有意的：
 * 引号内的分隔符会被误拆（`echo "a && b"` 会拆成两段），但那只会让
 * 判定**更严格**（多出一段要匹配规则），不会放行本该拒绝的命令。
 * 保守方向正确，就不需要写一个容易出错的 shell 解析器。
 *
 * @param {string} command - 规范化后的命令。
 * @returns {string[]} 各段（已 trim，已过滤空段）。
 */
export function splitSegments(command) {
  // 用一个不可能出现在命令里的占位符，避免链式替换互相干扰。
  const placeholder = '\u0000SEP\u0000'
  let text = command
  for (const token of ['&&', '||', ';', '|']) {
    text = text.split(token).join(placeholder)
  }
  return text
    .split(placeholder)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

/**
 * 单段命令是否匹配某条规则。
 *
 * @param {string} segment - 单段命令（已 trim）。
 * @param {string[]} rules - 规则列表。
 * @returns {string | undefined} 命中的规则，没有则 undefined。
 */
function matchRule(segment, rules) {
  for (const rule of rules) {
    if (segment === rule) return rule
    // 必须是「规则 + 空白 + 参数」，避免 `go` 匹配 `google-chrome`。
    if (segment.startsWith(`${rule} `)) return rule
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
    // 第一步：先挡**不可拆分**的构造。这些拆分也解决不了，必须整体拒绝。
    const blocking = blockingIn(text)
    if (blocking !== undefined) {
      return {
        allowed: false,
        reason: `命令含有不可拆分的 shell 构造 "${blocking}"（重定向 / 命令替换 / 变量展开 / 后台），不自动放行`,
      }
    }

    // 第二步：按 && || ; | 拆分，逐段匹配规则。
    // 每一段都必须在规则里，整条命令才放行。
    const segments = splitSegments(text)
    if (segments.length === 0) return { allowed: false, reason: '命令为空' }

    const matchedRules = []
    for (const segment of segments) {
      const rule = matchRule(segment, list)
      if (rule === undefined) {
        // 报告具体是哪一段没通过 —— 否则用户只知道「被拒」，
        // 不知道是自己漏配了规则还是命令真有问题。
        return {
          allowed: false,
          reason: `分段 "${segment}" 不匹配任何规则（共 ${segments.length} 段，前 ${matchedRules.length} 段已匹配）`,
        }
      }
      matchedRules.push(rule)
    }

    return {
      allowed: true,
      reason:
        segments.length === 1
          ? '命令匹配规则'
          : `${segments.length} 段命令全部匹配规则（${matchedRules.join(', ')}）`,
      rule: matchedRules.join(' + '),
    }
  }

  return { allowed: false, reason: `未知模式 "${mode}"` }
}
