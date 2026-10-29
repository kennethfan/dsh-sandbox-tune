/**
 * 配置自监听的单元测试。
 *
 * 重点覆盖：解析容错、只读 volatile 的重建方式、监听去重与失败保留旧配置。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configOfRow, parseScalar, rebuildConfig, watchPatchFile } from '../lib/config-watch.js'

// ---------------------------------------------------------------- 标量解析

test('parseScalar：基本类型', () => {
  assert.equal(parseScalar('redirect'), 'redirect')
  assert.equal(parseScalar('true'), true)
  assert.equal(parseScalar('false'), false)
  assert.equal(parseScalar('null'), null)
  assert.equal(parseScalar('42'), 42)
  assert.equal(parseScalar('3.14'), 3.14)
})

test('parseScalar：引号字符串去掉引号', () => {
  assert.equal(parseScalar("'dsh-sandbox-tune/executor'"), 'dsh-sandbox-tune/executor')
  assert.equal(parseScalar('"/tmp/a b"'), '/tmp/a b')
})

test('parseScalar：行内数组', () => {
  assert.deepEqual(parseScalar('[go, npm, bun]'), ['go', 'npm', 'bun'])
  assert.deepEqual(parseScalar('[]'), [])
})

test('parseScalar：空值返回空字符串', () => {
  assert.equal(parseScalar(''), '')
})

// ---------------------------------------------------------------- config 提取

test('configOfRow：解析出完整 config 段', () => {
  const text = [
    '- id: sandbox-tune-bash',
    '  name: x',
    '  config:',
    '    mode: redirect',
    '    enabled: true',
    '    presets:',
    '      - go',
    '      - npm',
    '    env: {}',
  ].join('\n')
  assert.deepEqual(configOfRow(text, 'sandbox-tune-bash'), {
    mode: 'redirect',
    enabled: true,
    presets: ['go', 'npm'],
    env: {},
  })
})

test('configOfRow：只取目标行，不受相邻行干扰', () => {
  const text = [
    '- id: other',
    '  config:',
    '    a: 1',
    '- id: sandbox-tune-bash',
    '  config:',
    '    mode: in-place',
    '- id: another',
    '  config:',
    '    b: 2',
  ].join('\n')
  assert.deepEqual(configOfRow(text, 'sandbox-tune-bash'), { mode: 'in-place' })
})

test('configOfRow：行存在但没写 config → 空对象', () => {
  assert.deepEqual(configOfRow('- id: sandbox-tune-bash\n  name: x\n', 'sandbox-tune-bash'), {})
})

test('configOfRow：行不存在 → undefined', () => {
  assert.equal(configOfRow('- id: other\n  config:\n    a: 1\n', 'sandbox-tune-bash'), undefined)
})

test('configOfRow：忽略行尾注释', () => {
  const text = [
    '- id: sandbox-tune-bash',
    '  config:',
    '    mode: redirect   # 注释',
    '    cacheRoot: ""    # 空值',
  ].join('\n')
  assert.deepEqual(configOfRow(text, 'sandbox-tune-bash'), { mode: 'redirect', cacheRoot: '' })
})

test('configOfRow：config 里的列表项正确归集', () => {
  const text = [
    '- id: sandbox-tune-bash',
    '  config:',
    '    autoApproveCommands:',
    '      - go build',
    '      - go test',
  ].join('\n')
  assert.deepEqual(configOfRow(text, 'sandbox-tune-bash').autoApproveCommands, ['go build', 'go test'])
})

test('configOfRow：Windows 换行也能处理', () => {
  const text = '- id: x\r\n  config:\r\n    mode: in-place\r\n'
  assert.deepEqual(configOfRow(text, 'x'), { mode: 'in-place' })
})

test('configOfRow：空文本返回 undefined', () => {
  assert.equal(configOfRow('', 'x'), undefined)
})

// ---------------------------------------------------------------- 重建

test('rebuildConfig：合法值重建成功', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const schema = z.object({
    mode: z.string().default('redirect').volatile(),
    enabled: z.boolean().default(true).volatile(),
  })
  const r = rebuildConfig(schema, { mode: 'in-place' })
  assert.equal(r.error, undefined)
  // volatile 字段是 { get } 取值器
  assert.equal(r.config.mode.get(), 'in-place')
  // 未提供的字段走默认值
  assert.equal(r.config.enabled.get(), true)
})

test('rebuildConfig：非法值返回 error，不抛异常', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const schema = z.object({ mode: z.union(['redirect', 'in-place']).default('redirect').volatile() })
  const r = rebuildConfig(schema, { mode: 'bogus' })
  assert.ok(r.error instanceof Error, '非法值应返回 error')
})

test('rebuildConfig：空 config 也能重建（全用默认值）', async () => {
  const z = (await import('@deepseek-ai/schemastery')).default
  const schema = z.object({ mode: z.string().default('redirect').volatile() })
  const r = rebuildConfig(schema, {})
  assert.equal(r.config.mode.get(), 'redirect')
})

// ---------------------------------------------------------------- 监听

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('watchPatchFile：内容变化时触发一次回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgwatch-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, '- id: x\n  config:\n    a: 1\n')

  const seen = []
  const dispose = watchPatchFile({
    file,
    debounceMs: 60,
    onChange: (text) => seen.push(text),
    onError: (e) => { throw e },
  })

  try {
    writeFileSync(file, '- id: x\n  config:\n    a: 2\n')
    await sleep(400)
    assert.equal(seen.length, 1, `应触发一次，实际 ${seen.length}`)
    assert.ok(seen[0].includes('a: 2'))
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchPatchFile：内容未变时不触发（去重）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgwatch-'))
  const file = join(dir, 'cordis.patch.yml')
  const text = '- id: x\n  config:\n    a: 1\n'
  writeFileSync(file, text)

  const seen = []
  const dispose = watchPatchFile({ file, debounceMs: 60, onChange: (t) => seen.push(t) })

  try {
    // 写入完全相同的内容
    writeFileSync(file, text)
    await sleep(350)
    assert.equal(seen.length, 0, '内容没变不该触发')
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchPatchFile：多次快速写入被防抖合并', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgwatch-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, 'v0')

  const seen = []
  const dispose = watchPatchFile({ file, debounceMs: 120, onChange: (t) => seen.push(t) })

  try {
    for (let i = 1; i <= 5; i++) {
      writeFileSync(file, `v${i}`)
      await sleep(15)
    }
    await sleep(500)
    assert.ok(seen.length <= 2, `防抖后不该触发 ${seen.length} 次`)
    assert.ok(seen.length >= 1, '至少要触发一次')
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchPatchFile：回调抛错走 onError，不中断监听', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgwatch-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, 'v0')

  const errors = []
  const dispose = watchPatchFile({
    file,
    debounceMs: 60,
    onChange: () => { throw new Error('boom') },
    onError: (e) => errors.push(e),
  })

  try {
    writeFileSync(file, 'v1')
    await sleep(350)
    assert.equal(errors.length, 1, '错误应交给 onError')
    assert.equal(errors[0].message, 'boom')
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchPatchFile：dispose 后不再触发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfgwatch-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, 'v0')

  const seen = []
  const dispose = watchPatchFile({ file, debounceMs: 60, onChange: (t) => seen.push(t) })
  dispose()

  try {
    writeFileSync(file, 'v1')
    await sleep(350)
    assert.equal(seen.length, 0, 'dispose 后不该再触发')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
