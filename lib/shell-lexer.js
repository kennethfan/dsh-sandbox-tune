/**
 * 极简 shell 词法器：把命令行切成 token，正确处理引号与转义。
 *
 * ## 为什么需要它
 *
 * 之前的实现用 `String.split()` 按 `&&` `||` `;` `|` 切分，然后拿每一段去
 * 匹配规则。这在引号上直接失效：
 *
 *   git commit -m "fix: a && b"    → 被切成两段 → 第二段 "b"" 匹配不到规则 → 拒绝
 *   echo "a; b"                     → 同上
 *
 * 而这两种写法极其常见。字符串切分无法区分「分隔符」与「字符串内容里的分隔符」，
 * 这是词法问题，只能靠词法器解决。
 *
 * ## 不引入外部依赖的原因
 *
 * 本插件以 `link:` 安装，Node 模块解析不会回溯到 profile 的 `node_modules`，
 * `import 'bash-parser'` 在真实运行时是 ERR_MODULE_NOT_FOUND（踩过）。
 * 而且我们只需要「切词 + 识别分隔符」，不需要完整 AST。
 *
 * ## 支持的语法
 *
 * - 单引号 `'...'`：内部一切原样，不转义
 * - 双引号 `"..."`：内部支持 `\"` `\\` `\$` `\`` 转义，但**分隔符不拆**
 * - 反斜杠转义：`\ ` `\;` 等
 * - 分隔符：`&&` `||` `;` `|`
 * - 重定向：`>` `>>` `<` `2>` `2>&1` 等（作为独立 token）
 * - 命令替换 `$(...)`：整体作为 `subst` token，内容单独保留
 *
 * 不支持的（会被当作普通字符或保守拒绝）：
 * - here-doc `<<EOF`
 * - 进程替换 `<(...)` `>(...)`
 * - 数组、算术展开 `$((...))`
 *
 * @module lib/shell-lexer
 */

/** token 类型。 */
export const TOKEN = Object.freeze({
  /** 普通单词（命令名或参数）。 */
  WORD: 'word',
  /** 带引号的字符串（引号已剥离）。 */
  STRING: 'string',
  /** 命令替换 `$(...)`，`value` 是内部文本。 */
  SUBST: 'subst',
  /** 分隔符：`&&` `||` `;` `|`。 */
  OPERATOR: 'operator',
  /** 重定向：`>` `>>` `<` `2>` `2>&1` 等。 */
  REDIRECT: 'redirect',
})

/** 分隔符（会切段）。 */
const OPERATORS = ['&&', '||', ';', '|']

/**
 * 判断一个字符是否需要在双引号内转义。
 *
 * @param {string} ch - 下一个字符。
 * @returns {boolean} 是否需要转义。
 */
function isDoubleQuoteEscape(ch) {
  return ch === '"' || ch === '\\' || ch === '$' || ch === '`'
}

/**
 * 从 `$(` 开始扫描到配对的 `)`，返回内部文本与结束位置。
 *
 * 用括号计数而不是正则：`$(a $(b))` 用非贪婪正则只能取到第一个 `)`。
 * 扫描时跳过引号内的括号，避免 `$(echo ")")` 提前结束。
 *
 * @param {string} text - 命令文本。
 * @param {number} start - `$` 的下标。
 * @returns {{ inner: string, end: number } | undefined} 内部文本与右括号之后的下标。
 */
export function scanSubstitution(text, start) {
  let depth = 1
  let i = start + 2
  let quote = ''
  while (i < text.length) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i += 1
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return { inner: text.slice(start + 2, i), end: i + 1 }
    }
    i += 1
  }
  // 未闭合：返回 undefined，调用方按危险处理。
  return undefined
}

/**
 * 把命令行切成 token。
 *
 * @param {string} command - 原始命令文本。
 * @returns {Array<{ type: string, value: string, raw: string }>} token 列表。
 */
export function tokenize(command) {
  /** @type {Array<{ type: string, value: string, raw: string }>} */
  const tokens = []
  let i = 0

  /** 当前正在累积的单词缓冲区。 */
  let word = ''
  /** 当前单词是否含引号（决定 type 是 WORD 还是 STRING）。 */
  let quoted = false
  /** 当前单词的原始文本（含引号），用于报错时展示。 */
  let raw = ''

  const flush = () => {
    if (word.length === 0 && raw.length === 0) return
    tokens.push({ type: quoted ? TOKEN.STRING : TOKEN.WORD, value: word, raw })
    word = ''
    raw = ''
    quoted = false
  }

  while (i < command.length) {
    const ch = command[i]

    // ---- 空白：结束当前单词 ----
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flush()
      i += 1
      continue
    }

    // ---- 分隔符 ----
    const op = OPERATORS.find((o) => command.startsWith(o, i))
    if (op !== undefined) {
      flush()
      tokens.push({ type: TOKEN.OPERATOR, value: op, raw: op })
      i += op.length
      continue
    }

    // ---- 重定向（含 fd 前缀，如 2>、2>&1） ----
    // 先看当前位置是否构成重定向；`2>&1` 这种要整体吃掉。
    // 重定向 token 要把目标一起吃掉：`2>/dev/null` 是一个整体，
    // 拆成 `2>` + `/dev/null` 会让 isSafeRedirect 无法判定。
    //
    // 分支顺序很重要：`2>&1` 必须优先于 `2>` 匹配，否则会被切成
    // `2>` + `&1`。所以 fd 复制形式（`n>&m`）排在最前。
    // `/dev/null` 必须完整匹配且后面是边界：`> /dev/nullx` 是**另一个文件**
    // （名为 nullx），若被当成 /dev/null 放行就是安全漏洞。
    const redirect =
      /^(?:\d*)>&\d+|^&>|^(?:\d*)(?:>>?|<<?)\s*(?:\/dev\/null(?![\w./-])|[^\s|&;]+)?/.exec(
        command.slice(i),
      )
    if (redirect !== null && redirect[0].length > 0) {
      const before = i === 0 ? ' ' : command[i - 1]
      // 只有当重定向出现在词首（前一字符是空白/分隔符）时才认，
      // 避免把 `a>b` 里的 `>` 从单词中间切开（那种情况本就该按重定向处理，
      // 但 `echo "a>b"` 已在引号分支里处理，不会走到这）。
      if (/\s/.test(before) || i === 0) {
        flush()
        tokens.push({ type: TOKEN.REDIRECT, value: redirect[0], raw: redirect[0] })
        i += redirect[0].length
        continue
      }
    }

    // ---- 单引号：内部一切原样 ----
    if (ch === "'") {
      const close = command.indexOf("'", i + 1)
      if (close === -1) {
        // 未闭合：保守处理，把剩余全部当内容。
        word += command.slice(i + 1)
        raw += command.slice(i)
        quoted = true
        i = command.length
        continue
      }
      const inner = command.slice(i + 1, close)
      word += inner
      raw += command.slice(i, close + 1)
      quoted = true
      i = close + 1
      continue
    }

    // ---- 双引号：支持转义，分隔符不拆 ----
    if (ch === '"') {
      let j = i + 1
      let inner = ''
      while (j < command.length) {
        const c = command[j]
        if (c === '\\' && j + 1 < command.length && isDoubleQuoteEscape(command[j + 1])) {
          inner += command[j + 1]
          j += 2
          continue
        }
        if (c === '"') break
        inner += c
        j += 1
      }
      word += inner
      raw += command.slice(i, Math.min(j + 1, command.length))
      quoted = true
      i = j + 1
      continue
    }

    // ---- 命令替换 $(...) ----
    if (ch === '$' && command[i + 1] === '(') {
      const scanned = scanSubstitution(command, i)
      if (scanned === undefined) {
        // 未闭合：作为普通字符保留，后续 blockingIn 会因 `${`/残留 `$(` 拒绝。
        word += ch
        raw += ch
        i += 1
        continue
      }
      flush()
      tokens.push({
        type: TOKEN.SUBST,
        value: scanned.inner,
        raw: command.slice(i, scanned.end),
      })
      i = scanned.end
      continue
    }

    // ---- 反斜杠转义 ----
    if (ch === '\\' && i + 1 < command.length) {
      word += command[i + 1]
      raw += command.slice(i, i + 2)
      i += 2
      continue
    }

    // ---- 普通字符 ----
    word += ch
    raw += ch
    i += 1
  }

  flush()
  return tokens
}

/**
 * 按分隔符把 token 切成「命令段」。
 *
 * 每段是一组 token（不含分隔符本身）。这样后续判定在 token 层面进行，
 * 引号内的分隔符早已是 STRING token 的内容，不会被误切。
 *
 * @param {Array<{ type: string, value: string, raw: string }>} tokens - token 列表。
 * @returns {Array<Array<{ type: string, value: string, raw: string }>>} 命令段列表。
 */
export function splitCommands(tokens) {
  /** @type {Array<Array<{ type: string, value: string, raw: string }>>} */
  const commands = []
  /** @type {Array<{ type: string, value: string, raw: string }>} */
  let current = []
  for (const token of tokens) {
    if (token.type === TOKEN.OPERATOR) {
      if (current.length > 0) commands.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) commands.push(current)
  return commands
}

/**
 * 把一组 token 还原成可读文本（用于错误提示）。
 *
 * @param {Array<{ type: string, value: string, raw: string }>} tokens - token 列表。
 * @returns {string} 拼接后的文本。
 */
export function joinTokens(tokens) {
  return tokens
    .map((token) => {
      if (token.type === TOKEN.SUBST) return `$(${token.value})`
      if (token.type === TOKEN.STRING) return `"${token.value}"`
      return token.value
    })
    .join(' ')
}
