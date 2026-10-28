/**
 * dsh-sandbox-tune — 浏览器半身。
 *
 * 手写 ModuleLoader bundle：无构建步骤，只依赖 shell 已提供的 react。
 * 贡献一个设置页 section（`settings.section`，id `sandbox-tune`），
 * 用来可视化编辑两个 profile 行的 config：
 *   - `sandbox-tune-bash`     （执行器：mode / cacheRoot / presets / enabled）
 *   - `sandbox-tune-provider` （provider：autoDetect / sandboxRoots / enabled）
 *
 * 为什么不用官方的 `plugins.item` 卡片：那个分组只列官方包清单里的插件，
 * 第三方包进不去。`settings.section` 是任何插件都能注册的通用设置页入口。
 *
 * 写配置走 `remote.settings.update(ns, patch, revision)`，ns 就是 profile 行的
 * id —— Host 的 `settings.describe` 把每个 loader 行按 `entry.options.id`
 * 投影成一个命名空间（见 dsh-settings 的 describe 实现）。
 *
 * 前提：Host 侧这些字段必须标了 `.volatile()`，否则不会出现在 settings 文档里。
 *
 * 颜色全部取自主题变量，明暗主题切换无需额外处理。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sandbox-tune',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React
    // 官方 UI 基座：Modal 自带 portal / 焦点陷阱 / Escape / 遮罩 / aria。
    // 它在共享模块表里，直接 require 即可，不需要写进 dsh.client.external。
    const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    // slots：设置页 section 必须挂在 slot 上。
    // remote + remote.settings：读写 settings 文档（官方配置页同样声明这两个）。
    const inject = ['slots', 'remote', 'remote.settings', 'sessions']

    /** 两个 profile 行的 id —— 它们同时是 settings 命名空间名。 */
    const BASH_NS = 'sandbox-tune-bash'
    const PROVIDER_NS = 'sandbox-tune-provider'

    /** 可选的缓存预设（与 Host 侧 CACHE_PRESETS 的键保持一致）。 */
    const PRESETS = ['go', 'npm', 'bun', 'pip', 'cargo']

    /**
     * 用户级目录预设（与 Host 侧 USER_DIR_PRESETS 的键保持一致）。
     *
     * 每一项都写明收益与风险：放宽文件写入边界是有代价的，
     * 使用者应当看到代价再决定。
     */
    const USER_DIRS = [
      {
        id: 'user-config',
        label: '~/.config',
        benefit: '各类 CLI 的配置目录（opencode、gh 等），最常见的弹窗来源。',
        risk: '沙箱内进程可读写你的所有 CLI 配置。',
      },
      {
        id: 'user-cache',
        label: '~/.cache',
        benefit: '通用缓存目录，npm / pip / bun 等都会用到。',
        risk: '风险较低：缓存丢了只是变慢，但内容可被篡改。',
      },
      {
        id: 'user-data',
        label: '~/.local/share',
        benefit: '应用数据目录，含部分工具的状态与会话数据。',
        risk: '沙箱内进程可修改应用数据，包括数据库。',
      },
      {
        id: 'user-state',
        label: '~/.local/state',
        benefit: '应用运行状态与日志目录。',
        risk: '风险较低：主要是日志与状态。',
      },
    ]

    const CSS = `
.dsc-wrap { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px 24px; max-width: 760px; }
.dsc-head-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsc-head-sub { margin-top: 4px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #999); }
.dsc-card { border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; background: var(--dsw-alias-bg-layer-1, #1e1f24); }
.dsc-card-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsc-card-desc { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #888); }
.dsc-row { display: flex; flex-direction: column; gap: 6px; }
.dsc-label { font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsc-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #888); }
.dsc-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 8px; overflow: hidden; width: fit-content; }
.dsc-seg-btn { background: transparent; color: var(--dsw-alias-label-secondary, #999); border: 0; cursor: pointer; font: inherit; font-size: 12px; padding: 7px 14px; }
.dsc-seg-btn[data-active=true] { background: var(--dsw-alias-state-business-primary, #4b7bec); color: #fff; }
.dsc-input { background: var(--dsw-alias-bg-layer-2, #26272c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 7px; font: inherit; font-size: 12px; padding: 7px 10px; width: 100%; box-sizing: border-box; }
.dsc-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.dsc-chip { background: transparent; color: var(--dsw-alias-label-secondary, #999); border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 999px; cursor: pointer; font: inherit; font-size: 12px; padding: 5px 12px; }
.dsc-chip[data-active=true] { background: var(--dsw-alias-bg-layer-3, #2f3037); color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsw-alias-label-tertiary, #888); }
.dsc-actions { display: flex; align-items: center; gap: 10px; }
.dsc-btn { background: var(--dsw-alias-bg-layer-2, #26272c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; padding: 7px 14px; }
.dsc-btn-primary { background: var(--dsw-alias-state-business-primary, #4b7bec); border-color: transparent; color: #fff; }
.dsc-btn:disabled { opacity: 0.55; cursor: default; }
.dsc-status { font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); }
.dsc-status[data-kind=error] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsc-status[data-kind=ok] { color: var(--dsw-alias-state-success-primary, #30a46c); }
.dsc-warn { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-state-warning-primary, #f5a623); }
.dsc-hbtn { background: transparent; color: var(--dsw-alias-label-secondary, #999); border: 1px solid transparent; border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; padding: 4px 9px; white-space: nowrap; }
.dsc-hbtn:hover { background: var(--dsw-alias-bg-layer-2, #26272c); color: var(--dsw-alias-label-primary, #e6e6e6); }
/* Modal 宽度：官方 dialog 默认窄，这里放宽以容纳两列表单 */
.dsc-modal { width: 640px; max-width: calc(100vw - 48px); }
.dsc-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 18px; padding: 4px 0 8px; }
.dsc-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.dsc-field-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.dsc-field-label { font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsc-field-key { font-size: 10px; padding: 0 4px; border-radius: 3px; color: var(--dsw-alias-label-tertiary, #888); background: var(--dsw-alias-bg-layer-2, #26272c); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsc-modal-footer { display: flex; align-items: center; gap: 10px; width: 100%; }
.dsc-modal-footer-left { display: flex; gap: 8px; }
.dsc-btn-danger:hover { border-color: var(--dsw-alias-state-error-primary, #e5484d); color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsc-modal-note { grid-column: 1 / -1; display: flex; align-items: flex-start; gap: 8px; padding: 9px 11px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #26272c); border: 1px solid var(--dsw-alias-border-l1, #33343a); font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #999); }
/* 列表字段：已添加项显示为表格行，每行右侧带删除按钮 */
.dsc-list { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsc-list-table { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 7px; overflow: hidden; }
.dsc-list-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px 5px 9px; background: var(--dsw-alias-bg-layer-2, #26272c); }
.dsc-list-row + .dsc-list-row { border-top: 1px solid var(--dsw-alias-border-l1, #33343a); }
.dsc-list-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.dsc-list-del { flex: none; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-tertiary, #888); cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
.dsc-list-del:hover { background: var(--dsw-alias-interactive-bg-hover, #2f3037); color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsc-list-del:disabled { opacity: 0.5; cursor: default; }
.dsc-list-empty { padding: 7px 9px; border: 1px dashed var(--dsw-alias-border-l1, #33343a); border-radius: 7px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); }
.dsc-list-add { display: flex; gap: 6px; }
.dsc-list-addbtn { flex: none; background: var(--dsw-alias-bg-layer-2, #26272c); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, #33343a); border-radius: 7px; cursor: pointer; font: inherit; font-size: 12px; padding: 0 12px; }
.dsc-list-addbtn:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 560px) { .dsc-form { grid-template-columns: minmax(0, 1fr); } }
.dsc-scope-note { margin-top: 10px; display: flex; align-items: flex-start; gap: 8px; padding: 9px 11px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #26272c); border: 1px solid var(--dsw-alias-border-l1, #33343a); font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #999); }
.dsc-scope-badge { flex: none; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-state-business-primary, #4b7bec); color: #fff; font-size: 10px; font-weight: 600; }
.dsc-code { padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-3, #2f3037); color: var(--dsw-alias-label-primary, #e6e6e6); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
`

    /**
     * 把 Host 的取值器/普通值统一成可渲染的值。
     *
     * 浏览器侧拿到的是 settings 文档的 `value`，已经是普通 JSON 值；
     * 但不同版本可能给出包装，这里做一次防御性解包。
     *
     * @param {unknown} value - 原始值。
     * @param {unknown} fallback - 兜底值。
     * @returns {unknown} 可用的值。
     */
    function plain(value, fallback) {
      if (value === undefined || value === null) return fallback
      if (typeof value === 'object' && typeof value.get === 'function') return value.get()
      return value
    }

    /** 一个开关行。 */
    function Toggle({ label, hint, checked, onChange, disabled }) {
      return h(
        'div',
        { className: 'dsc-row' },
        h(
          'label',
          { className: 'dsc-label', style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            type: 'checkbox',
            checked: Boolean(checked),
            disabled,
            onChange: event => onChange(event.target.checked),
          }),
          label,
        ),
        hint ? h('div', { className: 'dsc-hint' }, hint) : null,
      )
    }

    /** 二选一的分段控件。 */
    function Segmented({ label, hint, value, options, onChange, disabled }) {
      return h(
        'div',
        { className: 'dsc-row' },
        h('div', { className: 'dsc-label' }, label),
        h(
          'div',
          { className: 'dsc-seg' },
          options.map(option =>
            h(
              'button',
              {
                key: option.value,
                type: 'button',
                className: 'dsc-seg-btn',
                'data-active': String(value === option.value),
                disabled,
                onClick: () => onChange(option.value),
              },
              option.label,
            ),
          ),
        ),
        hint ? h('div', { className: 'dsc-hint' }, hint) : null,
      )
    }

    /** 多选标签组。 */
    function Chips({ label, hint, values, onChange, disabled }) {
      const set = new Set(values ?? [])
      return h(
        'div',
        { className: 'dsc-row' },
        h('div', { className: 'dsc-label' }, label),
        h(
          'div',
          { className: 'dsc-chips' },
          PRESETS.map(name =>
            h(
              'button',
              {
                key: name,
                type: 'button',
                className: 'dsc-chip',
                'data-active': String(set.has(name)),
                disabled,
                onClick: () => {
                  const next = new Set(set)
                  if (next.has(name)) next.delete(name)
                  else next.add(name)
                  onChange([...next])
                },
              },
              name,
            ),
          ),
        ),
        hint ? h('div', { className: 'dsc-hint' }, hint) : null,
      )
    }

    /**
     * 一个命名空间的表单卡片。
     *
     * 读取走 `settings.describe`，写入走 `settings.update`；
     * 每次写入带上 revision 做乐观并发，避免覆盖别处的改动。
     */
    function NamespaceCard({ ctx, ns, title, desc, children }) {
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          // 浏览器侧的远端接口挂在 ctx.remote 属性上（不是 ctx.get('remote')）。
          const settings = ctx.remote?.settings
          if (!settings) {
            setStatus({ kind: 'error', text: '当前 Host 未提供 settings 服务，无法读写配置。' })
            return
          }
          const described = await settings.describe()
          if (described?.error) {
            setStatus({ kind: 'error', text: String(described.error.message ?? described.error) })
            return
          }
          const row = (described?.value?.namespaces ?? []).find(item => item.ns === ns)
          if (!row) {
            setStatus({
              kind: 'error',
              text: `Host 未暴露命名空间 ${ns}。请确认插件已启用，且配置字段标了 volatile。`,
            })
            return
          }
          setView(row)
          setDraft(row.value ?? {})
          setStatus(null)
        } catch (error) {
          setStatus({ kind: 'error', text: String(error?.message ?? error) })
        }
      }, [ctx, ns])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(async () => {
        if (!draft || !view) return
        setBusy(true)
        setStatus(null)
        try {
          const result = await ctx.remote.settings.update(ns, draft, view.revision)
          if (result?.error) {
            setStatus({ kind: 'error', text: String(result.error.message ?? result.error) })
            return
          }
          setView(result.value)
          setDraft(result.value?.value ?? draft)
          setStatus({ kind: 'ok', text: '已保存并生效。' })
        } catch (error) {
          setStatus({ kind: 'error', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [ctx, ns, draft, view])

      const dirty = Boolean(draft && view && JSON.stringify(draft) !== JSON.stringify(view.value ?? {}))

      if (!draft) {
        return h(
          'section',
          { className: 'dsc-card' },
          h('div', { className: 'dsc-card-title' }, title),
          h('div', { className: 'dsc-hint' }, status?.text ?? '读取中…'),
        )
      }

      return h(
        'section',
        { className: 'dsc-card' },
        h('div', { className: 'dsc-card-title' }, title),
        desc ? h('div', { className: 'dsc-card-desc' }, desc) : null,
        children({ draft, setDraft, busy }),
        h(
          'div',
          { className: 'dsc-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsc-btn dsc-btn-primary',
              disabled: busy || !dirty,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            { type: 'button', className: 'dsc-btn', disabled: busy, onClick: load },
            '重新读取',
          ),
          status
            ? h('span', { className: 'dsc-status', 'data-kind': status.kind }, status.text)
            : null,
        ),
      )
    }

    /** 设置页主体。 */
    function Section({ ctx }) {
      return h(
        'div',
        { className: 'dsc-wrap' },
        h(
          'div',
          null,
          h('div', { className: 'dsc-head-title' }, '沙箱调优'),
          h(
            'div',
            { className: 'dsc-head-sub' },
            '让开发工具在沙箱内正常工作的同时，减少重复的提权审批弹窗。',
            h('br'),
            '缓存：redirect 把纯缓存重定向到临时目录（任何平台可用）；in-place 保持路径不变，把真实缓存目录授权为可写（需 Seatbelt / bwrap，与普通终端共用缓存）。',
            h('br'),
            '可写目录：把 ~/.config 等用户级目录加入白名单，解决「工具必须写工作区外配置」的弹窗。',
            h('br'),
            '命令授权：按规则自动批准沙箱升权。默认关闭，开启前请先看清风险提示。',
          ),
          // 明确告诉用户「这里改的是全局」，否则会一直在设置页找会话级选项。
          h(
            'div',
            { className: 'dsc-scope-note' },
            h('span', { className: 'dsc-scope-badge' }, '全局'),
            h(
              'span',
              null,
              '本页修改的是全局配置，对所有会话生效。想只改当前会话，' +
                '请用会话标题右侧的「沙箱调优」按钮，或输入 ',
              h('code', { className: 'dsc-code' }, '/sandbox-tune'),
              '。',
            ),
          ),
        ),

        h(NamespaceCard, {
          ctx,
          ns: BASH_NS,
          title: '执行器（sandbox-tune-bash）',
          desc: '决定缓存写到哪里。mode 为 in-place 时不再注入任何缓存变量，改由下方 provider 授权。',
          children: ({ draft, setDraft, busy }) =>
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              h(Toggle, {
                label: '启用',
                hint: '关闭后完全退化为原生执行器，缓存行为不受本插件影响。',
                checked: plain(draft.enabled, true),
                disabled: busy,
                onChange: value => setDraft({ ...draft, enabled: value }),
              }),
              h(Segmented, {
                label: '模式',
                hint:
                  plain(draft.mode, 'redirect') === 'in-place'
                    ? '当前：in-place —— 缓存路径保持原样，由 provider 授权。后端不支持时自动回退为 redirect。'
                    : '当前：redirect —— 纯缓存写到临时目录，重启后首次编译会冷启动。',
                value: plain(draft.mode, 'redirect'),
                disabled: busy,
                options: [
                  { value: 'redirect', label: 'redirect（重定向）' },
                  { value: 'in-place', label: 'in-place（原地授权）' },
                ],
                onChange: value => setDraft({ ...draft, mode: value }),
              }),
              h(
                'div',
                { className: 'dsc-row' },
                h('div', { className: 'dsc-label' }, '缓存根目录（仅 redirect 模式）'),
                h('input', {
                  className: 'dsc-input',
                  type: 'text',
                  value: plain(draft.cacheRoot, ''),
                  disabled: busy || plain(draft.mode, 'redirect') === 'in-place',
                  placeholder: '留空则使用 $TMPDIR/dsh',
                  onChange: event => setDraft({ ...draft, cacheRoot: event.target.value }),
                }),
                h(
                  'div',
                  { className: 'dsc-hint' },
                  '留空 → $TMPDIR/dsh。填工作区内路径（如 .dsh/cache）可让缓存重启不丢。',
                ),
              ),
              h(Chips, {
                label: '启用的工具预设',
                hint: 'go 的 GOCACHE、npm 的 NPM_CONFIG_CACHE 等纯缓存会被重定向；依赖仓库永不重定向。',
                values: plain(draft.presets, ['go']),
                disabled: busy,
                onChange: value => setDraft({ ...draft, presets: value }),
              }),

              // ---- 命令授权 ----
              h(
                'div',
                { style: { height: 1, background: 'var(--dsw-alias-border-l1, #33343a)', margin: '2px 0' } },
              ),
              h(Segmented, {
                label: '命令授权（自动批准升权）',
                hint:
                  plain(draft.autoApproveMode, 'off') === 'off'
                    ? '当前：off —— 每次升权都弹窗确认。'
                    : plain(draft.autoApproveMode, 'off') === 'exact'
                      ? '当前：exact —— 命令必须与规则逐字符相同才放行。最安全，但命中率低。'
                      : '当前：safe-args —— 命令以规则开头且不含 shell 组合构造时放行。',
                value: plain(draft.autoApproveMode, 'off'),
                disabled: busy,
                options: [
                  { value: 'off', label: 'off（关闭）' },
                  { value: 'exact', label: 'exact（精确匹配）' },
                  { value: 'safe-args', label: 'safe-args（安全参数）' },
                ],
                onChange: value => setDraft({ ...draft, autoApproveMode: value }),
              }),
              h(ListEditor, {
                field: { key: 'autoApproveCommands' },
                items: plain(draft.autoApproveCommands, []),
                busy: busy || plain(draft.autoApproveMode, 'off') === 'off',
                placeholder: '输入后回车添加，如 go build',
                // 全局页是「先编辑后保存」，所以只写草稿，不立即提交。
                onCommit: value => setDraft({ ...draft, autoApproveCommands: value }),
                hint:
                  plain(draft.autoApproveMode, 'off') === 'exact'
                    ? '每条规则是一条完整命令，逐字符比较。'
                    : '每条规则是一个命令词（如 go build）。用 && || ; | 连接的多条命令，每段都必须在规则里才放行；重定向 > < 与命令替换 ` $() 一律不放行。',
              }),
              h(
                'div',
                { className: 'dsc-warn' },
                '自动放行的是 danger-full-access 升权：放行后整条命令不受文件沙箱限制。' +
                  '请只把确实安全、且你不会拼接其他操作的命令加进来。每次自动放行都会写日志。',
              ),
            ),
        }),

        h(NamespaceCard, {
          ctx,
          ns: PROVIDER_NS,
          title: '沙箱 provider（sandbox-tune-provider）',
          desc: '把真实缓存目录追加进沙箱可写白名单。仅在 mode 为 in-place 时起作用。',
          children: ({ draft, setDraft, busy }) =>
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              h(Toggle, {
                label: '启用',
                hint: '关闭后不修改沙箱边界。',
                checked: plain(draft.enabled, true),
                disabled: busy,
                onChange: value => setDraft({ ...draft, enabled: value }),
              }),
              h(Toggle, {
                label: '自动探测路径',
                hint: '跑 go env / npm config get cache 等只读命令，拿到真实缓存位置。建议开启。',
                checked: plain(draft.autoDetect, true),
                disabled: busy,
                onChange: value => setDraft({ ...draft, autoDetect: value }),
              }),
              h(Chips, {
                label: '探测哪些工具',
                hint: 'go 会探测 GOCACHE 与 GOMODCACHE；cargo 探测 CARGO_HOME。',
                values: plain(draft.presets, ['go']),
                disabled: busy,
                onChange: value => setDraft({ ...draft, presets: value }),
              }),
              // 用户级目录预设：解决「开发工具必须写工作区外配置」的弹窗。
              h(
                'div',
                { className: 'dsc-row' },
                h('div', { className: 'dsc-label' }, '用户级目录（默认全不授权）'),
                h(
                  'div',
                  { className: 'dsc-hint' },
                  '沙箱只允许写「工作区 + /tmp + 临时目录」，所以开发工具写 ~/.config 等会被拒、触发弹窗。' +
                    '勾选后把这些目录加入可写白名单 —— 命令仍在沙箱内，不会整条提权到完全访问。',
                ),
                h(
                  'div',
                  { className: 'dsc-chips', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8 } },
                  USER_DIRS.map(item => {
                    const picked = (plain(draft.userDirs, []) ?? []).includes(item.id)
                    return h(
                      'label',
                      {
                        key: item.id,
                        style: {
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          cursor: busy ? 'default' : 'pointer',
                          padding: '6px 8px',
                          borderRadius: 7,
                          border: '1px solid var(--dsw-alias-border-l1, #33343a)',
                        },
                      },
                      h('input', {
                        type: 'checkbox',
                        checked: picked,
                        disabled: busy,
                        style: { marginTop: 2 },
                        onChange: event => {
                          const current = new Set(plain(draft.userDirs, []) ?? [])
                          if (event.target.checked) current.add(item.id)
                          else current.delete(item.id)
                          setDraft({ ...draft, userDirs: [...current] })
                        },
                      }),
                      h(
                        'span',
                        { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                        h('span', { className: 'dsc-label' }, item.label),
                        h('span', { className: 'dsc-hint' }, item.benefit),
                        h('span', { className: 'dsc-warn' }, '风险：' + item.risk),
                      ),
                    )
                  }),
                ),
              ),
              h(ListEditor, {
                field: { key: 'sandboxRoots' },
                items: plain(draft.sandboxRoots, []),
                busy,
                placeholder: '绝对路径，如 /tmp',
                onCommit: value => setDraft({ ...draft, sandboxRoots: value }),
              }),
              h(
                'div',
                { className: 'dsc-warn' },
                '注意：授权是整目录可写。授权模块缓存意味着沙箱内进程可以修改它，请自行权衡。',
              ),
            ),
        }),
      )
    }

    /**
     * 列表字段编辑器：逐条添加，已添加的显示为表格行，每行带删除按钮。
     *
     * 为什么不用「逗号分隔的文本框」：路径和预设值本身可能含空格与逗号
     * （macOS 的 `Application Support`、env 的 `A=1,B=2`），让用户在单个
     * 文本框里用逗号分隔既容易输错，也看不出当前到底有几项。
     *
     * 每次增删都立刻提交给 Host（走命令），不做本地暂存 —— 避免界面显示
     * 与真实配置不一致，那比不显示更糟。
     *
     * @param {object} props - 组件属性。
     * @returns {object} React 元素。
     */
    function ListEditor({ field, items, busy, onCommit, placeholder, hint }) {
      const list = Array.isArray(items) ? items : []
      const [text, setText] = useState('')

      const add = () => {
        const value = text.trim()
        if (value.length === 0) return
        // 已存在就不重复添加：列表是集合语义，重复项对这些字段没有意义。
        if (list.includes(value)) {
          setText('')
          return
        }
        onCommit([...list, value])
        setText('')
      }

      const remove = index => {
        const next = list.filter((_, i) => i !== index)
        onCommit(next)
      }

      return h(
        'div',
        { className: 'dsc-list' },
        list.length > 0
          ? h(
              'div',
              { className: 'dsc-list-table' },
              ...list.map((item, index) =>
                h(
                  'div',
                  { key: `${item}-${index}`, className: 'dsc-list-row' },
                  h('code', { className: 'dsc-list-value', title: item }, item),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsc-list-del',
                      disabled: busy,
                      title: `移除 ${item}`,
                      'aria-label': `移除 ${item}`,
                      onClick: () => remove(index),
                    },
                    '×',
                  ),
                ),
              ),
            )
          : h('div', { className: 'dsc-list-empty' }, '暂无条目'),
        h(
          'div',
          { className: 'dsc-list-add' },
          h('input', {
            className: 'dsc-input',
            type: 'text',
            disabled: busy,
            placeholder: placeholder ?? '输入后回车添加',
            value: text,
            onChange: event => setText(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            },
          }),
          h(
            'button',
            { type: 'button', className: 'dsc-list-addbtn', disabled: busy || text.trim().length === 0, onClick: add },
            '添加',
          ),
        ),
        hint ? h('div', { className: 'dsc-hint' }, hint) : null,
      )
    }

    /** 会话级可设置字段（与 Host 侧 OVERRIDABLE 保持一致，命令授权两项除外）。 */
    const SESSION_FIELDS = [
      { key: 'mode', label: '模式', kind: 'enum', options: ['redirect', 'in-place'] },
      { key: 'enabled', label: '启用', kind: 'bool' },
      { key: 'cacheRoot', label: '缓存根目录', kind: 'text', placeholder: '留空 → $TMPDIR/dsh' },
      { key: 'presets', label: '工具预设', kind: 'list', placeholder: 'go / npm / bun / pip / cargo' },
      { key: 'userDirs', label: '用户级目录', kind: 'list', placeholder: 'user-config / user-cache / user-data / user-state' },
      { key: 'sandboxRoots', label: '额外授权目录', kind: 'list', placeholder: '绝对路径，如 /tmp' },
      { key: 'env', label: '额外环境变量', kind: 'list', placeholder: 'KEY=VALUE' },
      { key: 'autoDetect', label: '自动探测路径', kind: 'bool' },
    ]

    /**
     * 会话级配置：头部按钮 + 官方 Modal 弹窗。
     *
     * 用官方的 `Modal`（来自 ui-primitives 共享模块）而不是自绘下拉层：
     * 下拉层在窄宽度下会把 8 个字段挤成一列，且缺焦点陷阱与遮罩。
     * 官方 Modal 自带 portal、焦点陷阱、Escape、遮罩点击、aria 语义。
     *
     * 读写都走 `/sandbox-tune` 斜杠命令，与命令入口共用同一套 Host 逻辑 ——
     * 避免前后端各写一份校验，两边行为不一致。
     *
     * 为什么放在会话头部：设置页是全局面板，拿不到当前会话；而
     * `conversation.session.header.actions` 是 session 作用域的 list slot。
     *
     * @param {object} props - slot props。
     * @returns {object} React 元素。
     */
    function SessionPanel({ ctx, sessionId }) {
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState({})

      /**
       * 执行一条命令。
       *
       * 命令结果以 flow 节点渲染，不回传文本；这里只关心是否被接收。
       */
      const run = useCallback(
        async line => {
          // 浏览器侧要求先在 inject 里声明 'sessions' 才能直接访问。
          const live = ctx.sessions?.binding?.(sessionId)?.session
          if (!live) {
            setStatus({ kind: 'error', text: '当前会话尚未就绪' })
            return false
          }
          setBusy(true)
          setStatus(null)
          try {
            const result = await live.command(line)
            if (result?.error) {
              setStatus({ kind: 'error', text: String(result.error.message ?? result.error) })
              return false
            }
            if (!result?.value?.matched) {
              setStatus({ kind: 'error', text: 'Host 未提供 /sandbox-tune 命令' })
              return false
            }
            setStatus({ kind: 'ok', text: '已提交' })
            return true
          } catch (error) {
            setStatus({ kind: 'error', text: String(error?.message ?? error) })
            return false
          } finally {
            setBusy(false)
          }
        },
        [ctx, sessionId],
      )

      /** 提交单个字段。 */
      const submitField = useCallback(
        (field, value) => {
          let rendered
          if (field.kind === 'bool') rendered = String(value)
          else if (field.kind === 'list') rendered = (value ?? []).join(',')
          else rendered = String(value ?? '')
          return run(`/sandbox-tune set ${field.key} ${rendered}`.trim())
        },
        [run],
      )

      const close = useCallback(() => {
        setOpen(false)
        setStatus(null)
      }, [])

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dsc-hbtn',
            onClick: () => setOpen(true),
            title: '本会话的沙箱调优设置',
          },
          '沙箱调优',
        ),
        h(
          Modal,
          {
            open,
            onClose: close,
            title: '沙箱调优 · 本会话',
            closeLabel: '关闭',
            description: '只影响当前会话。列表字段（预设 / 目录 / 环境变量）会叠加到全局之上，不会替换；标量字段（模式 / 缓存目录）会替换全局值。清除后回到全局。',
            className: 'dsc-modal',
            footer: h(
              'div',
              { className: 'dsc-modal-footer' },
              h(
                'div',
                { className: 'dsc-modal-footer-left' },
                h(
                  'button',
                  { type: 'button', className: 'dsc-btn', disabled: busy, onClick: () => run('/sandbox-tune') },
                  '查看当前',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsc-btn dsc-btn-danger',
                    disabled: busy,
                    onClick: async () => {
                      setDraft({})
                      await run('/sandbox-tune reset')
                    },
                  },
                  '清除覆盖',
                ),
              ),
              status
                ? h('span', { className: 'dsc-status', 'data-kind': status.kind }, status.text)
                : null,
            ),
          },
          h(
            'div',
            { className: 'dsc-form' },
            ...SESSION_FIELDS.map(field =>
              h(
                'div',
                { key: field.key, className: 'dsc-field' },
                h(
                  'div',
                  { className: 'dsc-field-head' },
                  h('span', { className: 'dsc-field-label' }, field.label),
                  h('code', { className: 'dsc-field-key' }, field.key),
                ),
                field.kind === 'enum' || field.kind === 'bool'
                  ? h(
                      'div',
                      { className: 'dsc-seg' },
                      (field.kind === 'bool' ? ['true', 'false'] : field.options).map(option =>
                        h(
                          'button',
                          {
                            key: option,
                            type: 'button',
                            className: 'dsc-seg-btn',
                            'data-active': String((draft[field.key] ?? '') === option),
                            disabled: busy,
                            onClick: () => {
                              setDraft(d => ({ ...d, [field.key]: option }))
                              submitField(field, option)
                            },
                          },
                          field.kind === 'bool' ? (option === 'true' ? '开' : '关') : option,
                        ),
                      ),
                    )
                  : field.kind === 'list'
                    ? h(ListEditor, {
                        field,
                        items: draft[field.key],
                        busy,
                        placeholder: field.placeholder,
                        // 列表编辑器的每次增删都直接提交，不做本地暂存：
                        // 界面显示必须与真实配置一致。
                        onCommit: next => {
                          setDraft(d => ({ ...d, [field.key]: next }))
                          submitField(field, next)
                        },
                      })
                    : h('input', {
                        className: 'dsc-input',
                        type: 'text',
                        disabled: busy,
                        placeholder: field.placeholder ?? '',
                        value: (draft[field.key] ?? '').toString(),
                        onChange: event => setDraft(d => ({ ...d, [field.key]: event.target.value })),
                        onKeyDown: event => {
                          if (event.key === 'Enter') submitField(field, event.target.value)
                        },
                      }),
              ),
            ),
            h(
              'div',
              { className: 'dsc-modal-note' },
              h('span', { className: 'dsc-scope-badge' }, '仅全局'),
              h(
                'span',
                null,
                '命令授权（autoApproveMode / 规则）不支持按会话设置：它放宽的是完全访问权限，必须显式开启。',
              ),
            ),
          ),
        ),
      )
    }

    function apply(ctx) {
      // 样式只注入一次，卸载时移除。
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-sandbox-tune'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-sandbox-tune: styles')

      // 会话头部的入口：session 作用域，组件与 inject 都能拿到 sessionId。
      // 设置页是全局面板拿不到会话，所以会话级设置放在这里。
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'sandbox-tune-session',
            order: 30,
            // 组件本身会收到 sessionId 作为标准 Session prop，
            // 这里不重复注入，避免两处来源不一致。
          },
          props => h(SessionPanel, { ctx, sessionId: props.sessionId }),
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'sandbox-tune',
            order: 13,
            label: '沙箱调优',
          },
          () => h(Section, { ctx }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-sandbox-tune'
    return module.exports
  },
})
