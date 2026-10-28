/**
 * 单元测试：缓存路径探测、重定向表构造、沙箱 profile 拼接、runner 识别。
 *
 * 这些都是纯函数或纯字符串处理，不需要真实沙箱即可验证。
 * 真机端到端（在真实沙箱里跑 go build）只能在普通终端测 —— 见 README。
 *
 * 用法：node --test test/unit.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CACHE_PRESETS,
  MODES,
  buildCacheEnv,
  defaultCacheRoot,
  detectCachePaths,
  expandHome,
  guessPresetsFor,
  resolveCacheRoot,
} from '../lib/cache-env.js'
import { CacheSandboxProvider, runnerKindOf } from '../lib/provider.js'
import { pickPaths, resetShared, shared } from '../lib/shared.js'

// ---------------------------------------------------------------- 基础工具

test('defaultCacheRoot 落在临时目录下', () => {
  assert.ok(defaultCacheRoot().endsWith('/dsh'))
  assert.ok(defaultCacheRoot().startsWith(process.env.TMPDIR ?? '/var/folders'))
})

test('MODES 只有两个值', () => {
  assert.deepEqual([...MODES], ['redirect', 'in-place'])
})

test('resolveCacheRoot：空值走默认', () => {
  assert.equal(resolveCacheRoot('', '/base'), defaultCacheRoot())
  assert.equal(resolveCacheRoot(undefined, '/base'), defaultCacheRoot())
  assert.equal(resolveCacheRoot('   ', '/base'), defaultCacheRoot())
})

test('resolveCacheRoot：相对路径按 base 解析而非 cwd', () => {
  assert.equal(resolveCacheRoot('.cache', '/base'), '/base/.cache')
})

test('resolveCacheRoot：~ 会被展开（否则会建出名为 ~ 的目录）', () => {
  const home = process.env.HOME
  assert.equal(resolveCacheRoot('~/x', '/base'), `${home}/x`)
  assert.equal(expandHome('~'), home)
})

// ---------------------------------------------------------------- 预设表

test('预设表结构自洽：每条都有 kind / subdir / fallback', () => {
  for (const [name, preset] of Object.entries(CACHE_PRESETS)) {
    assert.ok(preset.entries.length > 0, `${name} 没有任何条目`)
    for (const entry of preset.entries) {
      assert.ok(['cache', 'store'].includes(entry.kind), `${name}/${entry.env} kind 非法`)
      assert.equal(typeof entry.subdir, 'string')
      assert.equal(typeof entry.fallback, 'function')
    }
  }
})

test('go 的 GOCACHE 是 cache，GOMODCACHE 是 store', () => {
  const byEnv = Object.fromEntries(CACHE_PRESETS.go.entries.map((e) => [e.env, e.kind]))
  assert.equal(byEnv.GOCACHE, 'cache')
  assert.equal(byEnv.GOMODCACHE, 'store')
})

// ---------------------------------------------------------------- 重定向表

test('buildCacheEnv 只重定向纯缓存，绝不重定向依赖仓库', () => {
  const { env, dirs } = buildCacheEnv({ cacheRoot: '/c', presets: ['go'] })
  assert.equal(env.GOCACHE, '/c/go-build')
  // GOMODCACHE 是依赖仓库：指到空目录会让 go build 直接找不到模块。
  assert.equal(env.GOMODCACHE, undefined)
  assert.deepEqual(dirs, ['/c/go-build'])
})

test('buildCacheEnv：cargo 只有 store，因此什么都不注入', () => {
  const { env, dirs } = buildCacheEnv({ cacheRoot: '/c', presets: ['cargo'] })
  assert.equal(env.CARGO_HOME, undefined)
  assert.deepEqual(dirs, [])
})

test('buildCacheEnv：已显式设置的变量不被覆盖', () => {
  const { env } = buildCacheEnv({
    cacheRoot: '/c',
    presets: ['go'],
    lookup: (name) => (name === 'GOCACHE' ? '/user/set' : undefined),
  })
  assert.equal(env.GOCACHE, undefined)
})

test('buildCacheEnv：extraEnv 优先级最高', () => {
  const { env } = buildCacheEnv({
    cacheRoot: '/c',
    presets: ['go'],
    extraEnv: { GOCACHE: '/override' },
  })
  assert.equal(env.GOCACHE, '/override')
})

test('buildCacheEnv：未知预设被跳过而不抛错', () => {
  const { env } = buildCacheEnv({ cacheRoot: '/c', presets: ['nope', 'go'] })
  assert.equal(env.GOCACHE, '/c/go-build')
})

// ---------------------------------------------------------------- 路径探测

test('detectCachePaths：环境变量优先于探测', async () => {
  const saved = process.env.GOCACHE
  process.env.GOCACHE = '/from/env'
  try {
    const out = await detectCachePaths({
      presets: ['go'],
      run: async () => '/from/probe',
    })
    const entry = out.find((e) => e.env === 'GOCACHE')
    assert.equal(entry.path, '/from/env')
    assert.equal(entry.source, 'env')
  } finally {
    if (saved === undefined) delete process.env.GOCACHE
    else process.env.GOCACHE = saved
  }
})

/**
 * 在「清掉相关环境变量」的前提下跑一段逻辑。
 *
 * 探测逻辑优先采用环境变量（这是正确行为），所以测试必须自己隔离环境：
 * 否则宿主上若恰好设了 GOCACHE（比如本会话验证时留下的），测试结果会随
 * 环境漂移 —— 那是测试的缺陷，不是被测代码的缺陷。
 *
 * @param {string[]} names - 要临时删除的环境变量名。
 * @param {() => Promise<void>} body - 测试主体。
 * @returns {Promise<void>}
 */
async function withoutEnv(names, body) {
  const saved = new Map()
  for (const name of names) {
    saved.set(name, process.env[name])
    delete process.env[name]
  }
  try {
    await body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('detectCachePaths：单条探测失败回落静态默认值，不影响其他条目', async () => {
  await withoutEnv(['GOCACHE', 'GOMODCACHE'], async () => {
    const out = await detectCachePaths({
      presets: ['go'],
      run: async (cmd, args) => {
        if (args.includes('GOMODCACHE')) throw new Error('boom')
        return '/probe/gocache\n'
      },
    })
    const gocache = out.find((e) => e.env === 'GOCACHE')
    const gomod = out.find((e) => e.env === 'GOMODCACHE')
    assert.equal(gocache.path, '/probe/gocache')
    assert.equal(gocache.source, 'probe')
    // GOMODCACHE 探测失败 → fallback，且必须是绝对路径
    assert.equal(gomod.source, 'fallback')
    assert.ok(gomod.path.startsWith('/'))
  })
})

test('detectCachePaths：探测返回相对路径时拒绝采用', async () => {
  await withoutEnv(['GOCACHE'], async () => {
    const out = await detectCachePaths({
      presets: ['go'],
      run: async () => 'relative/path\n',
    })
    const gocache = out.find((e) => e.env === 'GOCACHE')
    // 相对路径没有稳定含义，必须回落而不是照用。
    assert.equal(gocache.source, 'fallback')
  })
})

// ---------------------------------------------------------------- runner 识别

test('runnerKindOf 识别 seatbelt 与 bwrap', () => {
  assert.equal(runnerKindOf(['sandbox-exec', '-p', 'P', '--', 'bash']), 'seatbelt')
  assert.equal(runnerKindOf(['bwrap', '--ro-bind', '/', '/', '--', 'bash']), 'bwrap')
  assert.equal(runnerKindOf(['/path/to/landlock-launch', 'x']), 'unsupported')
  // 缺 -p 或 profile 的 sandbox-exec 不算 seatbelt（形状不符就不能瞎拼）
  assert.equal(runnerKindOf(['sandbox-exec', 'bash']), 'unsupported')
})

// ---------------------------------------------------------------- profile 拼接

/** 构造一个不启动沙箱的 provider，仅用于测试 patchArgv 的字符串拼接。 */
function makeProvider(roots) {
  const instance = Object.create(CacheSandboxProvider.prototype)
  instance.ctx = { logger: { info() {}, warn() {} } }
  instance.extraRoots = [...roots]
  instance.rootsConfigured = true
  instance.pendingRoots = []
  return instance
}

test('patchArgv：Seatbelt 追加 allow file-write* 规则', () => {
  const provider = makeProvider(['/mod'])
  const argv = ['sandbox-exec', '-p', '(version 1) (deny file-write*)', '--', 'bash', '-c', 'x']
  const out = provider.patchArgv(argv, ['/mod'])
  assert.equal(out[0], 'sandbox-exec')
  assert.equal(out[1], '-p')
  assert.ok(out[2].includes('(allow file-write* (subpath "/mod"))'))
  assert.deepEqual(out.slice(3), ['--', 'bash', '-c', 'x'])
})

test('patchArgv：Seatbelt 转义引号与反斜杠', () => {
  const provider = makeProvider(['/a"b\\c'])
  const out = provider.patchArgv(['sandbox-exec', '-p', 'P', '--', 'x'], ['/a"b\\c'])
  assert.ok(out[2].includes('(subpath "/a\\"b\\\\c")'))
})

test('patchArgv：bwrap 在 -- 之前插入 --bind', () => {
  const provider = makeProvider(['/mod'])
  const argv = ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', 'x']
  const out = provider.patchArgv(argv, ['/mod'])
  assert.deepEqual(out, [
    'bwrap', '--ro-bind', '/', '/', '--bind', '/mod', '/mod', '--', 'bash', '-c', 'x',
  ])
})

test('patchArgv：多个根目录各自授权', () => {
  const provider = makeProvider(['/a', '/b'])
  const out = provider.patchArgv(['sandbox-exec', '-p', 'P', '--', 'x'], ['/a', '/b'])
  assert.ok(out[2].includes('(subpath "/a")'))
  assert.ok(out[2].includes('(subpath "/b")'))
})

test('patchArgv：未知 runner 返回 undefined（不静默假装成功）', () => {
  const provider = makeProvider(['/mod'])
  assert.equal(provider.patchArgv(['/some/landlock-launcher', 'x'], ['/mod']), undefined)
})

test('extraWritableRoots：未配置时返回空数组', () => {
  const provider = makeProvider([])
  assert.deepEqual(provider.extraWritableRoots(), [])
})

// ---------------------------------------------------------------- 共享状态

test('pickPaths 按 kind 过滤并去重', () => {
  const paths = [
    { path: '/a', kind: 'cache' },
    { path: '/b', kind: 'store' },
    { path: '/a', kind: 'cache' },
  ]
  assert.deepEqual(pickPaths(paths, 'cache'), ['/a'])
  assert.deepEqual(pickPaths(paths, 'all'), ['/a', '/b'])
})

test('resetShared 清空所有字段', () => {
  shared.paths = [{ path: '/x' }]
  shared.detected = true
  shared.canExtendRoots = true
  shared.grantedRoots = ['/x']
  resetShared()
  assert.deepEqual(shared.paths, [])
  assert.equal(shared.detected, false)
  assert.equal(shared.canExtendRoots, false)
  assert.deepEqual(shared.grantedRoots, [])
})

test('guessPresetsFor 识别常见命令', () => {
  assert.deepEqual(guessPresetsFor('go build ./...'), ['go'])
  assert.deepEqual(guessPresetsFor('cd x && go test ./...'), ['go'])
  assert.deepEqual(guessPresetsFor('npm install'), ['npm'])
  assert.deepEqual(guessPresetsFor('echo hi'), [])
  // 不应把 gofmt 误判成 go 子命令
  assert.deepEqual(guessPresetsFor('gofmt -l .'), [])
})

// ---------------------------------------------------------------- 回归：授权链路

/**
 * 回归测试：`confine()` 必须真正把探测到的目录写进 argv。
 *
 * 真实 bug：早先版本把 prepare 与读取拆成两步，而 confine 从未调用 prepare，
 * 于是 extraRoots 永远是空的，原地授权静默失效。当时的单元测试只覆盖了
 * patchArgv（纯字符串拼接），没走调用链，所以漏掉了。
 *
 * 这里用一个替身父类（覆盖 confine）来隔离 cordis，但**走真实的 confine 方法**，
 * 确保 prepare → patchArgv 这条链路被真正执行。
 */
function makeConfineStub(instance, argv) {
  // 只把「父类的 confine」换掉，其余方法（patchArgv / prepare 等）
  // 仍走真实的 CacheSandboxProvider.prototype —— 否则测的就不是被测代码了。
  instance.superConfine = async () => ({
    argv,
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  })
}

test('confine：自动探测到的路径必须真正进入 argv（回归）', async () => {
  const { CacheSandboxProvider: P } = await import('../lib/provider.js')
  const { shared: st, resetShared: reset } = await import('../lib/shared.js')

  reset()
  st.paths = [
    { preset: 'go', env: 'GOCACHE', kind: 'cache', path: '/probe/go-build' },
    { preset: 'go', env: 'GOMODCACHE', kind: 'store', path: '/probe/go-mod' },
  ]
  st.detected = true

  const instance = Object.create(P.prototype)
  instance.ctx = { logger: { info() {}, warn() {} } }
  instance.extraRoots = []
  instance.rootsConfigured = true
  instance.pluginConfig = { autoDetect: true, presets: ['go'], sandboxRoots: [] }

  const baseArgv = ['sandbox-exec', '-p', '(deny file-write*)', '--', 'bash', '-c', 'go build']
  makeConfineStub(instance, baseArgv)

  // 走真实 confine，而不是手工调 prepare + patchArgv。
  const confined = await instance.confine(baseArgv, { mode: 'workspace-write' })

  assert.ok(
    confined.argv[2].includes('(subpath "/probe/go-build")'),
    'GOCACHE 目录必须被授权（否则原地授权失效）',
  )
  assert.ok(
    confined.argv[2].includes('(subpath "/probe/go-mod")'),
    'GOMODCACHE 目录必须被授权',
  )
  reset()
})

test('confine：显式 sandboxRoots 与探测结果合并', async () => {
  const { CacheSandboxProvider: P } = await import('../lib/provider.js')
  const { shared: st, resetShared: reset } = await import('../lib/shared.js')

  reset()
  st.paths = [{ preset: 'go', env: 'GOCACHE', kind: 'cache', path: '/probe/detected' }]
  st.detected = true

  const instance = Object.create(P.prototype)
  instance.ctx = { logger: { info() {}, warn() {} } }
  instance.extraRoots = []
  instance.rootsConfigured = true
  instance.pluginConfig = { autoDetect: true, presets: ['go'], sandboxRoots: ['/explicit/dir'] }

  const baseArgv = ['sandbox-exec', '-p', '(deny file-write*)', '--', 'bash', '-c', 'x']
  makeConfineStub(instance, baseArgv)
  const confined = await instance.confine(baseArgv, { mode: 'workspace-write' })

  assert.ok(confined.argv[2].includes('(subpath "/explicit/dir")'), '显式目录必须保留')
  assert.ok(confined.argv[2].includes('(subpath "/probe/detected")'), '探测目录也要并入')
  reset()
})

test('confine：未启用时完全不改 argv', async () => {
  const { CacheSandboxProvider: P } = await import('../lib/provider.js')
  const { resetShared: reset } = await import('../lib/shared.js')
  reset()

  const instance = Object.create(P.prototype)
  instance.ctx = { logger: { info() {}, warn() {} } }
  instance.extraRoots = []
  instance.rootsConfigured = false
  instance.pluginConfig = { autoDetect: true, presets: ['go'], sandboxRoots: [] }

  const baseArgv = ['sandbox-exec', '-p', '(deny file-write*)', '--', 'bash', '-c', 'x']
  makeConfineStub(instance, baseArgv)
  const confined = await instance.confine(baseArgv, { mode: 'workspace-write' })
  assert.deepEqual(confined.argv, baseArgv)
  reset()
})

// ---------------------------------------------------------------- 用户目录预设

test('USER_DIR_PRESETS：每项都有 label/benefit/risk/path', async () => {
  const { USER_DIR_PRESETS } = await import('../lib/user-dirs.js')
  for (const [name, preset] of Object.entries(USER_DIR_PRESETS)) {
    assert.equal(typeof preset.label, 'string', `${name} 缺 label`)
    assert.equal(typeof preset.benefit, 'string', `${name} 缺 benefit`)
    assert.equal(typeof preset.risk, 'string', `${name} 缺 risk`)
    assert.equal(typeof preset.path, 'function', `${name} 缺 path`)
    assert.ok(preset.path().startsWith('/'), `${name} 路径必须是绝对路径`)
  }
})

test('expandUserDirPresets：默认空数组不授权任何目录', async () => {
  const { expandUserDirPresets } = await import('../lib/user-dirs.js')
  assert.deepEqual(expandUserDirPresets([]), [])
  assert.deepEqual(expandUserDirPresets(undefined), [])
})

test('expandUserDirPresets：未知预设跳过而不抛错', async () => {
  const { expandUserDirPresets } = await import('../lib/user-dirs.js')
  const out = expandUserDirPresets(['nope', 'user-config'])
  assert.equal(out.length, 1)
  assert.ok(out[0].endsWith('/.config'))
})

test('expandUserDirPresets：选中多项按顺序展开', async () => {
  const { expandUserDirPresets } = await import('../lib/user-dirs.js')
  const out = expandUserDirPresets(['user-config', 'user-cache'])
  assert.equal(out.length, 2)
  assert.ok(out[0].endsWith('/.config'))
  assert.ok(out[1].endsWith('/.cache'))
})

test('confine：勾选的用户目录必须真正进入 argv', async () => {
  const { CacheSandboxProvider: P } = await import('../lib/provider.js')
  const { shared: st, resetShared: reset } = await import('../lib/shared.js')
  const { expandUserDirPresets } = await import('../lib/user-dirs.js')

  reset()
  st.detected = true
  st.paths = []

  const instance = Object.create(P.prototype)
  instance.ctx = { logger: { info() {}, warn() {} } }
  instance.extraRoots = []
  instance.rootsConfigured = true
  // 只勾用户目录，关闭自动探测 —— 验证用户目录是独立来源。
  instance.pluginConfig = {
    autoDetect: false,
    presets: [],
    sandboxRoots: [],
    userDirs: ['user-config'],
  }

  const baseArgv = ['sandbox-exec', '-p', '(deny file-write*)', '--', 'bash', '-c', 'opencode']
  instance.superConfine = async () => ({
    argv: baseArgv,
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  })

  const confined = await instance.confine(baseArgv, { mode: 'workspace-write' })
  const expected = expandUserDirPresets(['user-config'])[0]
  assert.ok(
    confined.argv[2].includes(`(subpath "${expected}")`),
    `~/.config 必须被授权，实际 profile=${confined.argv[2]}`,
  )
  reset()
})

test('confine：userDirs 为空时不授权任何用户目录', async () => {
  const { CacheSandboxProvider: P } = await import('../lib/provider.js')
  const { shared: st, resetShared: reset } = await import('../lib/shared.js')

  reset()
  st.detected = true
  st.paths = []

  const instance = Object.create(P.prototype)
  instance.ctx = { logger: { info() {}, warn() {} } }
  instance.extraRoots = []
  instance.rootsConfigured = true
  instance.pluginConfig = { autoDetect: false, presets: [], sandboxRoots: [], userDirs: [] }

  const baseArgv = ['sandbox-exec', '-p', '(deny file-write*)', '--', 'bash', '-c', 'x']
  instance.superConfine = async () => ({
    argv: baseArgv,
    enforcement: 'full',
    denialSignatures: ['operation not permitted'],
    runnerFailureRules: [],
  })

  const confined = await instance.confine(baseArgv, { mode: 'workspace-write' })
  // 没有任何可授权目录 → argv 保持不变。
  assert.deepEqual(confined.argv, baseArgv)
  reset()
})
