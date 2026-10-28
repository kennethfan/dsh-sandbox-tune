/**
 * 用户级目录预设：解决「开发工具必须写工作区外的配置」这类弹窗。
 *
 * 背景：统计过 517 次历史审批，除 Go 缓存（28%，已由本插件解决）外，
 * 最大一类是**写工作区外的用户配置目录**（27%），例如：
 *   - ~/.config/opencode   —— CLI 配置
 *   - ~/.cache/...         —— 各类工具缓存
 *   - ~/.local/share/...   —— 应用数据
 * 沙箱只允许写「工作区 + /tmp + 临时目录」，所以这些写入全部被拒，
 * 模型只能升权到 danger-full-access。
 *
 * 解法与 Go 缓存同源：**不改变任何路径，只把这些目录加进可写白名单**。
 * 这与「按命令放行」有本质区别 —— 命令仍在沙箱内执行，只是多了几个可写
 * 目录；而按命令放行等于把整条命令提到 danger-full-access，安全边界差得多。
 *
 * 默认全部关闭：放宽文件写入边界是有代价的（沙箱内进程可以修改你的配置），
 * 必须由使用者显式勾选。
 *
 * @module lib/user-dirs
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * 可选预置的用户级目录。
 *
 * 每项都给出「为什么可能想开」与「开了有什么风险」，因为设置页会展示它们。
 * `risk` 用于界面上的风险提示，`benefit` 用于说明收益。
 */
export const USER_DIR_PRESETS = Object.freeze({
  'user-config': {
    label: '配置目录',
    benefit: '各类 CLI 的配置目录（opencode、gh 等），是最常见的一类弹窗来源。',
    risk: '沙箱内进程可以读写你的所有 CLI 配置，包括写入新的配置项。',
    // Windows 的配置目录是 %APPDATA%，POSIX 才是 ~/.config。
    path: () => (process.platform === 'win32' ? appDataDir() : join(homedir(), '.config')),
  },
  'user-cache': {
    label: '缓存目录',
    benefit: '命令行工具的通用缓存目录（npm / pip / bun 等），是仅次于配置目录的弹窗来源。',
    risk: '风险较低：缓存丢了只是变慢，但内容可被篡改。',
    // 刻意**不用** macOS 的 ~/Library/Caches：那是系统级缓存，本机实测 5.9GB，
    // 含 Docker / AndroidStudio / CloudKit 等无关内容，授权它远超「工具缓存」的范围。
    // 这里只用 XDG 风格的 ~/.cache —— 各类 CLI 工具实际写的就是它。
    // Windows 上 ~/.cache 不是惯例，用 %LOCALAPPDATA%（npm 等写这里）。
    path: () => (process.platform === 'win32' ? localAppDataDir() : join(homedir(), '.cache')),
  },
  'user-data': {
    label: '应用数据目录',
    benefit: '应用数据目录，含部分工具的状态与会话数据。',
    risk: '沙箱内进程可以修改应用数据，包括数据库文件。',
    // Windows 的本地应用数据在 %LOCALAPPDATA%。
    path: () =>
      process.platform === 'win32'
        ? localAppDataDir()
        : join(homedir(), '.local', 'share'),
  },
  'user-state': {
    label: '运行状态目录',
    benefit: '应用运行状态与日志目录。',
    risk: '风险较低：主要是日志与状态，但可被伪造。',
    path: () =>
      process.platform === 'win32'
        ? localAppDataDir()
        : join(homedir(), '.local', 'state'),
  },
})

/**
 * Windows 的漫游配置目录（`%APPDATA%`，通常是 `C:\Users\<name>\AppData\Roaming`）。
 *
 * @returns {string} 绝对路径。
 */
function appDataDir() {
  const value = process.env.APPDATA
  if (value && isAbsolute(value)) return value
  return join(homedir(), 'AppData', 'Roaming')
}

/**
 * Windows 的本地应用数据目录（`%LOCALAPPDATA%`）。
 *
 * @returns {string} 绝对路径。
 */
function localAppDataDir() {
  const value = process.env.LOCALAPPDATA
  if (value && isAbsolute(value)) return value
  return join(homedir(), 'AppData', 'Local')
}


/** 预设名列表，供配置校验与文档使用。 */
export const USER_DIR_NAMES = Object.freeze(Object.keys(USER_DIR_PRESETS))

/**
 * 把选中的用户目录预设展开成绝对路径。
 *
 * 未知预设名跳过而不报错：配置写错不该让插件失效。
 *
 * @param {string[]} names - 选中的预设名。
 * @returns {string[]} 绝对路径列表。
 */
export function expandUserDirPresets(names) {
  const out = []
  for (const name of names ?? []) {
    const preset = USER_DIR_PRESETS[name]
    if (!preset) continue
    try {
      out.push(preset.path())
    } catch {
      // homedir() 异常时跳过，不影响其他目录。
    }
  }
  return out
}
