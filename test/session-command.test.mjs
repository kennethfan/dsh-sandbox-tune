/**
 * 会话级命令的单元测试。
 *
 * 覆盖三块：参数解析、状态渲染、命令注册与调用。
 * 这些是前端「按会话改配置」的唯一入口，解析错一个值就会静默写错配置。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMAND_NAME,
  parseCommandInput,
  registerSessionCommand,
  renderStatus,
} from '../lib/session-command.js'

// ---------------------------------------------------------------- 参数解析

test('无参数 → 查看', () => {
  assert.equal(parseCommandInput('').action, 'show')
  assert.equal(parseCommandInput('   ').action, 'show')
  assert.equal(parseCommandInput(undefined).action, 'show')
})

test('reset → 清除', () => {
  assert.equal(parseCommandInput('reset').action, 'reset')
})

test('set mode → 字符串值原样保留', () => {
  const out = parseCommandInput('set mode in-place')
  assert.equal(out.action, 'set')
  assert.equal(out.key, 'mode')
  assert.equal(out.value, 'in-place')
})

test('set cacheRoot 支持含空格的路径', () => {
  const out = parseCommandInput('set cacheRoot /Users/k/Library/Application Support/x')
  assert.equal(out.value, '/Users/k/Library/Application Support/x')
})

test('set presets → 逗号分隔数组', () => {
  const out = parseCommandInput('set presets go,npm,bun')
  assert.deepEqual(out.value, ['go', 'npm', 'bun'])
})

test('set presets 空值 → 空数组', () => {
  const out = parseCommandInput('set presets')
  assert.deepEqual(out.value, [])
})

test('set enabled → 布尔值', () => {
  assert.equal(parseCommandInput('set enabled false').value, false)
  assert.equal(parseCommandInput('set enabled true').value, true)
  // 非 true/false 必须报错，不能猜
  assert.equal(parseCommandInput('set enabled yes').action, 'error')
})

test('set env → KEY=VALUE 映射', () => {
  const out = parseCommandInput('set env A=1,B=2')
  assert.deepEqual(out.value, { A: '1', B: '2' })
  // 格式错必须报错
  assert.equal(parseCommandInput('set env A').action, 'error')
})

test('未知字段报错并列出可选项', () => {
  const out = parseCommandInput('set nope 1')
  assert.equal(out.action, 'error')
  assert.ok(out.reason.includes('mode'), '应列出可用字段')
})

test('未知子命令报错', () => {
  const out = parseCommandInput('delete mode')
  assert.equal(out.action, 'error')
  assert.ok(out.reason.includes('set'))
})

test('set 缺字段名报错', () => {
  assert.equal(parseCommandInput('set').action, 'error')
})

// ---------------------------------------------------------------- 状态渲染

test('renderStatus 标出每个值的来源', () => {
  const config = { mode: 'redirect', cacheRoot: '' }
  const text = renderStatus({ config, overrides: { mode: 'in-place' } })
  assert.ok(text.includes('mode'), '应列出 mode')
  assert.ok(text.includes('← 本会话'), '覆盖项必须标注来源')
  assert.ok(text.includes('（全局）'), '非覆盖项必须标注来源')
})

test('renderStatus 无覆盖时明确说明', () => {
  const text = renderStatus({ config: { mode: 'redirect' }, overrides: {} })
  assert.ok(text.includes('本会话没有覆盖'))
})

test('renderStatus 兼容 volatile 取值器', () => {
  const config = { mode: { get: () => 'in-place' } }
  const text = renderStatus({ config, overrides: {} })
  assert.ok(text.includes('in-place'))
})

// ---------------------------------------------------------------- 命令注册

/** 造一个假 ctx，捕获注册的命令。 */
function fakeCtx() {
  const registered = []
  const commands = { register: (def) => registered.push(def) }
  return {
    registered,
    commands,
    // 插件用 ctx.get('commands') 做可选查询，测试替身必须提供同名能力。
    get: (name) => (name === 'commands' ? commands : undefined),
    logger: { debug() {}, warn() {} },
  }
}

/** 造一个假 agent。 */
function fakeAgent(sessionId = 'sess-1') {
  return { session: { id: sessionId } }
}

test('注册的命令名与描述符合预期', () => {
  const ctx = fakeCtx()
  registerSessionCommand(ctx, { config: {}, store: new Map() })
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].name, COMMAND_NAME)
  assert.ok(ctx.registered[0].description.length > 0)
})

test('没有 commands 服务时不报错，只是跳过', () => {
  const ctx = { get: () => undefined, logger: { debug() {}, warn() {} } }
  // 不应抛错
  registerSessionCommand(ctx, { config: {}, store: new Map() })
})

test('命令 handler：show 返回当前配置', async () => {
  const ctx = fakeCtx()
  const store = new Map()
  registerSessionCommand(ctx, { config: { mode: 'redirect' }, store })
  const result = await ctx.registered[0].handler({ agent: fakeAgent(), rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('mode'))
})

test('命令 handler：set 写入后生效', async () => {
  const ctx = fakeCtx()
  const store = new Map()
  registerSessionCommand(ctx, { config: { mode: 'redirect' }, store })
  const result = await ctx.registered[0].handler({
    agent: fakeAgent('s1'),
    rawInput: 'set mode in-place',
  })
  assert.equal(result.kind, 'success')
  assert.equal(store.get('s1').mode, 'in-place')
})

test('命令 handler：非法值返回 error 且不写入', async () => {
  const ctx = fakeCtx()
  const store = new Map()
  registerSessionCommand(ctx, { config: {}, store })
  const result = await ctx.registered[0].handler({
    agent: fakeAgent('s2'),
    rawInput: 'set mode bad-mode',
  })
  assert.equal(result.kind, 'error')
  assert.equal(store.size, 0, '校验失败不得写入')
})

test('命令 handler：reset 清除覆盖', async () => {
  const ctx = fakeCtx()
  const store = new Map([['s3', { mode: 'in-place' }]])
  registerSessionCommand(ctx, { config: {}, store })
  const result = await ctx.registered[0].handler({ agent: fakeAgent('s3'), rawInput: 'reset' })
  assert.equal(result.kind, 'success')
  assert.equal(store.has('s3'), false)
})

test('命令 handler：命令授权字段被拒绝', async () => {
  const ctx = fakeCtx()
  const store = new Map()
  registerSessionCommand(ctx, { config: {}, store })
  const result = await ctx.registered[0].handler({
    agent: fakeAgent('s4'),
    rawInput: 'set autoApproveMode safe-args',
  })
  assert.equal(result.kind, 'error', '命令授权不支持会话级，必须明确拒绝')
  assert.equal(store.size, 0)
})

test('命令 handler：无会话时返回 error', async () => {
  const ctx = fakeCtx()
  registerSessionCommand(ctx, { config: {}, store: new Map() })
  const result = await ctx.registered[0].handler({ agent: {}, rawInput: '' })
  assert.equal(result.kind, 'error')
})
