/**
 * 配置文件自监听：让改 `cordis.patch.yml` 后无需重启 DSH。
 *
 * ## 为什么不用 DSH 自带的 HMR
 *
 * DSH 的 `dsh-hmr` 确实会监听 profile 的 patch 文件（见其
 * `Service.init` 里的 `watchConfig(profile.patchPath, ...)`），但它在构造时
 * 有硬性前置检查：
 *
 *   if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service")
 *
 * 而 `dsh web` 默认不带 `--expose-internals`（该参数也不能经 NODE_OPTIONS
 * 传入，Node 会直接拒绝）。实测即使手动用
 * `node --expose-internals bin.js` 启动，配置改动仍不触发重载。
 *
 * 与其依赖一条需要改启动参数、且用到 Node 内部 API 的链路，不如本插件
 * 自己监听 —— 只需 `fs.watch`，不碰内部 API，失败也只影响本插件。
 *
 * ## 能力边界（必须明确）
 *
 * **只对配置值生效**：规则、目录、模式、开关。
 * **对插件树结构无效**：启用/禁用插件、增删 loader 行 —— 那需要加载新模块，
 * 本质上必须重启。
 *
 * @module lib/config-watch
 */

import { readFileSync, watch } from 'node:fs'
import { dirname } from 'node:path'


/** 本插件在 profile patch 里的 loader 行 id。 */
export const EXECUTOR_ROW = 'sandbox-tune-bash'
export const PROVIDER_ROW = 'sandbox-tune-provider'

/**
 * 把一段 YAML 标量文本解析成 JS 值。
 *
 * 只处理 patch 文件里实际会出现的形态：字符串、数字、布尔、null、
 * 行内数组 `[a, b]`、引号包裹的字符串。
 *
 * **为什么不用 YAML 库**：本插件以 `link:` 方式安装时，Node 的模块解析
 * 不会回溯到 profile 的 `node_modules`，`import 'yaml'` / `'js-yaml'`
 * 在真实运行时都会 `ERR_MODULE_NOT_FOUND`（实测踩过：启动日志报
 * `failed to import` 导致整个插件不激活）。而 config 段的取值形态有限，
 * 自己解析比引入依赖更可靠。
 *
 * @param {string} raw - 去掉注释与首尾空白后的文本。
 * @returns {unknown} 解析结果。
 */
export function parseScalar(raw) {
  const text = raw.trim()
  if (text.length === 0) return ''
  // 引号字符串：去掉引号，保留内部原样（不处理转义，config 里不会用到）。
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  // 行内数组 [a, b, c]
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner.length === 0) return []
    return inner.split(',').map((item) => parseScalar(item))
  }
  // 行内对象 {a: 1}（config 里少见，但 env 可能这么写）
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim()
    /** @type {Record<string, unknown>} */
    const out = {}
    if (inner.length === 0) return out
    for (const pair of splitTopLevel(inner, ',')) {
      const idx = pair.indexOf(':')
      if (idx <= 0) continue
      out[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1))
    }
    return out
  }
  // 纯数字
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

/**
 * 按分隔符切分，忽略括号/引号内部的分隔符。
 *
 * @param {string} text - 待切分文本。
 * @param {string} sep - 单字符分隔符。
 * @returns {string[]} 切片。
 */
function splitTopLevel(text, sep) {
  const out = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '[' || ch === '{') { depth += 1; continue }
    if (ch === ']' || ch === '}') { depth -= 1; continue }
    if (ch === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/**
 * 去掉 YAML 行尾注释（引号内的 `#` 不算）。
 *
 * @param {string} line - 单行文本。
 * @returns {string} 去掉注释后的文本。
 */
function stripComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    // ` #` 才算注释（`a#b` 是普通字符）
    if (ch === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i)
  }
  return line
}

/**
 * 从 patch 文件内容里取出指定行的 config 段。
 *
 * patch 文件是 YAML 数组，每项形如：
 *
 *   - id: sandbox-tune-bash
 *     name: 'dsh-sandbox-tune/executor'
 *     config:
 *       mode: redirect
 *       presets: [go, npm]
 *
 * 实现方式是**按缩进扫描**，而不是完整 YAML 解析：先定位 `- id: <rowId>`，
 * 再收集其后缩进更深的 `config:` 块，逐行解析 key/value 与列表项。
 *
 * 找不到该行时返回 `undefined`（区别于「该行存在但没写 config」，后者返回 `{}`）。
 *
 * @param {string} text - patch 文件的原始文本。
 * @param {string} rowId - 目标行 id。
 * @returns {Record<string, unknown> | undefined} config 段，或 undefined。
 */
export function configOfRow(text, rowId) {
  const lines = text.split(/\r?\n/)

  // 1) 找到目标行：形如 `- id: xxx`（可能有前导空白）
  let startIndex = -1
  let rowIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i])
    const m = /^(\s*)-\s*id:\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    const value = parseScalar(m[2])
    if (value === rowId) {
      startIndex = i
      rowIndent = m[1].length
      break
    }
  }
  if (startIndex === -1) return undefined

  // 2) 收集这一行的所有子行（缩进比 rowIndent 深，直到遇到同级或更浅的行）
  const body = []
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = stripComment(lines[i])
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length
    // 遇到下一个行首 `- ` 或缩进回到行级 → 本行结束
    if (indent <= rowIndent) break
    body.push({ indent, text: line.trim() })
  }

  // 3) 在 body 里找 config: 块
  let configIndex = -1
  let configIndent = 0
  for (let i = 0; i < body.length; i += 1) {
    if (/^config:\s*$/.test(body[i].text)) {
      configIndex = i
      configIndent = body[i].indent
      break
    }
    // `config: {}` 这种行内空对象
    if (/^config:\s*\{\}\s*$/.test(body[i].text)) return {}
  }
  // 行存在但没写 config → 空对象
  if (configIndex === -1) return {}

  // 4) 解析 config 块的内容
  /** @type {Record<string, unknown>} */
  const config = {}
  let i = configIndex + 1
  while (i < body.length) {
    const { indent, text: lineText } = body[i]
    if (indent <= configIndent) break

    // 列表项：`- value`
    if (lineText.startsWith('- ')) {
      i += 1
      continue
    }

    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lineText)
    if (m === null) { i += 1; continue }
    const key = m[1]
    const rest = m[2].trim()

    if (rest.length > 0) {
      // 行内值
      config[key] = parseScalar(rest)
      i += 1
      continue
    }

    // 值在后续行：可能是列表或嵌套对象
    const childIndent = indent
    const items = []
    const nested = {}
    let j = i + 1
    while (j < body.length && body[j].indent > childIndent) {
      const childText = body[j].text
      if (childText.startsWith('- ')) {
        items.push(parseScalar(childText.slice(2)))
      } else {
        const nm = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(childText)
        if (nm !== null) nested[nm[1]] = parseScalar(nm[2])
      }
      j += 1
    }
    if (items.length > 0) config[key] = items
    else if (Object.keys(nested).length > 0) config[key] = nested
    else config[key] = ''
    i = j
  }

  return config
}

/**
 * 用 schema 重建配置对象。
 *
 * volatile 字段是 `{ get }` 形式的只读取值器（闭包持有值），**没有 set 方法**，
 * 所以无法原地改值。唯一干净的写法是用 schema 重新构建一个对象 ——
 * 这样校验、默认值、volatile 包装都由 schemastery 自己完成。
 *
 * @param {object} schema - schemastery 的 Config schema。
 * @param {Record<string, unknown>} raw - 新的 config 段。
 * @returns {{ config: object } | { error: Error }} 重建结果。
 */
export function rebuildConfig(schema, raw) {
  try {
    // schema(value) 会做校验并填充默认值；非法值抛错。
    return { config: schema(raw ?? {}) }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * 监听 patch 文件，变化时回调。
 *
 * 细节处理：
 * - **防抖**：编辑器保存常触发多次事件（write + rename），合并成一次。
 * - **内容比对**：`fs.watch` 在某些平台会对未改动的内容也触发事件，
 *   用上次文本做去重，避免无意义的重复 apply。
 * - **文件替换**：编辑器「原子保存」会 unlink 再 create，watch 句柄可能失效，
 *   所以监听的是**父目录**而不是文件本身。
 * - **失败保留旧配置**：解析失败只记警告，不动当前配置。
 *
 * @param {object} options - 监听选项。
 * @param {string} options.file - 要监听的 patch 文件绝对路径。
 * @param {number} [options.debounceMs] - 防抖窗口，默认 300ms。
 * @param {(text: string) => void} options.onChange - 内容变化回调（已去重）。
 * @param {(error: Error) => void} [options.onError] - 出错回调。
 * @returns {() => void} 取消监听的函数。
 */
export function watchPatchFile({ file, debounceMs = 300, onChange, onError }) {
  let lastText
  try {
    lastText = readFileSync(file, 'utf8')
  } catch {
    // 启动时文件不存在不算错误：等它出现即可。
    lastText = undefined
  }

  let timer
  let watcher
  let closed = false

  const fire = () => {
    if (closed) return
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      // 文件被临时删除（原子保存的中间态）：忽略，等下一次事件。
      return
    }
    // 内容没变就不重复 apply —— fs.watch 可能对未改动内容触发事件。
    if (text === lastText) return
    lastText = text
    try {
      onChange(text)
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const schedule = () => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      fire()
    }, debounceMs)
    // 不要因为这个定时器让进程无法退出。
    timer.unref?.()
  }

  try {
    // 监听父目录：原子保存会替换文件本身，盯着文件会丢事件。
    watcher = watch(dirname(file), { persistent: false }, (_event, filename) => {
      if (filename === undefined) return
      // 只关心目标文件名。
      if (!String(filename).startsWith(file.slice(file.lastIndexOf('/') + 1))) return
      schedule()
    })
    watcher.on('error', (error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)))
    })
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)))
    return () => {}
  }

  return () => {
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    watcher?.close()
  }
}
