/**
 * 会话级配置的集成测试：验证覆盖真的影响执行器行为。
 *
 * 这一组是必要的 —— 单元测试只覆盖了纯函数，而「覆盖能否真的改变
 * resolve() 的产出」必须走真实插件组合才能验证。
 *
 * 特别注意：in-place 依赖后端能力（shared.canExtendRoots），
 * 测试里必须显式模拟，否则会被安全回退成 redirect，
 * 看起来像「覆盖没生效」，实际是回退逻辑在正确工作。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import subprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import sessionProjection from '@deepseek-ai/dsh-session-projection'
import sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'

import { CacheSandboxExecutor } from '../lib/executor.js'
import { CacheSandboxProvider } from '../lib/provider.js'
import { writeOverrides } from '../lib/session-config.js'
import { resetShared, shared } from '../lib/shared.js'

/**
 * 挂载一套插件组合。
 *
 * @param {object} executorConfig - 执行器配置。
 * @returns {Promise<object>} 上下文。
 */
async function mount(executorConfig) {
  resetShared()
  const ctx = new Context()
  await ctx.plugin(subprocessLocal)
  await ctx.plugin(sessionProjection)
  await ctx.plugin(CacheSandboxProvider, {
    enabled: true,
    autoDetect: false,
    presets: [],
    sandboxRoots: [],
    userDirs: [],
  })
  await ctx.plugin(sandboxPolicy, { mode: 'workspace-write', workspaceRoot: process.cwd() })
  await ctx.plugin(shellEnv)
  await ctx.plugin(CacheSandboxExecutor, {
    presets: ['go'],
    env: {},
    timeoutMs: 60000,
    autoApproveMode: 'off',
    autoApproveCommands: [],
    ...executorConfig,
  })
  return ctx
}

/** 造一个 resolve 请求，带上会话 id。 */
function req(sessionId, command = 'go build ./...') {
  return {
    command,
    sandboxPolicy: {
      mode: 'workspace-write',
      workspaceRoot: process.cwd(),
      ...(sessionId === undefined ? {} : { sessionId }),
    },
  }
}

test('会话覆盖 in-place 后不注入缓存变量，其他会话仍走全局 redirect', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  // 模拟后端能力：真实环境由 provider 的 confine() 设置。
  shared.canExtendRoots = true
  const shell = ctx.get('shell')

  writeOverrides({ id: 'sess-a' }, { mode: 'in-place' }, shared.sessionOverrides)

  const a = shell.resolve(req('sess-a'))
  const b = shell.resolve(req('sess-b'))

  assert.equal(a.env?.GOCACHE, undefined, '会话 A 覆盖 in-place，不应注入 GOCACHE')
  assert.ok(b.env?.GOCACHE, '会话 B 无覆盖，应走全局 redirect 并注入 GOCACHE')
})

test('会话覆盖 cacheRoot 后使用该路径', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  const shell = ctx.get('shell')

  writeOverrides({ id: 'sess-c' }, { cacheRoot: '/custom/cache' }, shared.sessionOverrides)

  const spec = shell.resolve(req('sess-c'))
  assert.equal(spec.env?.GOCACHE, '/custom/cache/go-build', '应使用会话指定的 cacheRoot')
})

test('会话覆盖 enabled=false 时完全不处理', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  const shell = ctx.get('shell')

  writeOverrides({ id: 'sess-d' }, { enabled: false }, shared.sessionOverrides)

  const spec = shell.resolve(req('sess-d'))
  assert.equal(spec.env?.GOCACHE, undefined, '会话关闭后不应注入')
})

test('会话覆盖 presets 是叠加：全局项保留，会话项追加', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect', presets: ['go'] })
  const shell = ctx.get('shell')

  // 全局有 go，会话加 npm
  writeOverrides({ id: 'sess-e' }, { presets: ['npm'] }, shared.sessionOverrides)

  const spec = shell.resolve(req('sess-e'))
  assert.ok(spec.env?.GOCACHE, '全局的 go 应保留（叠加语义）')
  assert.ok(spec.env?.NPM_CONFIG_CACHE, '会话追加的 npm 应生效')
})

test('叠加语义的固有限制：会话无法移除全局项', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect', presets: ['go', 'npm'] })
  const shell = ctx.get('shell')

  // 会话只写 ['go']，期望「移除 npm」—— 但叠加语义做不到，
  // npm 仍来自全局。这是选择叠加时接受的取舍，写在这里避免误解。
  writeOverrides({ id: 'sess-f2' }, { presets: ['go'] }, shared.sessionOverrides)

  const spec = shell.resolve(req('sess-f2'))
  assert.ok(spec.env?.NPM_CONFIG_CACHE, '全局 npm 仍在 —— 叠加无法移除，只能去全局改')
})

test('要移除全局项只能改全局配置', async () => {
  // 全局只留 go，会话不覆盖
  const ctx = await mount({ enabled: true, mode: 'redirect', presets: ['go'] })
  const shell = ctx.get('shell')

  const spec = shell.resolve(req('sess-g'))
  assert.ok(spec.env?.GOCACHE, 'go 生效')
  assert.equal(spec.env?.NPM_CONFIG_CACHE, undefined, '全局没有 npm，就不注入')
})

test('无 sessionId 时退化为全局配置（不崩）', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  const shell = ctx.get('shell')

  const spec = shell.resolve(req(undefined))
  assert.ok(spec.env?.GOCACHE, '无会话时应走全局配置')
})

test('in-place 覆盖但后端不支持时安全回退 redirect', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  // 关键：不设置 canExtendRoots（默认 false），模拟 Landlock / Windows ACL
  shared.canExtendRoots = false
  const shell = ctx.get('shell')

  writeOverrides({ id: 'sess-f' }, { mode: 'in-place' }, shared.sessionOverrides)

  const spec = shell.resolve(req('sess-f'))
  assert.ok(
    spec.env?.GOCACHE,
    '后端不支持 in-place 时必须回退 redirect 并注入缓存，绝不能既不授权也不注入',
  )
})

test('两个会话的覆盖互不影响', async () => {
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  shared.canExtendRoots = true
  const shell = ctx.get('shell')

  writeOverrides({ id: 'x' }, { mode: 'in-place' }, shared.sessionOverrides)
  writeOverrides({ id: 'y' }, { mode: 'redirect', cacheRoot: '/y' }, shared.sessionOverrides)

  assert.equal(shell.resolve(req('x')).env?.GOCACHE, undefined, 'x 是 in-place')
  assert.equal(shell.resolve(req('y')).env?.GOCACHE, '/y/go-build', 'y 用自己的 cacheRoot')
})
