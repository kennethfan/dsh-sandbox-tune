/**
 * 命令授权的跨事件链路测试。
 *
 * 验证：pre-execute 记下命令 → approval/request 用 callId 查回 → 命中规则放行。
 * 这条链路是整件事的核心，任何一环断了都会静默失效（不报错、只是继续弹窗）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CommandApproval } from '../lib/command-approval.js'

/**
 * 造一个最小 ctx：记录注册的监听器，便于手工触发。
 *
 * @returns {object} 带 on/logger 的假上下文与监听器表。
 */
function fakeCtx() {
  const handlers = new Map()
  const logs = []
  return {
    handlers,
    logs,
    on(event, handler) {
      handlers.set(event, handler)
    },
    logger: {
      info: (msg) => logs.push(['info', msg]),
      debug: () => {},
      warn: (msg) => logs.push(['warn', msg]),
    },
  }
}

/** 普通值配置（模拟非 volatile 场景）。 */
function config(overrides = {}) {
  return {
    enabled: true,
    autoApproveMode: 'safe-args',
    autoApproveCommands: ['go build'],
    ...overrides,
  }
}

test('pre-execute 记录 bash 命令，approval 命中规则后放行', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  // 1) 工具调用前，记录命令
  const preExecute = ctx.handlers.get('tools/pre-execute')
  await preExecute(
    { name: 'bash', callId: 'call-1', arguments: { command: 'go build ./...' } },
    async () => ({ kind: 'allow' }),
  )

  // 2) 审批到达，应自动放行
  const onApproval = ctx.handlers.get('approval/request')
  const outcome = await onApproval(
    {
      toolName: 'bash',
      callId: 'call-1',
      reason: 'escalate sandbox to danger-full-access: 构建需写 Go 缓存',
    },
    async () => 'rejected',
  )

  assert.equal(outcome, 'allowed-once')
  assert.equal(approval.granted.length, 1)
  assert.equal(approval.granted[0].command, 'go build ./...')
})

test('规则未命中时交回原链（调用 next）', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  await ctx.handlers.get('tools/pre-execute')(
    { name: 'bash', callId: 'call-2', arguments: { command: 'rm -rf /tmp/x' } },
    async () => ({ kind: 'allow' }),
  )

  let delegated = false
  const outcome = await ctx.handlers.get('approval/request')(
    { toolName: 'bash', callId: 'call-2', reason: 'escalate sandbox to danger-full-access: x' },
    async () => {
      delegated = true
      return 'rejected'
    },
  )

  assert.equal(delegated, true, '未命中必须交回原链')
  assert.equal(outcome, 'rejected')
})

test('命令含 shell 组合时不放行（安全）', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  await ctx.handlers.get('tools/pre-execute')(
    { name: 'bash', callId: 'call-3', arguments: { command: 'go build ./... && rm -rf ~/x' } },
    async () => ({ kind: 'allow' }),
  )

  let delegated = false
  const outcome = await ctx.handlers.get('approval/request')(
    { toolName: 'bash', callId: 'call-3', reason: 'escalate sandbox to danger-full-access: x' },
    async () => {
      delegated = true
      return 'rejected'
    },
  )
  assert.equal(delegated, true)
  assert.equal(outcome, 'rejected')
})

test('非沙箱升权的审批一律不碰', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  await ctx.handlers.get('tools/pre-execute')(
    { name: 'bash', callId: 'call-4', arguments: { command: 'go build ./...' } },
    async () => ({ kind: 'allow' }),
  )

  let delegated = false
  await ctx.handlers.get('approval/request')(
    { toolName: 'bash', callId: 'call-4', reason: 'hook 要求确认：某个无关操作' },
    async () => {
      delegated = true
      return 'rejected'
    },
  )
  assert.equal(delegated, true, '非升权审批必须交回原链')
})

test('找不到对应命令时交回人工', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  let delegated = false
  await ctx.handlers.get('approval/request')(
    { toolName: 'bash', callId: 'unknown-id', reason: 'escalate sandbox to danger-full-access: x' },
    async () => {
      delegated = true
      return 'rejected'
    },
  )
  assert.equal(delegated, true)
})

test('off 模式下即使规则匹配也不放行', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config({ autoApproveMode: 'off' }))
  approval.install()

  await ctx.handlers.get('tools/pre-execute')(
    { name: 'bash', callId: 'call-5', arguments: { command: 'go build ./...' } },
    async () => ({ kind: 'allow' }),
  )

  let delegated = false
  await ctx.handlers.get('approval/request')(
    { toolName: 'bash', callId: 'call-5', reason: 'escalate sandbox to danger-full-access: x' },
    async () => {
      delegated = true
      return 'rejected'
    },
  )
  assert.equal(delegated, true)
})

test('非 bash 工具不记录也不放行', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  await ctx.handlers.get('tools/pre-execute')(
    { name: 'fs_write', callId: 'call-6', arguments: { path: '/tmp/x' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(approval.commands.size, 0)
})

test('自动放行会写日志（审计需要）', async () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  approval.install()

  await ctx.handlers.get('tools/pre-execute')(
    { name: 'bash', callId: 'call-7', arguments: { command: 'go build ./...' } },
    async () => ({ kind: 'allow' }),
  )
  await ctx.handlers.get('approval/request')(
    { toolName: 'bash', callId: 'call-7', reason: 'escalate sandbox to danger-full-access: x' },
    async () => 'rejected',
  )

  const info = ctx.logs.filter(([level]) => level === 'info')
  assert.ok(info.length > 0, '自动放行必须留下日志')
  assert.ok(info.some(([, msg]) => msg.includes('自动批准')))
})

test('命令表有上限，不会无限增长', () => {
  const ctx = fakeCtx()
  const approval = new CommandApproval(ctx, config())
  for (let i = 0; i < 700; i += 1) approval.remember(`id-${i}`, `cmd ${i}`)
  assert.ok(approval.commands.size <= 500, `实际 ${approval.commands.size}`)
})
