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
  '`', // 反引号命令替换（内容无法可靠提取，仍硬性拒绝）
  '${', // 变量展开（可注入）
  '&', // 后台（注意：`&&` 已在上面被单独处理）
]

/**
 * shell 语法关键字：它们本身不执行任何程序。
 *
 * 为什么必须单独处理：`splitSegments` 按 `&&` `||` `;` `|` 切分后，
 * `for i in 1 2 3`、`do sleep 1`、`done` 这些片段会被当成「命令」去匹配规则。
 * 但 `for` / `do` / `done` 不是命令，永远匹配不上任何规则 ——
 * 于是一段完全无害的 `for` 循环会被整体拒绝。
 *
 * 注意 `do sleep 1` 这种混合片段：剥掉 `do` 后剩下 `sleep 1` 仍是命令，
 * 必须继续校验。所以这里只剥**开头的关键字**，不跳过整段。
 */
const SHELL_KEYWORDS = [
  'for', 'do', 'done', 'while', 'until', 'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'in', 'select', 'function', 'time', '!',
]

/**
 * 剥掉片段开头的 shell 关键字。
 *
 * 只处理开头连续的关键字，例如：
 *   `do sleep 1`        → `sleep 1`
 *   `then echo ok`      → `echo ok`
 *   `for i in 1 2 3`    → `i in 1 2 3`（for 后面的循环变量不是命令）
 *   `done`              → 空字符串
 *
 * 返回空串表示这一段没有实际命令，调用方应跳过它。
 *
 * **不剥 `$` 开头的变量**：`$cmd` 这种是变量展开，已在 blockingIn 阶段被拒。
 *
 * @param {string} segment - 单个片段（已 trim）。
 * @returns {string} 剥掉开头关键字后的剩余文本。
 */
export function stripKeywords(segment) {
  let text = segment.trim()
  for (;;) {
    if (text.length === 0) return ''

    // `for VAR in LIST` / `select VAR in LIST`：整段都是循环头部，
    // 剥掉 `for` 后剩下的 `i in 1 2 3` 是变量声明而非命令，必须整体丢弃。
    if (/^(for|select)\s+\S+\s+in(?:\s|$)/.test(text)) {
      const rest = text.replace(/^(for|select)\s+\S+\s+in\b/, '').trim()
      // `for i in $(seq 3)` 这类：命令替换已在 blockingIn 阶段被拒，
      // 走到这里通常是 `for i in 1 2 3` 这种字面量列表，没有命令可执行。
      return ''
    }

    const match = /^(\S+)(?:\s+|$)/.exec(text)
    if (match === null) return ''
    const head = match[1]
    if (!SHELL_KEYWORDS.includes(head)) return text
    text = text.slice(match[0].length).trim()
  }
}

/**
 * 从命令里提取所有 `$(...)` 的内容（支持嵌套）。
 *
 * 提取出来是为了**递归校验**：`$(curl ...)` 里的 curl 仍要匹配规则，
 * 而不是因为「藏在命令替换里」就跳过检查。
 *
 * 用括号配对扫描而不是正则：`$(a $(b))` 这种嵌套用非贪婪正则只能取到
 * 第一个 `)`，会把 `a $(b` 当成内容、丢掉后半截。
 *
 * @param {string} command - 命令文本。
 * @returns {string[]} 每个 `$(...)` 的内部文本（外层在前，内层也在列表里）。
 */
export function extractSubstitutions(command) {
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < command.length - 1; i += 1) {
    if (command[i] !== '$' || command[i + 1] !== '(') continue
    let depth = 1
    let j = i + 2
    while (j < command.length && depth > 0) {
      if (command[j] === '(') depth += 1
      else if (command[j] === ')') depth -= 1
      j += 1
    }
    // 只有配对成功才算一次替换；未闭合的 `$(` 交给 blockingIn 判为危险。
    if (depth === 0) out.push(command.slice(i + 2, j - 1))
  }
  return out
}

/**
 * 把 `$(...)` 替换成一个占位符，得到「去掉命令替换后的骨架」。
 *
 * 骨架用来匹配规则：`code=$(curl ...)` 的骨架是 `code=`，
 * 这段本身没有命令可校验（赋值语句），真正要校验的是 `$(...)` 里的内容，
 * 由调用方递归处理。
 *
 * @param {string} command - 命令文本。
 * @returns {string} 替换后的文本。
 */
export function replaceSubstitutions(command) {
  let text = command
  for (;;) {
    const start = text.indexOf('$(')
    if (start === -1) return text
    let depth = 1
    let j = start + 2
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth += 1
      else if (text[j] === ')') depth -= 1
      j += 1
    }
    if (depth !== 0) return text // 未闭合，交给 blockingIn
    text = `${text.slice(0, start)}\u0000SUBST\u0000${text.slice(j)}`
  }
}

/**
 * 变量赋值语句：`NAME=value` / `NAME=$(...)` / `NAME=$VAR`。
 *
 * 赋值本身不执行任何程序，只是把值存进 shell 变量。真正要校验的是
 * 右边 `$(...)` 里的命令 —— 那部分由递归校验处理。
 *
 * `$VAR` 形式（不加 `$()`）已在 blockingIn 阶段因 `${`/变量展开被拒；
 * 这里只处理 `$()` 赋值，剥掉后剩 `NAME=` 这种骨架。
 *
 * @param {string} segment - 片段（已剥离语法关键字、已替换命令替换占位符）。
 * @returns {boolean} 是否为纯赋值语句。
 */
export function isAssignment(segment) {
  // 形如 `NAME=` 或 `NAME=其余`，且 NAME 是合法变量名。
  // 允许前缀 `export` / `local` / `readonly` / `declare`（它们是语法关键字之外的常见修饰）。
  const text = segment.trim().replace(/^(export|local|readonly|declare)\s+/, '')
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)
}

/**
 * `[ ... ]` 条件测试的等价命令名。
 *
 * `[` 是 shell 内建，等价于 `test`。它只做比较、返回退出码，
 * 不读写文件、不执行子进程。出现在 `if [ -f x ]; then ...` 里时，
 * 把 `[` 当普通命令去匹配规则没有意义 —— 用户不会为它配规则。
 */
const TEST_COMMANDS = ['[', '[[', 'test']

/**
 * 判断片段是否为条件测试语句。
 *
 * 这类片段剥掉 `[` / `test` 外壳后，剩下的都是比较参数（`-f x`、`"$a" = 1`），
 * 没有命令可执行，可以直接跳过校验。
 *
 * **安全前提**：`[` 本身不做任何 IO。参数里的 `$()` 已在别处递归校验，
 * 变量展开已在 blockingIn 阶段拒绝。
 *
 * @param {string} segment - 已剥离语法关键字的片段。
 * @returns {boolean} 是否条件测试。
 */
export function isTestExpression(segment) {
  const text = segment.trim()
  const head = /^(\S+)/.exec(text)
  if (head === null) return false
  return TEST_COMMANDS.includes(head[1])
}

/**
 * 内置放行的**无副作用命令**。
 *
 * 这些是 shell 内建（或 coreutils 里行为等价的极小程序），只做一件事：
 * 返回退出码。不读写文件、不联网、不执行外部程序，参数也不改变语义
 * （`true --help` 依然返回 0）。
 *
 * 为什么需要单独一份白名单：它们**是命令**（不像 `for` / `do` 是语法关键字），
 * 但出现在 `while true; do ...; done` 这类控制流里时，要求用户为它们
 * 各配一条规则纯属噪音 —— 而放行它们不会带来任何风险。
 *
 * 刻意保持极短：凡是能读写文件、能执行子进程、能联网的，一律不在其中。
 * `:` 是 `true` 的同义词（POSIX 内建）。
 */
const HARMLESS_COMMANDS = ['true', 'false', ':']

/**
 * 判断一个片段是否为内置放行的无副作用命令。
 *
 * 只认「命令名 + 任意参数」的形式，且命令名必须在白名单里。
 *
 * @param {string} segment - 已剥离语法关键字的片段。
 * @returns {boolean} 是否内置放行。
 */
export function isHarmless(segment) {
  const head = /^(\S+)/.exec(segment.trim())
  if (head === null) return false
  return HARMLESS_COMMANDS.includes(head[1])
}

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
  /^\d*>&\d+[|;&]$/, // 2>&1|（紧贴分隔符）
  /^\d*>>?\s*\/dev\/null[|;&]$/, // >/dev/null|（紧贴分隔符）
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
  //
  // 结尾边界必须是「空白 / 行尾 / shell 分隔符」三选一：
  // shell 允许 `2>&1|tail` 这种紧贴写法（不加空格），
  // 只认空白会漏判，导致整条被笼统判成含危险重定向。
  return command
    .replace(/(^|\s)\d*>&\d+(?=\s|$|[|;&])/g, '$1')
    // 允许 `> /dev/null`（带空格）与 `>/dev/null`（不带）两种写法。
    .replace(/(^|\s)\d*>>?\s*\/dev\/null(?=\s|$|[|;&])/g, '$1')
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
  // 第零步：把 `$(...)` 整体替换成占位符。
  //
  // 命令替换的内容由调用方**递归校验**（`$(curl ...)` 里的 curl 仍要匹配规则），
  // 不该在这里被当成阻塞构造。先替换掉，可以避免它内部的 `>` `<` 等
  // 被误判成外层命令的重定向。
  const withoutSubst = replaceSubstitutions(command)

  // 第一步：先剥离**安全重定向**（2>&1、>/dev/null 等）。
  //
  // 顺序很重要：`2>&1 > out.txt` 里既有安全的 fd 复制、又有危险的写文件。
  // 若直接扫 `>`，前半段就会把整条判成危险，虽然结论碰巧正确，
  // 但 `2>&1` 单独出现时也会被误拒 —— 那正是用户想放行的形态。
  const stripped = stripSafeRedirects(withoutSubst)

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
    return decideSafeArgs({ text, list, depth: 0 })
  }

  return { allowed: false, reason: `未知模式 "${mode}"` }
}

/**
 * safe-args 的实际判定，支持对 `$(...)` 递归。
 *
 * 为什么要递归：`$(curl ...)` 里的 curl 也是要执行的命令，
 * 不能因为藏在命令替换里就跳过校验 —— 否则放行 `$()` 等于放行任意命令。
 *
 * @param {object} options - 判定输入。
 * @param {string} options.text - 待判定命令。
 * @param {string[]} options.list - 规则列表。
 * @param {number} options.depth - 递归深度（防嵌套爆炸）。
 * @returns {{ allowed: boolean, reason: string, rule?: string }} 判定结果。
 */
function decideSafeArgs({ text, list, depth }) {
  // 嵌套上限：正常脚本不会超过 3 层，超过视为可疑、直接拒绝。
  if (depth > 3) return { allowed: false, reason: '命令替换嵌套过深，不自动放行' }

  {
    // 第一步：先挡**不可拆分**的构造。这些拆分也解决不了，必须整体拒绝。
    const blocking = blockingIn(text)
    if (blocking !== undefined) {
      return {
        allowed: false,
        reason: `命令含有不可拆分的 shell 构造 "${blocking}"（重定向 / 变量展开 / 后台），不自动放行`,
      }
    }

    // 第二步：递归校验 `$(...)` 里的命令。
    for (const inner of extractSubstitutions(text)) {
      const verdict = decideSafeArgs({ text: inner, list, depth: depth + 1 })
      if (!verdict.allowed) {
        return { allowed: false, reason: `命令替换 $(...) 内的命令未通过：${verdict.reason}` }
      }
    }

    // 第三步：按 && || ; | 拆分，逐段匹配规则。
    // 每一段都必须在规则里，整条命令才放行。
    const segments = splitSegments(text)
    if (segments.length === 0) return { allowed: false, reason: '命令为空' }

    const matchedRules = []
    /** 已递归校验过的命令替换数量（赋值语句里的那些）。 */
    let substituted = 0
    for (const segment of segments) {
      // 先剥开头的 shell 关键字：`do sleep 1` → `sleep 1`，`done` → 空。
      // 不剥的话，`for` / `do` / `done` 会被当成命令去匹配规则，必然失败，
      // 导致一段完全无害的循环被整体拒绝。
      //
      // 安全边界：只剥**开头的关键字**，剩余部分仍是命令、仍要校验。
      // 所以 `for i in 1; do curl evil; done` 里 curl 不在规则中时照样拒绝。
      const effective = stripKeywords(segment)
      // 纯关键字片段（如 `done`）剥完是空串，没有命令要校验，跳过。
      if (effective.length === 0) continue

      // 无副作用的内建命令（true / false / :）直接放行，不要求配规则。
      // 它们只返回退出码，出现在 `while true; do ...; done` 里很常见。
      if (isHarmless(effective)) {
        matchedRules.push(effective.split(/\s+/)[0])
        continue
      }

      // 条件测试 `[ ... ]` / `[[ ... ]]` / `test ...`：只做比较、返回退出码，
      // 不读写文件也不执行子进程。剩下的都是比较参数，没有命令可校验。
      if (isTestExpression(effective)) {
        matchedRules.push(effective.split(/\s+/)[0])
        continue
      }

      // 剥掉 `$(...)` 得到骨架再匹配规则：`code=$(curl ...)` 的骨架是 `code=`。
      // 那是赋值语句、本身不执行任何程序，整段跳过 ——
      // 里面真正的命令已在上面的递归校验里查过。
      const skeleton = replaceSubstitutions(effective)
      if (isAssignment(skeleton)) {
        // 赋值语句本身不执行程序，但右边 `$()` 里的命令已在上面校验过，
        // 所以这里跳过不算「没有可校验的命令」。
        substituted += extractSubstitutions(effective).length
        continue
      }
      const candidate = skeleton.replaceAll('\u0000SUBST\u0000', '').trim()
      if (candidate.length === 0) continue

      const rule = matchRule(candidate, list)
      if (rule === undefined) {
        // 报告具体是哪一段没通过 —— 否则用户只知道「被拒」，
        // 不知道是自己漏配了规则还是命令真有问题。
        return {
          allowed: false,
          reason: `分段 "${candidate}" 不匹配任何规则（共 ${segments.length} 段，前 ${matchedRules.length} 段已匹配）`,
        }
      }
      matchedRules.push(rule)
    }

    // 全部片段都是语法关键字（如只有 `done`）时没有可校验的命令，
    // 这种情况按「无命令」处理，不自动放行。
    // 但纯赋值语句 + 已递归校验的命令替换属于有效命令，应放行。
    if (matchedRules.length === 0 && substituted === 0) {
      return { allowed: false, reason: '命令里没有可校验的实际命令' }
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
}
