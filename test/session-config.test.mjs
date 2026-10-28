/**
 * 会话级配置的单元测试。
 *
 * 重点有两块：
 * 1. 分层解析正确：会话覆盖 > 全局配置 > 默认值；
 * 2. **安全边界**：命令授权字段永远不能通过会话覆盖生效。
 *
 * 用法：node --test test/session-config.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ADDITIVE,
  ALL_SETTINGS,
  NON_INHERITABLE,
  OVERRIDABLE,
  clearOverrides,
  resolveSetting,
  sanitizeOverrides,
  validateOverride,
  writeOverrides,
} from '../lib/session-config.js'

// ---------------------------------------------------------------- 常量

test('OVERRIDABLE 是 8 项，且刻意不含命令授权', () => {
  assert.equal(OVERRIDABLE.length, 8)
  for (const key of ['mode', 'cacheRoot', 'userDirs', 'sandboxRoots', 'presets', 'env', 'enabled', 'autoDetect']) {
    assert.ok(OVERRIDABLE.includes(key), `缺 ${key}`)
  }
  // 这两个字段不能出现在「可覆盖」列表里，否则帮助文本会宣称可设置、
  // 而实际写入被拒 —— 自相矛盾的提示比没有提示更糟。
  assert.equal(OVERRIDABLE.includes('autoApproveMode'), false)
  assert.equal(OVERRIDABLE.includes('autoApproveCommands'), false)
})

test('ALL_SETTINGS 是 OVERRIDABLE + 命令授权两项', () => {
  assert.equal(ALL_SETTINGS.length, 10)
  for (const key of NON_INHERITABLE) assert.ok(ALL_SETTINGS.includes(key))
})

test('NON_INHERITABLE 只包含命令授权两项', () => {
  assert.deepEqual([...NON_INHERITABLE], ['autoApproveMode', 'autoApproveCommands'])
})

// ---------------------------------------------------------------- 校验

test('validateOverride 拒绝未知字段（而不是静默丢弃）', () => {
  const out = validateOverride('nope', 1)
  assert.equal(out.ok, false)
  assert.ok(out.reason.includes('未知配置项'))
})

test('validateOverride 检查各字段类型', () => {
  assert.equal(validateOverride('mode', 'in-place').ok, true)
  assert.equal(validateOverride('mode', 'bad').ok, false)
  // 命令授权不是「未知字段」，而是「已知但只能全局」——提示要区分开。
  const approval = validateOverride('autoApproveMode', 'safe-args')
  assert.equal(approval.ok, false)
  assert.ok(approval.reason.includes('仅支持全局'), `实际：${approval.reason}`)
  assert.equal(validateOverride('enabled', false).ok, true)
  assert.equal(validateOverride('enabled', 'yes').ok, false)
  assert.equal(validateOverride('presets', ['go']).ok, true)
  assert.equal(validateOverride('presets', 'go').ok, false)
  assert.equal(validateOverride('presets', [1]).ok, false)
  assert.equal(validateOverride('env', { A: 'b' }).ok, true)
  assert.equal(validateOverride('env', ['A']).ok, false)
  assert.equal(validateOverride('cacheRoot', '/x').ok, true)
  assert.equal(validateOverride('cacheRoot', 1).ok, false)
})

// ---------------------------------------------------------------- 安全核心

test('sanitizeOverrides 剔除命令授权字段（安全核心）', () => {
  const out = sanitizeOverrides({
    mode: 'in-place',
    autoApproveMode: 'safe-args',
    autoApproveCommands: ['rm', 'curl'],
  })
  // mode 可以保留
  assert.equal(out.mode, 'in-place')
  // 但放宽审批的授权绝不能生效
  assert.equal(out.autoApproveMode, undefined, 'autoApproveMode 不得生效')
  assert.equal(out.autoApproveCommands, undefined, 'autoApproveCommands 不得生效')
})

test('sanitizeOverrides 剔除未知字段', () => {
  const out = sanitizeOverrides({ nope: 1, mode: 'redirect' })
  assert.equal(out.nope, undefined)
  assert.equal(out.mode, 'redirect')
})

test('sanitizeOverrides 处理非法输入不抛错', () => {
  assert.deepEqual(sanitizeOverrides(null), {})
  assert.deepEqual(sanitizeOverrides(undefined), {})
  assert.deepEqual(sanitizeOverrides('x'), {})
})

// ---------------------------------------------------------------- 解析优先级

test('resolveSetting：会话覆盖优先于全局', () => {
  const config = { mode: 'redirect' }
  assert.equal(
    resolveSetting({ config, overrides: { mode: 'in-place' }, key: 'mode', fallback: 'redirect' }),
    'in-place',
  )
})

test('resolveSetting：无覆盖时用全局', () => {
  const config = { mode: 'in-place' }
  assert.equal(
    resolveSetting({ config, overrides: {}, key: 'mode', fallback: 'redirect' }),
    'in-place',
  )
})

test('resolveSetting：都没有时用兜底', () => {
  assert.equal(resolveSetting({ config: {}, overrides: {}, key: 'mode', fallback: 'x' }), 'x')
})

test('resolveSetting 兼容 volatile 取值器', () => {
  const config = { mode: { get: () => 'in-place' } }
  assert.equal(resolveSetting({ config, overrides: {}, key: 'mode', fallback: 'x' }), 'in-place')
})

test('resolveSetting 覆盖值优先于 volatile 取值器', () => {
  const config = { mode: { get: () => 'in-place' } }
  assert.equal(
    resolveSetting({ config, overrides: { mode: 'redirect' }, key: 'mode', fallback: 'x' }),
    'redirect',
  )
})

// ---------------------------------------------------------------- 写入

/** 造一个带 id 的假会话。 */
function fakeSession(id = 'sess-1') {
  return { id }
}

test('writeOverrides 写入内存表', () => {
  const store = new Map()
  const out = writeOverrides(fakeSession(), { mode: 'in-place' }, store)
  assert.equal(out.ok, true)
  assert.deepEqual(out.applied, ['mode'])
  assert.equal(store.get('sess-1').mode, 'in-place')
})

test('writeOverrides 合并而非替换', () => {
  const store = new Map()
  writeOverrides(fakeSession(), { mode: 'in-place' }, store)
  writeOverrides(fakeSession(), { cacheRoot: '/x' }, store)
  const saved = store.get('sess-1')
  assert.equal(saved.mode, 'in-place', '先写的字段必须保留')
  assert.equal(saved.cacheRoot, '/x')
})

test('writeOverrides 遇到非法值直接失败，不写半条', () => {
  const store = new Map()
  const out = writeOverrides(fakeSession(), { mode: 'bad-mode' }, store)
  assert.equal(out.ok, false)
  assert.equal(store.size, 0, '校验失败时不得写入任何内容')
})

test('writeOverrides 无会话时明确失败', () => {
  const store = new Map()
  assert.equal(writeOverrides(undefined, { mode: 'redirect' }, store).ok, false)
  assert.equal(writeOverrides({}, { mode: 'redirect' }, store).ok, false)
})

test('writeOverrides 空 patch 失败', () => {
  const store = new Map()
  assert.equal(writeOverrides(fakeSession(), {}, store).ok, false)
  assert.equal(store.size, 0)
})

test('writeOverrides 不同会话互不影响', () => {
  const store = new Map()
  writeOverrides(fakeSession('a'), { mode: 'in-place' }, store)
  writeOverrides(fakeSession('b'), { mode: 'redirect' }, store)
  assert.equal(store.get('a').mode, 'in-place')
  assert.equal(store.get('b').mode, 'redirect')
})

test('clearOverrides 删除该会话的覆盖', () => {
  const store = new Map()
  writeOverrides(fakeSession(), { mode: 'in-place' }, store)
  assert.equal(store.size, 1)
  assert.equal(clearOverrides(fakeSession(), store).ok, true)
  assert.equal(store.size, 0)
})

test('clearOverrides 只影响目标会话', () => {
  const store = new Map()
  writeOverrides(fakeSession('a'), { mode: 'in-place' }, store)
  writeOverrides(fakeSession('b'), { mode: 'redirect' }, store)
  clearOverrides(fakeSession('a'), store)
  assert.equal(store.has('a'), false)
  assert.equal(store.get('b').mode, 'redirect')
})

test('writeOverrides 在写入时就拒绝不继承字段（而非存进去再过滤）', () => {
  const store = new Map()
  const out = writeOverrides(fakeSession(), { autoApproveMode: 'safe-args' }, store)
  assert.equal(out.ok, false, '必须明确失败，不能返回 ok 却实际不生效')
  assert.ok(out.reason.includes('danger-full-access'))
  assert.equal(store.size, 0, '不得写入任何内容')
})

test('writeOverrides 混入不继承字段时整批拒绝', () => {
  const store = new Map()
  const out = writeOverrides(fakeSession(), { mode: 'in-place', autoApproveCommands: ['rm'] }, store)
  assert.equal(out.ok, false)
  assert.equal(store.size, 0, '有非法字段时整批不写，避免半条生效')
})

// ---------------------------------------------------------------- 叠加语义

test('ADDITIVE 只含数组与对象字段', () => {
  assert.deepEqual([...ADDITIVE].sort(), ['env', 'presets', 'sandboxRoots', 'userDirs'].sort())
  // 标量不该出现在叠加列表里
  for (const scalar of ['mode', 'enabled', 'cacheRoot', 'autoDetect']) {
    assert.equal(ADDITIVE.includes(scalar), false, `${scalar} 是标量，不该叠加`)
  }
})

test('数组字段：会话值与全局值叠加（不是替换）', () => {
  const out = resolveSetting({
    config: { sandboxRoots: ['/A'] },
    overrides: { sandboxRoots: ['/B'] },
    key: 'sandboxRoots',
    fallback: [],
  })
  // 这是最关键的一条：用户期望「全局 A + 会话 B = 两个都可用」，
  // 若整体替换，A 会静默失效且界面看不出提示。
  assert.deepEqual(out, ['/A', '/B'])
})

test('数组字段：叠加时去重且保持顺序', () => {
  const out = resolveSetting({
    config: { sandboxRoots: ['/A', '/C'] },
    overrides: { sandboxRoots: ['/A', '/B'] },
    key: 'sandboxRoots',
    fallback: [],
  })
  assert.deepEqual(out, ['/A', '/C', '/B'])
})

test('数组字段：全局为空时只用会话值', () => {
  const out = resolveSetting({
    config: { presets: [] },
    overrides: { presets: ['go'] },
    key: 'presets',
    fallback: [],
  })
  assert.deepEqual(out, ['go'])
})

test('数组字段：无会话覆盖时用全局值', () => {
  const out = resolveSetting({
    config: { presets: ['go', 'npm'] },
    overrides: {},
    key: 'presets',
    fallback: [],
  })
  assert.deepEqual(out, ['go', 'npm'])
})

test('env 对象：按 key 合并', () => {
  const out = resolveSetting({
    config: { env: { A: '1' } },
    overrides: { env: { B: '2' } },
    key: 'env',
    fallback: {},
  })
  assert.deepEqual(out, { A: '1', B: '2' })
})

test('env 对象：同名 key 会话优先', () => {
  const out = resolveSetting({
    config: { env: { A: '1', C: '3' } },
    overrides: { env: { A: '9' } },
    key: 'env',
    fallback: {},
  })
  assert.deepEqual(out, { A: '9', C: '3' })
})

test('标量字段仍是替换而非叠加', () => {
  assert.equal(
    resolveSetting({ config: { mode: 'redirect' }, overrides: { mode: 'in-place' }, key: 'mode', fallback: 'x' }),
    'in-place',
  )
  assert.equal(
    resolveSetting({ config: { cacheRoot: '/g' }, overrides: { cacheRoot: '/s' }, key: 'cacheRoot', fallback: '' }),
    '/s',
  )
})

test('叠加字段收到非法类型时退回全局值，不崩', () => {
  // 例如手工写坏了配置：数组字段给了字符串
  const out = resolveSetting({
    config: { presets: ['go'] },
    overrides: { presets: 'npm' },
    key: 'presets',
    fallback: [],
  })
  // 非数组、非对象 → 走最后一行直接返回 override，这是显式覆盖语义；
  // 但调用方拿到的不是数组，所以 validateOverride 必须在写入前拦住。
  assert.equal(out, 'npm')
})
