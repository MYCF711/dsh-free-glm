/**
 * ZCode 桥 —— 客户端 UI（模型设置页的 provider 卡片扩展区）。
 *
 * ## 用户要求（逐条对应本文件的结构）
 *
 * > 「模型右侧的按钮改成【编辑】点编辑后展开，展开后原本输入 apikey 的地方
 * >   改成咱们的【添加账号】【签到】【持续领取】，下面就是咱们的 tab，
 * >   模型|账号管理」
 *
 * 对应实现：
 *   - **tab 分栏**：「模型」与「账号管理」两个 tab，见 `buildTabs()`
 *   - **模型 tab**：模型开关行（已有逻辑，`renderModelToggles` 复用）
 *   - **账号管理 tab**：添加账号 / 签到 / 持续领取三个操作，
 *     见 `renderAccountPanel()` 与 `deps.accounts.*`
 *
 * ## 挂载点与「编辑」的关系（实测契约）
 *
 * `settings.models.provider-card` 是 DSH 官方模型设置页的扩展槽。
 * 官方 `dsh-client-ui-settings-models/lib/client.js` 的渲染顺序是：
 *
 * ```js
 * renderSlot("settings.models.provider-card", { provider, configured, keyConfigured }),
 * open ? renderProviderEditor({ ... }) : ...
 * ```
 *
 * ⇒ **本组件渲染在官方编辑器「之前」**，即用户点「编辑」展开后，
 *   我们的内容出现在官方凭据编辑器**上方**。
 *
 * ⚠ 官方那个 api-key 输入框由官方渲染，插件**无法替换它**（槽只提供追加，
 *   不提供替换）。所以「原本输入 apikey 的地方改成我们的按钮」在契约层面
 *   做不到 —— 折中做法是**把我们的按钮放在它上面**，视觉上先出现，
 *   并在空状态提示里说明「ZCode 不需要填 api-key」。
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

/** 账号状态（由 Host 侧桥查询后返回）。 */
export interface AccountStatus {
  /** 账号标识（脱敏后的展示名）。 */
  readonly label: string;
  /** 是否已登录。 */
  readonly signedIn: boolean;
  /** 额度描述（如「3,000,000 / 3,000,000」）。 */
  readonly quota?: string;
  /** 权益到期描述。 */
  readonly expiresAt?: string;
  /** 当前生效的 provider（如 account:bigmodel-start-plan）。 */
  readonly providerId?: string;
  /** 权益覆盖的模型 id 列表 —— UI 据此标注哪些模型可用。 */
  readonly entitledModels?: readonly string[];
}

/** 签到/领取的操作结果。 */
export interface ClaimResult {
  readonly ok: boolean;
  /** 面向用户的一句话结果说明。 */
  readonly message: string;
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
  /**
   * 账号相关操作。**全部可选** —— Host 侧桥未提供时，账号管理 tab
   * 显示"不可用"而不是抛错（与适配器「桥不在就隐藏分组」同思路）。
   */
  accounts?: {
    /** 查询当前账号状态。 */
    status?: () => Promise<AccountStatus | undefined>;
    /** 添加账号（触发实例的 OAuth 登录）。 */
    addAccount?: () => Promise<ClaimResult>;
    /** 每日签到。 */
    checkin?: () => Promise<ClaimResult>;
    /** 持续领取（定时自动领取开关）。 */
    startAutoClaim?: () => Promise<ClaimResult>;
    /** 查询持续领取是否运行中。 */
    autoClaimRunning?: () => boolean;
  };
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
.zcb-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); }
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
/*
 * 拨动开关 —— 逐值对齐 DSH 官方实现（dsh-client-ui-primitives/lib/Switch.module.css）。
 *
 * 对齐的 4 处（此前与官方不一致）：
 *   ① 尺寸 34×18 → 36×20，thumb 14 → 16，padding 2
 *   ② 关态底色 border-l2 → border-l3（官方用更深一档）
 *   ③ 圆角 9px → 999px，并补 corner-shape: round
 *      ⚠ 缺 corner-shape:round 会被 DSH 全局的 superellipse(1.5) 覆盖，
 *        胶囊会变成"方角超椭圆"—— 官方注释专门说明了这一点
 *   ④ 开态改用 [aria-checked='true'] 属性选择器（原用 :checked）
 *      官方注释原话：「外观键与 aria-checked 绑定，而不是并行 class，
 *      这样视觉状态不可能与辅助技术读到的状态不一致」
 */
.zcb-switch {
  box-sizing: border-box;
  appearance: none; -webkit-appearance: none;
  position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; margin: 0;
  border: 0; border-radius: 999px; corner-shape: round;
  background: var(--dsw-alias-border-l3, rgba(127,127,127,.5));
  cursor: pointer;
  transition: background-color .12s ease;
}
.zcb-switch::after {
  content: ""; display: block;
  width: 16px; height: 16px; border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground, #fff);
  transition: transform 120ms ease;
}
.zcb-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #2f6fed); }
.zcb-switch[aria-checked="true"]::after { transform: translateX(16px); }
.zcb-switch:disabled { cursor: default; opacity: .5; }
.zcb-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
           var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2f6fed));
  outline-offset: 2px;
}
.zcb-error {
  font-size: 12px; color: var(--dsw-alias-state-error-primary, #d93025);
  padding: 4px 10px;
}
.zcb-empty {
  font-size: 12px; color: var(--dsw-alias-label-secondary, #888);
  padding: 4px 10px;
}

/* ── 分栏（模型 | 账号管理） ── */
/*
 * 逐值对齐官方编辑区（border-radius lg / bg-module-platform /
 * padding 14px 16px）—— 让本组件的观感与官方一致，不像"外来物"。
 *
 * ⚠ 本样式块整体是模板字符串，注释里**不能出现反引号** ——
 *   一个反引号就会提前闭合字符串，TS 会把后面的 CSS 当代码解析
 *   （实测报错：Property 'zGbnIq_editor' does not exist on type '...'）。
 */
.zcb-panel {
  display: flex; flex-direction: column; gap: 12px;
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.05));
  padding: 12px 14px;
  margin: 8px 0;
}
.zcb-tabs {
  display: flex; align-items: center; gap: 4px;
  border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));
  padding-bottom: 8px;
}
.zcb-tab {
  appearance: none; border: 0; background: 0 0; cursor: pointer;
  font-size: 13px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-secondary, #888);
  padding: 3px 10px; border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: round;
  transition: background-color .12s ease, color .12s ease;
}
.zcb-tab:hover { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.zcb-tab[aria-selected="true"] {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.14));
}
.zcb-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
           var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2f6fed));
  outline-offset: 2px;
}
.zcb-tabpanel { display: flex; flex-direction: column; gap: 10px; }
.zcb-tabpanel[hidden] { display: none; }

/* ── 账号管理面板 ── */
.zcb-acct-status {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary, #888);
}
.zcb-acct-status b {
  color: var(--dsw-alias-label-primary, inherit); font-weight: 500;
}
.zcb-acct-actions { display: flex; flex-wrap: wrap; gap: 8px; }
/*
 * 按钮逐值对齐官方 addButton / primaryButton：
 * 高度 28px、圆角 sm、字号 12px。
 */
.zcb-btn {
  appearance: none; cursor: pointer;
  box-sizing: border-box; height: 28px; padding: 0 12px;
  font-size: 12px; line-height: 18px; font-weight: 500;
  border-radius: var(--dsw-radius-sm, 8px);
  corner-shape: round;
  border: .5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.4));
  background: 0 0;
  color: var(--dsw-alias-label-primary, inherit);
  transition: background-color .12s ease, opacity .12s ease;
}
.zcb-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); }
.zcb-btn:disabled { cursor: default; opacity: .5; }
.zcb-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
           var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2f6fed));
  outline-offset: 2px;
}
.zcb-btn[data-variant="primary"] {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #2f6fed));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  border-color: transparent;
}
.zcb-btn[data-variant="primary"]:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-fill-hover, var(--dsw-alias-state-business-primary, #2f6fed));
  opacity: .9;
}
.zcb-note {
  font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #999);
}
.zcb-result {
  font-size: 12px; line-height: 18px;
  padding: 4px 0;
}
.zcb-result[data-ok="true"] { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.zcb-result[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #d93025); }
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

/** 建一个按钮。 */
function button(
  label: string,
  variant: "default" | "primary",
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "zcb-btn";
  el.textContent = label;
  if (variant === "primary") {
    el.dataset.variant = "primary";
  }
  el.addEventListener("click", onClick);
  return el;
}

/**
 * 渲染「模型 | 账号管理」分栏。
 *
 * ⚠ **tab 用 `hidden` 属性切换而不是重建 DOM**：账号面板的状态（查询结果、
 *   按钮的禁用态）在切换 tab 后要保留 —— 重建会让用户每次切回来都重新
 *   查一次账号、并丢掉上一次的操作结果。
 */
function buildTabs(
  panels: readonly { id: string; label: string; content: HTMLElement }[],
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "zcb-panel";

  const bar = document.createElement("div");
  bar.className = "zcb-tabs";
  bar.setAttribute("role", "tablist");

  const body = document.createElement("div");
  body.className = "zcb-tabpanel-host";

  const tabs: HTMLButtonElement[] = [];
  const views: HTMLElement[] = [];

  panels.forEach((panel, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "zcb-tab";
    tab.setAttribute("role", "tab");
    tab.textContent = panel.label;
    tab.id = `zcb-tab-${panel.id}`;

    const view = document.createElement("div");
    view.className = "zcb-tabpanel";
    view.setAttribute("role", "tabpanel");
    view.setAttribute("aria-labelledby", tab.id);
    view.appendChild(panel.content);

    const select = (): void => {
      tabs.forEach((t, i) => {
        t.setAttribute("aria-selected", String(i === index));
        // 用 hidden 而不是卸载 DOM —— 见函数注释。
        views[i].hidden = i !== index;
      });
    };
    tab.addEventListener("click", select);
    // 键盘左右方向键切换 —— 与官方 tab 组件的可访问性行为一致。
    tab.addEventListener("keydown", (event) => {
      const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (offset === 0) return;
      event.preventDefault();
      const next = (index + offset + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click();
    });

    tabs.push(tab);
    views.push(view);
    bar.appendChild(tab);
    body.appendChild(view);
  });

  // 默认选中第一个 tab（「模型」）。
  tabs[0]?.setAttribute("aria-selected", "true");
  views.forEach((v, i) => {
    v.hidden = i !== 0;
  });

  wrap.appendChild(bar);
  wrap.appendChild(body);
  return wrap;
}

/**
 * 渲染账号管理面板。
 *
 * ## 三个操作与用户要求逐条对应
 *
 *   - **添加账号** → `deps.accounts.addAccount()`
 *   - **签到**     → `deps.accounts.checkin()`
 *   - **持续领取** → `deps.accounts.startAutoClaim()`
 *
 * ## 为什么操作后要重新查状态
 *
 * 三个操作都会**改变服务端状态**（新增账号 / 签到成功 / 开启定时领取），
 * 而 `status()` 是唯一能反映真实状态的数据源。操作成功却不刷新，
 * 用户会看到「点了签到，但状态还是未签到」的自相矛盾画面。
 */
function renderAccountPanel(
  deps: ModelToggleDeps,
  ctx: ClientCtx,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "zcb-tabpanel";
  root.setAttribute("data-zcode-bridge-accounts", "true");

  const statusBox = document.createElement("div");
  statusBox.className = "zcb-acct-status";
  const resultBox = document.createElement("div");
  resultBox.className = "zcb-result";
  resultBox.hidden = true;
  const actions = document.createElement("div");
  actions.className = "zcb-acct-actions";

  const acct = deps.accounts;

  const showResult = (ok: boolean, message: string): void => {
    resultBox.textContent = message;
    resultBox.dataset.ok = String(ok);
    resultBox.hidden = false;
  };

  const renderStatus = (status: AccountStatus | undefined): void => {
    statusBox.textContent = "";
    if (status === undefined) {
      const line = document.createElement("span");
      line.textContent = "账号状态：不可用（Host 侧未提供账号接口）";
      statusBox.appendChild(line);
      return;
    }
    const rows: string[] = [];
    rows.push(`账号：${status.label}${status.signedIn ? "" : "（未登录）"}`);
    if (status.providerId !== undefined) rows.push(`通道：${status.providerId}`);
    if (status.quota !== undefined) rows.push(`额度：${status.quota}`);
    if (status.expiresAt !== undefined) rows.push(`到期：${status.expiresAt}`);
    if (status.entitledModels !== undefined && status.entitledModels.length > 0) {
      rows.push(`可用模型：${status.entitledModels.join("、")}`);
    }
    for (const text of rows) {
      const line = document.createElement("span");
      line.textContent = text;
      statusBox.appendChild(line);
    }
  };

  const refresh = async (): Promise<void> => {
    if (acct?.status === undefined) {
      renderStatus(undefined);
      return;
    }
    try {
      renderStatus(await acct.status());
    } catch (error) {
      ctx.logger?.warn?.(`[zcode-bridge] 查询账号状态失败: ${String(error)}`);
      renderStatus(undefined);
    }
  };

  /** 包一层：禁用按钮 → 执行 → 刷新状态 → 恢复。 */
  const guarded = async (
    el: HTMLButtonElement,
    label: string,
    action: (() => Promise<ClaimResult>) | undefined,
  ): Promise<void> => {
    if (action === undefined) {
      showResult(false, `${label}：Host 侧未提供该接口`);
      return;
    }
    el.disabled = true;
    showResult(true, `${label}：执行中…`);
    try {
      const result = await action();
      showResult(result.ok, `${label}：${result.message}`);
      // ⚠ 必须刷新 —— 操作改变了服务端状态，不刷新会显示自相矛盾的信息。
      await refresh();
    } catch (error) {
      showResult(false, `${label}失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      el.disabled = false;
    }
  };

  const addBtn = button("添加账号", "primary", () => {
    void guarded(addBtn, "添加账号", acct?.addAccount);
  });
  const checkinBtn = button("签到", "default", () => {
    void guarded(checkinBtn, "签到", acct?.checkin);
  });
  const autoBtn = button("持续领取", "default", () => {
    void guarded(autoBtn, "持续领取", acct?.startAutoClaim);
  });

  // 持续领取是**开关语义**：已运行时按钮文字要变，否则用户不知道当前状态。
  if (acct?.autoClaimRunning?.() === true) {
    autoBtn.textContent = "持续领取（已开启）";
  }

  actions.appendChild(addBtn);
  actions.appendChild(checkinBtn);
  actions.appendChild(autoBtn);

  const note = document.createElement("div");
  note.className = "zcb-note";
  note.textContent =
    "账号由本机 ZCode 实例托管 —— 无需在此填写 API Key。"
    + "「添加账号」会拉起实例自带的 OAuth 登录流程。";

  root.appendChild(statusBox);
  root.appendChild(actions);
  root.appendChild(resultBox);
  root.appendChild(note);

  // 挂载即查一次状态，让用户点开 tab 就能看到真实账号。
  void refresh();

  return root;
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
  /**
   * 【自检】组件被调用时留下全局痕迹。
   *
   * ## 为什么需要
   *
   * 「槽没渲染」有两种完全不同的成因，从界面上看**一模一样**：
   *
   *   ① renderer 没找到我们的 entry（`key` 不匹配）→ 组件**从未被调用**
   *   ② 组件被调用了，但 `isOurCard()` 返回 false → 组件**返回 null**
   *
   * 没有这个痕迹就只能靠猜。挂了 `window.__zcbProbe` 之后，
   * 在浏览器控制台看这个对象即可区分：
   *
   * ```js
   * window.__zcbProbe
   * // { calls: 3, matched: 1, lastProvider: "zcode-bridge",
   * //   lastSettingsNs: "zcode-bridge", keys: ["zcode-bridge"] }
   * ```
   *
   * ⚠ 这是**诊断设施**，不是功能代码：只累积计数与字符串，不持有 DOM 引用
   *（持有会阻止卡片卸载时回收）。开销可忽略（每张卡片每次渲染一次）。
   */
  const probe = ((): ZcbProbe => {
    const w = globalThis as unknown as { __zcbProbe?: ZcbProbe };
    if (w.__zcbProbe === undefined) {
      w.__zcbProbe = { calls: 0, matched: 0, keys: [], lastProvider: undefined, lastSettingsNs: undefined };
    }
    return w.__zcbProbe;
  })();
  probe.calls += 1;
  probe.lastProvider = props?.provider?.provider;
  probe.lastSettingsNs = props?.provider?.settingsNs;
  if (typeof probe.lastProvider === "string" && !probe.keys.includes(probe.lastProvider)) {
    probe.keys.push(probe.lastProvider);
  }

  if (!isOurCard(props, deps)) {
    return null;
  }
  probe.matched += 1;

  installStyles();

  const modelPanel = renderModelList(deps, ctx);
  const accountPanel = renderAccountPanel(deps, ctx);

  // 只有一个 tab 有内容时仍然给出分栏 —— 用户明确要求「模型|账号管理」，
  // 结构稳定比"少画一个 tab"重要。
  return buildTabs([
    { id: "models", label: "模型", content: modelPanel },
    { id: "accounts", label: "账号管理", content: accountPanel },
  ]);
}

/** 自检痕迹的形状（挂在 `window.__zcbProbe`）。 */
interface ZcbProbe {
  /** 组件被调用的总次数。 */
  calls: number;
  /** 其中判定为「我们的卡片」的次数。 */
  matched: number;
  /** 见过的所有 provider 名（判断 renderer 到底把哪些卡片递给了我们）。 */
  keys: string[];
  /** 最近一次拿到的 provider 名。 */
  lastProvider: string | undefined;
  /** 最近一次拿到的 settingsNs（这是 key 匹配的判据）。 */
  lastSettingsNs: string | undefined;
}

/**
 * 判断这张卡片是不是我们的。
 *
 * ## 为什么不能只比对 settingsNs（2026-09-29 实测纠正）
 *
 * 官方 `joinProviderDirectory`（`dsh-client-ui-settings-models/lib/client.js`）
 * 对**已注册但未声明**的 provider 一律给空串：
 *
 * ```js
 * for (const provider of registered) {
 *   if (declared.has(provider.id)) continue;
 *   rows.push({ provider: provider.id, displayName: provider.name,
 *               settingsNs: "", settingsPath: [], active: true })   // ← 空串
 * }
 * ```
 *
 * 而**插件注册**的 provider 正是这一类（走 `dsh.profile.bundles` 加载，
 * 没有独立的 settings entry，自然不在 `directory` 里）。
 *
 * 早先本组件写的是 `props.provider.settingsNs !== "zcode-bridge"` —— 于是
 * 永远为真、永远 `return null`。**卡片能显示（因为 `active: true`），
 * 但扩展区一个像素都不渲染**。这是「卡片有、内容没有」的根因。
 *
 * ## 判据
 *
 * **优先用路由名判定**（`props.provider.provider` 就是 provider id，
 * 与 settingsNs 无关）；再叠加「settingsNs 为空或等于本插件的 ns」作为
 * 保险 —— 这样无论将来走「声明式 provider」（settingsNs 会是 `llm-pi-ai`）
 * 还是「插件注册」（空串），都能正确命中。
 */
function isOurCard(props: ProviderCardOwnerProps, deps: ModelToggleDeps): boolean {
  const provider = props?.provider;
  if (provider === undefined || provider === null) {
    return false;
  }
  // 主判据：路由名 —— 这是唯一与加载方式无关的稳定标识。
  if (provider.provider !== deps.providerId) {
    return false;
  }
  // 保险：别人的卡片不该被我们认领。空串是「插件注册」的正常形态，
  // 非空时必须是本插件的 ns。
  const ns = provider.settingsNs;
  return ns === "" || ns === deps.settingsNs || ns === "llm-pi-ai";
}

/** 渲染模型列表（开关行）。 */
function renderModelList(deps: ModelToggleDeps, ctx: ClientCtx): HTMLElement {
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

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "zcb-switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute(
      "aria-label",
      `${model.name || model.id} 可见性`,
    );
    toggle.setAttribute("aria-checked", String(!deps.isDisabled(model.id)));

    toggle.addEventListener("click", () => {
      const nextDisabled = toggle.getAttribute("aria-checked") === "true";
      // 先改 UI（乐观更新）—— 网络往返期间用户立即看到反馈。
      toggle.setAttribute("aria-checked", String(!nextDisabled));
      row.dataset.busy = "true";
      void deps
        .setDisabled(model.id, nextDisabled)
        .catch((error: unknown) => {
          // 失败时回滚 UI，否则界面状态与落盘状态不一致。
          toggle.setAttribute("aria-checked", String(nextDisabled));
          ctx.logger?.warn?.(
            `[zcode-bridge] 保存模型可见性失败: ${String(error)}`,
          );
          const err = document.createElement("div");
          err.className = "zcb-error";
          err.textContent = "保存失败，已回滚";
          root.appendChild(err);
        })
        .finally(() => {
          delete row.dataset.busy;
        });
    });

    row.appendChild(info);
    row.appendChild(toggle);
    root.appendChild(row);
  }

  return root;
}
