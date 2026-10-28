/**
 * dsh-sandbox-tune — 包入口（裸包名行）。
 *
 * 这个文件是**浏览器半身的挂载点**，不是执行器。
 *
 * 为什么必须存在这样一条「空」的裸包名行：
 * `dsh-client-modules` 扫描 loader 条目时，用 `exactPackageSpecifier()` 从条目的
 * `name` 推出包名 —— 该函数对含 `/` 的 specifier 直接返回 undefined。所以真正
 * 干活的 `dsh-sandbox-tune/executor` 与 `dsh-sandbox-tune/provider` 两条子路径行
 * 永远不会被客户端模块系统扫到，浏览器半身（client.js）也就不会加载。
 *
 * 而扫描又要求 `entry.fiber !== undefined && !entry.disabled`，所以这条裸包名行
 * 必须真正启用、必须成功 apply —— 但它的 Host 半身什么也不做，只为了让
 * client-modules 通过裸包名定位到 package.json 里的 `dsh.client` 声明。
 *
 * 这与官方包的做法一致（见 dsh-client-ui-settings-plugins：宿主半侧是一个空的
 * apply，只为让本包占一条 Loader 行）。
 *
 * 真正的功能由两条子路径行提供：
 *   - `dsh-sandbox-tune/executor` → CacheBashExecutor（缓存重定向 / 原地授权决策）
 *   - `dsh-sandbox-tune/provider` → CacheSandboxProvider（追加沙箱可写白名单）
 *
 * @module index
 */

export const name = 'dsh-sandbox-tune'

/** 空 Host 半身：不注册任何服务，只占位以承载浏览器半身。 */
export function apply() {}

/** cordis 加载一条 loader 行时取 default 导出。 */
export default { name: 'dsh-sandbox-tune', apply }

// 刻意不在这里 re-export 执行器/provider：那会让本模块连带加载它们的依赖，
// 一旦解析失败，这条占位行 apply 失败，浏览器半身也随之消失。
// 需要实现时直接 import 子路径（dsh-sandbox-tune/executor、/provider）。
