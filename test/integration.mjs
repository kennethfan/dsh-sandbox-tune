/**
 * 集成验证：用真实插件组合挂载本插件，检查两种模式的 resolve() 输出，
 * 并尝试在真实沙箱里执行 go build。
 *
 * 用法：node test/integration.mjs
 *
 * 注意最后一项的环境要求：测试进程自身**不能**已被沙箱限制。
 * 在 DSH 会话的 bash 里跑时，进程已在 Seatbelt 之下，嵌套 sandbox-exec 会
 * 返回 SANDBOX_UNAVAILABLE，该项会标记 SKIP —— 请在普通终端重跑。
 */

import { Context } from '@deepseek-ai/cordis'
import subprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import sessionProjection from '@deepseek-ai/dsh-session-projection'
import sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
// shell-env 是函数式插件（导出 apply/name/inject），没有 default 导出。
import * as shellEnv from '@deepseek-ai/dsh-shell-env'

import { CacheBashExecutor } from '../lib/executor.js'
import { CacheSandboxProvider } from '../lib/provider.js'
import { resetShared, shared } from '../lib/shared.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

/**
 * 挂载一套真实插件组合。
 *
 * 依赖顺序不能乱：sandbox-policy 需要 sessionProjections，
 * executor 需要 sandbox / sandboxPolicy / subprocess。
 *
 * @param {object} executorConfig - 执行器配置。
 * @returns {Promise<import('@deepseek-ai/cordis').Context>} 就绪的上下文。
 */
async function mount(executorConfig) {
  const ctx = new Context()
  await ctx.plugin(subprocessLocal)
  await ctx.plugin(sessionProjection)
  await ctx.plugin(CacheSandboxProvider, {
    enabled: true,
    autoDetect: true,
    presets: ['go'],
    sandboxRoots: [],
  })
  await ctx.plugin(sandboxPolicy, { mode: 'workspace-write', workspaceRoot: process.cwd() })
  await ctx.plugin(shellEnv)
  await ctx.plugin(CacheBashExecutor, {
    presets: ['go'],
    env: {},
    timeoutMs: 120000,
    ...executorConfig,
  })
  return ctx
}

async function main() {
  // 插件按设计不覆盖「用户已显式设置」的缓存变量，所以测试必须先清掉它们：
  // 否则宿主机上若设了 GOCACHE，注入断言会随环境漂移（测试缺陷，非代码缺陷）。
  for (const name of ['GOCACHE', 'GOMODCACHE', 'NPM_CONFIG_CACHE', 'BUN_INSTALL_CACHE_DIR', 'PIP_CACHE_DIR', 'CARGO_HOME']) {
    delete process.env[name]
  }

  // ---------------------------------------------------------------- redirect
  resetShared()
  const ctx = await mount({ enabled: true, mode: 'redirect' })
  const shell = ctx.get('shell')
  check('ctx.shell 已注册', shell !== undefined, shell?.constructor?.name)

  const spec = shell.resolve({ command: 'go build ./...' })
  const gocache = spec.env?.GOCACHE
  check('redirect：注入 GOCACHE', typeof gocache === 'string' && gocache.length > 0, gocache)
  check(
    'redirect：GOCACHE 指向临时目录（沙箱可写）',
    typeof gocache === 'string' && gocache.startsWith(process.env.TMPDIR ?? '/var/folders'),
    gocache,
  )
  check('redirect：未注入 GOMODCACHE（依赖仓库不重定向）', spec.env?.GOMODCACHE === undefined)

  // danger-full-access 下不该动任何东西
  const fullSpec = shell.resolve({
    command: 'go build ./...',
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
  })
  check('redirect：danger-full-access 不注入', fullSpec.env?.GOCACHE === undefined)

  // 调用方自带 env 必须保留
  const withEnv = shell.resolve({ command: 'echo hi', env: { MY_FLAG: '1' } })
  check('redirect：保留调用方 env', withEnv.env?.MY_FLAG === '1', JSON.stringify(withEnv.env))

  // ---------------------------------------------------------------- in-place
  resetShared()
  const ctxInPlace = await mount({ enabled: true, mode: 'in-place' })
  const inPlaceShell = ctxInPlace.get('shell')
  const inPlaceSpec = inPlaceShell.resolve({ command: 'go build ./...' })
  check(
    'in-place：不注入任何缓存变量（路径保持原样）',
    inPlaceSpec.env?.GOCACHE === undefined,
    JSON.stringify(inPlaceSpec.env ?? {}),
  )
  check('in-place：生效模式为 in-place', inPlaceShell.effectiveMode() === 'in-place')
  check('in-place：后端被判定为可追加白名单', shared.canExtendRoots === true)

  // ---------------------------------------------------------------- 关闭开关
  resetShared()
  const ctxOff = await mount({ enabled: false, mode: 'redirect' })
  const offSpec = ctxOff.get('shell').resolve({ command: 'go build ./...' })
  check('enabled:false 完全不注入', offSpec.env?.GOCACHE === undefined)

  // ---------------------------------------------------------------- 真实执行
  resetShared()
  const ctxRun = await mount({ enabled: true, mode: 'redirect' })
  const probe = '/tmp/dsh-cache-it'
  try {
    await ctxRun
      .get('shell')
      .execute(ctxRun.get('shell').resolve({ command: `rm -rf ${probe} && mkdir -p ${probe}` }))
      .then((e) => e.result())

    const build = await (
      await ctxRun.get('shell').execute(
        ctxRun.get('shell').resolve({
          command: `cd ${probe} && printf 'package main\\nimport "fmt"\\nfunc main(){fmt.Println("ok")}\\n' > main.go && printf 'module probe\\ngo 1.26\\n' > go.mod && go build -o probe . && ./probe`,
          workdir: probe,
        }),
      )
    ).result()

    check(
      '沙箱内 go build 成功',
      build.exitCode === 0 && !build.sandbox?.denied,
      `exit=${build.exitCode} denied=${build.sandbox?.denied} stderr=${build.stderr?.text?.slice(0, 120)}`,
    )
    check('go build 输出正确', build.stdout?.text?.trim() === 'ok', JSON.stringify(build.stdout?.text))
  } catch (error) {
    const nested = String(error?.code ?? '').includes('SANDBOX_UNAVAILABLE')
    if (nested) {
      console.log('SKIP  沙箱内 go build — 测试进程自身已被沙箱限制，无法嵌套 sandbox-exec')
      console.log('      请在普通终端（非 DSH 会话）重跑本脚本以验证这一项')
    } else {
      check('沙箱内 go build 成功', false, String(error?.message ?? error))
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('集成测试异常:', error)
  process.exit(1)
})
