/**
 * 构建工具缓存的路径探测与预设表。
 *
 * 背景：沙箱（workspace-write）只允许写「工作区 + /tmp + 用户临时目录」，
 * 而各类构建工具默认把缓存写到工作区之外，于是每次编译都被内核拒绝
 * （macOS Seatbelt 报 `Operation not permitted`），模型只能提权到
 * danger-full-access —— 也就是那个每次都弹的窗。
 *
 * 两种消除方式，本插件都支持，由 `mode` 选择：
 *
 * - **redirect（默认）**：用环境变量把**纯缓存**指到 `$TMPDIR/dsh`。
 *   任何沙箱后端都能用（临时目录本来就放行），代价是缓存分裂成两套，
 *   与普通终端里的缓存不共用。
 * - **in-place**：不改变任何路径，把工具**真实的**缓存目录加进沙箱可写
 *   白名单。好处是与普通终端完全共用缓存、无冷启动；前提是沙箱后端
 *   支持追加白名单（Seatbelt / bwrap），否则自动回退到 redirect。
 *
 * 关键区分 —— 缓存分两类，可重定向性完全不同：
 *
 * - **cache（纯缓存）**：丢了只是变慢，可以重定向。
 * - **store（依赖仓库）**：丢了就编译不了，**绝不能重定向**。
 *   把 GOMODCACHE 指到空目录，`go build` 会立刻报「找不到模块」，比弹窗更糟。
 *   因此 store 只参与 in-place 授权，永不进入重定向表。
 *
 * @module lib/cache-env
 */

import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 缓存目录的默认根：系统临时目录下的 `dsh` 子目录。
 *
 * 只在 redirect 模式下使用。选它的理由：`os.tmpdir()` 是 workspace-write
 * 明确放行的可写区域（Seatbelt profile 里有 `(subpath <tmpdir>)`），
 * 因此不需要任何白名单扩展。
 */
export function defaultCacheRoot() {
  return join(tmpdir(), 'dsh')
}

/**
 * 平台默认的「用户缓存目录」。
 *
 * 不复用 `os.tmpdir()`：这里是持久缓存目录，不是临时目录。
 *
 * 三个平台各有自己的约定，不能一律用 `~/.cache`：
 * - macOS：`~/Library/Caches`
 * - Windows：`%LOCALAPPDATA%`（`~/.cache` 在 Windows 上不是标准位置）
 * - Linux/其他：`$XDG_CACHE_HOME` 或 `~/.cache`
 *
 * @returns {string} 平台缓存目录的绝对路径。
 */
function platformCacheHome() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  if (process.platform === 'win32') {
    // Windows 的标准缓存位置是 LOCALAPPDATA；缺失时退回 ~/AppData/Local。
    const local = process.env.LOCALAPPDATA
    if (local && isAbsolute(local)) return local
    return join(homedir(), 'AppData', 'Local')
  }
  const xdg = process.env.XDG_CACHE_HOME
  if (xdg && isAbsolute(xdg)) return xdg
  return join(homedir(), '.cache')
}

/**
 * Go 的 GOPATH：环境变量优先，否则用 Go 的惯例默认值。
 *
 * @returns {string} GOPATH 绝对路径。
 */
function goPath() {
  const value = process.env.GOPATH
  if (value && isAbsolute(value)) return value
  return join(homedir(), 'go')
}

/**
 * 各构建工具的缓存约定。
 *
 * - `kind`：`cache` 可重定向；`store` 只可原地授权。
 * - `probe`：探测真实路径的命令。**Host 进程不在沙箱内**，所以这些只读
 *   探测可以正常执行；探测不到时回落到 `fallback`。
 * - `fallback`：静态默认值。之所以需要探测而不是硬编码，是因为本机用
 *   gvm 管理 Go，GOMODCACHE 在 `~/.gvm/pkgsets/...` 而非 `~/go/pkg/mod`，
 *   静态猜会授权到一个不存在的目录。
 */
export const CACHE_PRESETS = Object.freeze({
  go: {
    entries: [
      {
        env: 'GOCACHE',
        kind: 'cache',
        subdir: 'go-build',
        probe: { command: 'go', args: ['env', 'GOCACHE'] },
        fallback: () => join(platformCacheHome(), 'go-build'),
      },
      {
        env: 'GOMODCACHE',
        kind: 'store',
        subdir: 'go-mod',
        probe: { command: 'go', args: ['env', 'GOMODCACHE'] },
        fallback: () => join(goPath(), 'pkg', 'mod'),
      },
    ],
  },
  npm: {
    entries: [
      {
        env: 'NPM_CONFIG_CACHE',
        kind: 'cache',
        subdir: 'npm',
        probe: { command: 'npm', args: ['config', 'get', 'cache'] },
        fallback: () => join(homedir(), '.npm'),
      },
    ],
  },
  bun: {
    entries: [
      {
        env: 'BUN_INSTALL_CACHE_DIR',
        kind: 'cache',
        subdir: 'bun',
        probe: { command: 'bun', args: ['pm', 'cache'] },
        fallback: () => join(homedir(), '.bun', 'install', 'cache'),
      },
    ],
  },
  pip: {
    entries: [
      {
        env: 'PIP_CACHE_DIR',
        kind: 'cache',
        subdir: 'pip',
        probe: null,
        fallback: () => join(platformCacheHome(), 'pip'),
      },
    ],
  },
  cargo: {
    entries: [
      {
        env: 'CARGO_HOME',
        kind: 'store',
        subdir: 'cargo',
        probe: null,
        fallback: () => join(homedir(), '.cargo'),
      },
    ],
  },
})

/** 预设名列表，供配置校验与文档使用。 */
export const PRESET_NAMES = Object.freeze(Object.keys(CACHE_PRESETS))

/** 两种运行模式。 */
export const MODES = Object.freeze(['redirect', 'in-place'])

/**
 * 展开用户输入里的 `~` 与 `~/`。
 *
 * 配置里写 `~/cache` 是人之常情，但 Node 的 path 不认识 `~`；不展开就会
 * 在 cwd 下建出一个名叫 `~` 的目录，属于静默的错误行为。
 *
 * @param {string} value - 原始值。
 * @returns {string} 展开后的路径。
 */
export function expandHome(value) {
  if (!value) return value
  const home = homedir()
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

/**
 * 把缓存根解析成绝对路径（仅 redirect 模式使用）。
 *
 * 相对路径按 `base` 解析而不是 `process.cwd()`：插件里 `process.cwd()` 是
 * harness 的启动目录，与用户以为的「当前项目」不是一回事。
 *
 * @param {string | undefined} cacheRoot - 配置里的缓存根，空值走默认。
 * @param {string} base - 相对路径的解析基准。
 * @returns {string} 绝对路径。
 */
export function resolveCacheRoot(cacheRoot, base) {
  const value = cacheRoot?.trim()
  if (!value) return defaultCacheRoot()
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

/**
 * 探测工具的真实缓存路径。
 *
 * 每个条目独立探测、独立失败：某个工具没装就回落到静态默认值，
 * 不影响其他工具。探测有超时，避免卡住的 CLI 拖慢插件。
 *
 * @param {object} options - 探测选项。
 * @param {string[]} options.presets - 预设名。
 * @param {number} [options.timeoutMs] - 单个探测的超时。
 * @param {(cmd: string, args: string[], timeoutMs: number) => Promise<string>} [options.run]
 *   - 执行器，便于测试注入。
 * @returns {Promise<Array<{ preset: string, env: string, kind: string, path: string, source: string }>>}
 */
export async function detectCachePaths({ presets, timeoutMs = 2000, run }) {
  const execute = run ?? defaultRun
  const out = []

  await Promise.all(
    presets.map(async (name) => {
      const preset = CACHE_PRESETS[name]
      if (!preset) return
      for (const entry of preset.entries) {
        // 环境变量是最权威的来源：用户显式设置过就以它为准。
        const fromEnv = process.env[entry.env]
        if (fromEnv && fromEnv.length > 0) {
          out.push({
            preset: name,
            env: entry.env,
            kind: entry.kind,
            path: expandHome(fromEnv),
            source: 'env',
          })
          continue
        }
        if (entry.probe) {
          try {
            const raw = await execute(entry.probe.command, entry.probe.args, timeoutMs)
            const value = String(raw ?? '').trim().split('\n')[0].trim()
            if (value.length > 0 && isAbsolute(value)) {
              out.push({
                preset: name,
                env: entry.env,
                kind: entry.kind,
                path: value,
                source: 'probe',
              })
              continue
            }
          } catch {
            // 工具没装或探测超时：落到静态默认值，不中断其他条目。
          }
        }
        out.push({
          preset: name,
          env: entry.env,
          kind: entry.kind,
          path: entry.fallback(),
          source: 'fallback',
        })
      }
    }),
  )

  return out
}

/**
 * 默认的探测执行器：跑一个只读命令并返回 stdout。
 *
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<string>} stdout。
 */
async function defaultRun(command, args, timeoutMs) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  return stdout
}

/**
 * 计算重定向用的环境变量表（只处理纯缓存，绝不碰依赖仓库）。
 *
 * @param {object} options - 注入选项。
 * @param {string} options.cacheRoot - 已解析的绝对缓存根。
 * @param {string[]} options.presets - 启用哪些工具预设。
 * @param {Record<string, string>} [options.extraEnv] - 用户追加/覆盖的变量，优先级最高。
 * @param {(name: string) => string | undefined} [options.lookup] - 读取当前进程环境，
 *   用于「已经显式设置过就不覆盖」。
 * @returns {{ env: Record<string, string>, dirs: string[] }} 注入表与需要存在的目录。
 */
export function buildCacheEnv({ cacheRoot, presets, extraEnv = {}, lookup = () => undefined }) {
  /** @type {Record<string, string>} */
  const env = {}
  /** @type {string[]} */
  const dirs = []

  for (const name of presets) {
    const preset = CACHE_PRESETS[name]
    // 未知预设不该让插件失效：配置写错时跳过并继续，行为可预期。
    if (!preset) continue
    for (const entry of preset.entries) {
      // 依赖仓库绝不重定向：指到空目录会让构建直接失败。
      if (entry.kind !== 'cache') continue
      const dir = join(cacheRoot, entry.subdir)
      dirs.push(dir)
      // 用户（或部署环境）已经显式指定过就尊重它，插件不夺权。
      if (lookup(entry.env) !== undefined) continue
      env[entry.env] = dir
    }
  }

  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (typeof value !== 'string' || value.length === 0) continue
    env[key] = expandHome(value)
  }

  return { env, dirs: [...new Set(dirs)] }
}

/**
 * 判断一条命令「大概」会用到哪些缓存 —— 仅用于日志与提示，不改变行为。
 *
 * 判断一段 shell 语法到底调用了哪个工具并不可靠（`make test`、`./build.sh`
 * 里都可能有 go），所以这里只做诊断输出。
 *
 * @param {string} command - shell 命令原文。
 * @returns {string[]} 命中的预设名。
 */
export function guessPresetsFor(command) {
  const text = String(command ?? '')
  const patterns = {
    go: /(^|[\s;&|(])go(\s|$)/,
    npm: /(^|[\s;&|(])npm(\s|$)/,
    bun: /(^|[\s;&|(])bun(\s|$)/,
    pip: /(^|[\s;&|(])(pip|pip3)(\s|$)/,
    cargo: /(^|[\s;&|(])cargo(\s|$)/,
  }
  const hits = []
  for (const [name, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) hits.push(name)
  }
  return hits
}
