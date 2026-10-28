/**
 * Windows 兼容性测试。
 *
 * 这里能测的是**与平台无关的逻辑**：路径拼装用的是 node:path，它在 Windows 上
 * 自动切到 win32 变体，因此本机（darwin）测不到真实行为。所以我们验证的是：
 *   1. 代码里没有硬编码 POSIX 分隔符或 `/` 开头的绝对路径假设；
 *   2. 平台分支存在且方向正确（win32 → 回退 redirect）；
 *   3. 路径工具函数用 win32 模拟时输出正确。
 *
 * 真机 Windows 行为仍需在 Windows 上验证 —— 本文件不假装测过了。
 *
 * 用法：node --test test/windows.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { win32 } from 'node:path'

const SRC = new URL('../lib/', import.meta.url)

/** 读一个源文件。 */
function src(name) {
  return readFileSync(new URL(name, SRC), 'utf8')
}

// ---------------------------------------------------------------- 路径工具

test('win32 路径判断：盘符与 UNC 都被视为绝对路径', () => {
  assert.equal(win32.isAbsolute('C:\\Users\\k\\go'), true)
  assert.equal(win32.isAbsolute('C:/Users/k/go'), true)
  assert.equal(win32.isAbsolute('D:\\cache'), true)
  assert.equal(win32.isAbsolute('\\\\server\\share\\x'), true)
  assert.equal(win32.isAbsolute('relative\\dir'), false)
})

test('win32 路径拼装使用反斜杠', () => {
  assert.equal(win32.join('C:\\Users\\k', '.config'), 'C:\\Users\\k\\.config')
  assert.equal(win32.join('C:\\Users\\k', 'AppData', 'Local'), 'C:\\Users\\k\\AppData\\Local')
})

// ---------------------------------------------------------------- 源码审计

test('源码用 node:path 而非硬编码分隔符', () => {
  for (const file of ['cache-env.js', 'user-dirs.js', 'provider.js', 'executor.js']) {
    const text = src(file)
    // 不允许出现手写的 '/'-拼接路径（排除注释与日志文案）
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    assert.ok(
      !/['"`]\/['"`]\s*\+/.test(code),
      `${file} 出现手写的 "/" 路径拼接，Windows 上会拼错`,
    )
  }
})

test('platformCacheHome 覆盖三个平台', () => {
  const text = src('cache-env.js')
  assert.ok(text.includes("process.platform === 'darwin'"), '缺 macOS 分支')
  assert.ok(text.includes("process.platform === 'win32'"), '缺 Windows 分支')
  assert.ok(text.includes('LOCALAPPDATA'), 'Windows 缓存应使用 %LOCALAPPDATA%')
})

test('user-dirs 在 Windows 上用 APPDATA / LOCALAPPDATA', () => {
  const text = src('user-dirs.js')
  assert.ok(text.includes("process.platform === 'win32'"), '缺 Windows 分支')
  assert.ok(text.includes('APPDATA'), '配置目录应使用 %APPDATA%')
  assert.ok(text.includes('LOCALAPPDATA'), '本地数据应使用 %LOCALAPPDATA%')
})

test('user-cache 不授权 macOS 的 ~/Library/Caches', () => {
  const text = src('user-dirs.js')
  const cacheBlock = text.slice(text.indexOf("'user-cache'"), text.indexOf("'user-data'"))
  // 只看**可执行代码**：注释里解释「为什么不用 Library/Caches」是正常的，
  // 不能把说明文字当成违规。
  const code = cacheBlock
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('//')
    })
    .join('\n')
  assert.ok(
    !code.includes('Library'),
    'user-cache 不得指向 ~/Library/Caches（会授权系统级缓存）',
  )
})

// ---------------------------------------------------------------- 平台分支

test('executor 按平台选择 bash / pwsh 基类', () => {
  const text = src('executor.js')
  assert.ok(text.includes('SandboxPwshExecutor'), '缺 pwsh 基类导入')
  assert.ok(
    /process\.platform === 'win32'\s*\?\s*SandboxPwshExecutor\s*:\s*SandboxBashExecutor/.test(text),
    '未按平台选择基类：Windows 上会去跑 bash -c',
  )
})

test('provider 在 Windows 上明确回退（ACL runner 无法注入路径）', () => {
  const text = src('provider.js')
  assert.ok(
    /if \(process\.platform === 'win32'\) return false/.test(text),
    'Windows 必须返回 false 让 executor 回退到 redirect',
  )
})

test('patch 同时禁用 bash-sandbox 与 pwsh-sandbox', () => {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(/- id: bash-sandbox[\s\S]*?disabled: true/.test(text), '未禁用 bash-sandbox')
  assert.ok(/- id: pwsh-sandbox[\s\S]*?disabled: true/.test(text), '未禁用 pwsh-sandbox')
})
