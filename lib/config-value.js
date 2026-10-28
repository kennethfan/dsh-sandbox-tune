/**
 * 配置取值辅助：统一处理 volatile 取值器与普通值。
 *
 * 为什么需要它：为了让插件出现在「设置」界面并支持运行时改值，config 字段
 * 必须标记 `.volatile()`。标记之后，schemastery 不再给字段直接值，而是给一个
 * 带 `.get()` 的取值器。如果代码里还按普通值读（`config.mode === 'x'`），
 * 拿到的是取值器对象，比较永远为 false —— 属于静默失效。
 *
 * 反过来，在测试或非 volatile 场景里，字段就是普通值。所以这里两者都兼容，
 * 避免每个读取点各写一遍 `instanceof` 判断。
 *
 * @module lib/config-value
 */

/**
 * 读取一个配置字段的值。
 *
 * @template T
 * @param {T | { get(): T }} field - volatile 取值器或普通值。
 * @param {T} [fallback] - 字段缺失时的兜底值。
 * @returns {T} 实际值。
 */
export function valueOf(field, fallback) {
  if (field === undefined || field === null) return fallback
  // volatile 取值器的判据：有 get 函数且不是数组/普通对象（数组也有 get? 没有）。
  if (typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}
