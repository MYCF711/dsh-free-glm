/**
 * 模型设置页组件 —— 挂在**原生模型设置区**的 provider 卡片里。
 *
 * ## 用户要求
 *
 * 「把模型显示页面直接插入到设置的模型中作为模型供应商显示，
 *   展开后直接显示模型名称，右边增加原点拨动开关，实时生效」
 *
 * ## 挂载点
 *
 * `settings.models.provider-card` 是 DSH 官方模型设置页声明给外部插件的
 * 扩展槽（`dsh-client-ui-settings-models` 的 slot-contract）。
 *
 * 它在**三处** dispatch（实测 `lib/client.js` offset 104602 / 107712 / 112009）：
 *   1. 首次配置的 setup card
 *   2. 已保存的行
 *   3. 新增 provider 的草稿卡
 *
 * 三处都用同一个 props 形状：
 *   ```js
 *   renderSlot("settings.models.provider-card",
 *     { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
 *     { entryKey: row.entry.settingsNs })
 *   ```
 * **`entryKey` 是我们的 settingsNs** —— 只在自己的卡片里渲染，不干扰别人。
 *
 * ## 为什么不用 React
 *
 * 宿主页面是 React，但这个扩展槽只要求「一个渲染函数」。用原生 DOM
 * 可以完全避开对 React 版本/JSX 构建的耦合 —— 插件的 `lib/` 是纯 tsc
 * 产物，没有 JSX 编译步骤。
 *
 * ## 「实时生效」的实现
 *
 * 开关写入 → 宿主 `settings` 落盘 + 适配器进程内副本更新。
 * 模型选择器下次打开时调 `listModels()`，读到的是**过滤后的新目录**。
 * 不需要任何事件广播 —— 见 `adapter.ts` 的 `listModels()`。
 *
 * 本组件只负责把「全量目录 + 开关状态」渲染出来。全量目录必须走
 * `listAllModels()`（不过滤），否则被关闭的模型会连开关一起消失，
 * 用户再也无法重新打开。
 */

/** 组件收到的 owner props（由宿主 dispatch 注入）。 */
export interface ProviderCardOwnerProps {
  /** 该卡片的目录行。 */
  readonly provider: {
    readonly provider: string;
    readonly displayName: string;
    readonly settingsNs: string;
    readonly settingsPath: readonly string[];
    readonly active: boolean;
    readonly declared?: boolean;
    readonly error?: string;
  };
  /** 是否有任一配置层配置了该 provider。 */
  readonly configured: boolean;
  /** 引用的 api-key 凭据是否已配置。 */
  readonly keyConfigured: boolean;
}

/** 客户端上下文里我们用到的最小面。 */
export interface ClientCtx {
  readonly logger?: { info?: (m: unknown) => void; warn?: (m: unknown) => void };
  readonly get?: (name: string) => unknown;
}

/** 宿主注入的依赖（由 apply 时的闭包提供）。 */
export interface ModelToggleDeps {
  /** 本 provider 的路由名。 */
  readonly providerId: string;
  /** 本插件的 settings namespace（用于判断是否该渲染）。 */
  readonly settingsNs: string;
  /** 全量模型目录（不过滤）。 */
  listAllModels: () => readonly { id: string; name: string }[];
  /** 某 model 当前是否被关闭。 */
  isDisabled: (modelId: string) => boolean;
  /** 打开/关闭某 model。 */
  setDisabled: (modelId: string, disabled: boolean) => Promise<void>;
}

/**
 * 组件样式。
 *
 * 尽量用宿主已有的 CSS 变量（`--dsw-alias-*`），这样跟随主题；
 * 取不到时回落到中性值，深浅色都不至于不可读。
 */
const STYLE_ID = "zcode-bridge-model-toggle-style";
const STYLES = `
.zcb-toggles { display: flex; flex-direction: column; gap: 2px; margin: 8px 0 4px; }
.zcb-toggles[data-inline="false"] { margin: 12px 0; }
.zcb-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 7px 10px; border-radius: 6px;
  transition: background-color .12s ease;
}
.zcb-row:hover { background: var(--dsw-alias-bg-layout-secondary, rgba(127,127,127,.08)); }
.zcb-row[data-busy="true"] { opacity: .55; }
.zcb-info { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.zcb-name {
  font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.zcb-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #888); opacity: .85;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 拨动开关：原点式（一个圆点在一个胶囊里滑动） */
.zcb-switch {
  appearance: none; -webkit-appearance: none;
  position: relative; flex: 0 0 auto;
  width: 34px; height: 18px; margin: 0; border-radius: 9px; cursor: pointer;
  background: var(--dsw-alias-border-default, rgba(127,127,127,.45));
  transition: background-color .15s ease;
}
.zcb-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: transform .15s ease;
}
.zcb-switch:checked { background: var(--dsw-alias-brand-primary, #2f6fed); }
.zcb-switch:checked::after { transform: translateX(16px); }
.zcb-switch:disabled { cursor: default; }
.zcb-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #2f6fed); outline-offset: 2px; }
.zcb-error {
  font-size: 12px; color: var(--dsw-alias-label-error, #d93025);
  padding: 4px 10px;
}
.zcb-empty {
  font-size: 12px; color: var(--dsw-alias-label-secondary, #888);
  padding: 4px 10px;
}
`;

/** 安装样式（幂等）。 */
function installStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/**
 * 渲染 provider 卡片里的模型开关区。
 *
 * 返回一个 DOM 元素；宿主把它插进卡片。
 */
export function renderModelToggles(
  props: ProviderCardOwnerProps,
  deps: ModelToggleDeps,
  ctx: ClientCtx,
): HTMLElement | null {
  // 只渲染自己的卡片 —— 别人的 settingsNs 不归我们管。
  if (props?.provider?.settingsNs !== deps.settingsNs) {
    return null;
  }

  installStyles();

  const root = document.createElement("div");
  root.className = "zcb-toggles";
  root.dataset.inline = "true";
  root.setAttribute("data-zcode-bridge-toggles", "true");

  const models = deps.listAllModels();
  if (models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "zcb-empty";
    // 模型为空通常意味着壳（ZCode 实例）没在跑 —— 如实说明，
    // 而不是显示一个没有内容的空框让用户困惑。
    empty.textContent = "暂无可显示的模型（ZCode 实例可能未运行）";
    root.appendChild(empty);
    return root;
  }

  for (const model of models) {
    const row = document.createElement("div");
    row.className = "zcb-row";

    const info = document.createElement("div");
    info.className = "zcb-info";

    const name = document.createElement("span");
    name.className = "zcb-name";
    // 「展开后直接显示模型名称」—— 这里就是那行名字。
    name.textContent = model.name || model.id;
    info.appendChild(name);

    // id 与 name 不同时才补一行 id，避免重复信息。
    if (model.id && model.id !== model.name) {
      const id = document.createElement("code");
      id.className = "zcb-id";
      id.textContent = model.id;
      info.appendChild(id);
    }

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "zcb-switch";
    toggle.setAttribute("role", "switch");
    toggle.checked = !deps.isDisabled(model.id);
    toggle.setAttribute(
      "aria-label",
      `${model.name || model.id} 是否在模型选择中显示`,
    );

    toggle.addEventListener("change", () => {
      const next = !toggle.checked; // 关闭 = 取消勾选
      row.dataset.busy = "true";
      toggle.disabled = true;
      void deps
        .setDisabled(model.id, next)
        .catch((error: unknown) => {
          // 写失败要把 UI 拨回去 —— 否则界面显示的状态与真实状态不一致。
          toggle.checked = !next;
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`[zcode-bridge] 切换模型可见性失败: ${message}`);
          const err = document.createElement("div");
          err.className = "zcb-error";
          err.textContent = `切换失败：${message}`;
          row.appendChild(err);
          setTimeout(() => err.remove(), 5000);
        })
        .finally(() => {
          row.dataset.busy = "false";
          toggle.disabled = false;
        });
    });

    row.appendChild(info);
    row.appendChild(toggle);
    root.appendChild(row);
  }

  return root;
}
