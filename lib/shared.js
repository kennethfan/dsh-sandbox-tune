/**
 * 两个半身之间的共享状态：路径探测结果 + 后端能力 + 生效模式。
 *
 * 为什么需要它：
 * - **路径探测**属于 Host 侧（要跑 `go env` 等子进程），只该做一次，
 *   放在 provider 里做；executor 需要知道「哪些目录要授权」。
 * - **后端能力**（能否追加写白名单）只有 provider 知道，而「要不要重定向」
 *   这个决策在 executor 里。两者必须交换这一条事实，否则会出现
 *   「模式是 in-place、但后端不支持」→ 既不授权也不重定向 → 构建直接坏掉。
 *
 * 用模块级单例而不是 cordis 服务：两个半身总是成对挂载在同一个 Host 进程里，
 * 而注册新服务会与「同名服务不能重复注册」的约束纠缠，收益不抵复杂度。
 *
 * @module lib/shared
 */

/** 进程内共享状态。 */
export const shared = {
  /** 探测到的缓存路径条目（见 detectCachePaths）。 */
  paths: [],
  /** 探测是否已完成（含失败）。 */
  detected: false,
  /** 探测进行中的 Promise，避免并发重复探测。 */
  detecting: null,
  /** 当前沙箱后端是否支持追加可写白名单。 */
  canExtendRoots: false,
  /** 实际生效的模式：`redirect` | `in-place`。 */
  effectiveMode: 'redirect',
  /** 已确认可授权的根目录（provider 写入，executor 只读）。 */
  grantedRoots: [],
  /**
   * 会话级配置覆盖：sessionId → 覆盖表。
   *
   * 放内存而不是会话日志，原因见 executor 的 overridesFor 注释：
   * sessionProjections 要求 zod schema（本插件用 schemastery，混用会让插件
   * 加载失败），而 snapshotEvents() 已被标记禁止新调用。
   */
  sessionOverrides: new Map(),
}

/**
 * 重置共享状态。
 *
 * 主要给测试用：插件在测试里会被反复挂载，残留状态会串味。
 */
export function resetShared() {
  shared.paths = []
  shared.detected = false
  shared.detecting = null
  shared.canExtendRoots = false
  shared.effectiveMode = 'redirect'
  shared.grantedRoots = []
  shared.sessionOverrides.clear()
}

/**
 * 从探测结果里筛出要授权的目录。
 *
 * @param {Array<{ path: string, kind: string }>} paths - 探测结果。
 * @param {'cache' | 'store' | 'all'} kinds - 要哪些类型。
 * @returns {string[]} 去重后的绝对路径。
 */
export function pickPaths(paths, kinds = 'all') {
  const picked = paths
    .filter((entry) => kinds === 'all' || entry.kind === kinds)
    .map((entry) => entry.path)
    .filter((path) => typeof path === 'string' && path.length > 0)
  return [...new Set(picked)]
}
