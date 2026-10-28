/**
 * 方案 A 的入口：只替换 bash 执行器。
 *
 * 单文件入口的理由：cordis 加载一个插件行时只取模块的 default 导出，
 * 所以「执行器」与「provider」必须是两个可寻址的模块路径，不能靠
 * 同一个模块的两个具名导出区分。
 *
 * @module executor-entry
 */

export { CacheBashExecutor as default, CacheBashExecutor } from './lib/executor.js'
