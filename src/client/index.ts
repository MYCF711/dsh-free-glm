/**
 * DSH 客户端插件入口 —— 把模型开关挂进原生模型设置页。
 *
 * ## 怎么被加载
 *
 * `package.json` 里声明 `dsh.client = { platform: "web" }`，
 * 并导出 `./client`。DSH 的 web 前端会把它作为浏览器侧插件加载。
 *
 * ## 与主插件的关系
 *
 * 主插件（`lib/index.js`）跑在 Host，负责 provider 注册与适配器；
 * 本模块跑在浏览器，只负责设置页的 UI。两者通过 **settings** 通信：
 *   - UI 读：`SettingsDescribeMirror` 的 `namespace("zcode-bridge")`
 *   - UI 写：`settings.mutate`（路径操作，不重述整个 section）
 *   - 主插件：适配器 `listModels()` 实时读同一份 section 的 `disabledModels`
 *
 * **不需要自建 RPC** —— DSH 的 settings wire 已经覆盖读写两向。
 */

import type { Context } from "@deepseek-ai/cordis";

import {
  renderModelToggles,
  type AccountStatus,
  type ModelToggleDeps,
  type ProviderCardOwnerProps,
} from "./model-toggles.js";

/**
 * `ModelToggleDeps` 里 `accounts` 那一支的类型。
 *
 * 单独取名只是为了让 `makeAccountDeps` 的返回类型可读 ——
 * 它必须与 `ModelToggleDeps.accounts` **完全同构**（多一个字段少一个都不行）。
 */
type ModelToggleDepsHooks = ModelToggleDeps["accounts"];

/**
 * `ctx.slots` 是 `@deepseek-ai/dsh-client-ui-slots` 通过模块增强加到
 * `@deepseek-ai/cordis` 的 `Context` 上的。本插件不依赖那个包（它由 DSH
 * 前端提供），所以在这里就地声明用到的那两个方法。
 *
 * 只声明 `inject` 与 `register` —— 它们已由 codearts-auth 的客户端插件
 * 实测跑通（`lib/client/jet-hub.js:1546`）。
 */
declare module "@deepseek-ai/cordis" {
  interface Context {
    readonly slots: {
      inject<T>(name: string, factory: () => T): void;
      register<T>(def: Record<string, unknown>, component: (props: never) => T): unknown;
    };
  }
}

/** 与 Host 侧保持一致的常量（改这里必须同步改 `../product.ts` / `../bridge-rpc.ts`）。 */
const PROVIDER_ID = "zcode-bridge";
const SETTINGS_NS = "zcode-bridge";
const DISABLED_MODELS_KEY = "disabledModels";
/** RPC 通道名 —— 必须与 `../bridge-rpc.ts` 的 `RPC_CHANNEL` 一致。 */
const RPC_CHANNEL = "zcode-bridge";

/** 静态模型表（与 Host 侧 `../product.ts` 的 MODELS 一致）。 */
const MODELS = [
  { id: "GLM-5.3", name: "GLM-5.3" },
  { id: "GLM-5.3-Flash", name: "GLM-5.3-Flash" },
] as const;

/** 客户端插件名。 */
export const name = "zcode-bridge-client";

/**
 * 静态注入。
 *
 * `slots` 是挂 UI 必需的（`ctx.slots.inject` / `ctx.slots.register`）。
 * `settings` / `connection` 走 `ctx.get()` 可选取用 —— 静态注入会让插件在
 * 缺该服务的环境里永久 pending，进而整个 profile 加载失败。
 */
export const inject = ["slots"];

/**
 * 客户端侧的最小 connection 面。
 *
 * 照抄 `dsh-codearts-auth` 的用法（`lib/client/jet-hub.js`）：
 *
 * ```js
 * connection.rpc.call("/api", ENDPOINT, { method, payload }, timeoutSignal)
 * ```
 *
 * ⚠ 返回值是 **RPC 信封**，要经 `unwrapRpcResult` 剥一层才能拿到业务值。
 */
interface ClientConnection {
  readonly rpc?: {
    call?: (
      path: string,
      channel: string,
      body: { method: string; payload?: unknown },
      signal?: AbortSignal,
    ) => Promise<unknown>;
  };
}

/** 剥掉 RPC 信封，取出业务结果。 */
function unwrapRpcResult(raw: unknown): { ok: boolean; value?: unknown; error?: { message?: string } } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: { message: "RPC 返回了非法结构" } };
  }
  const rec = raw as Record<string, unknown>;
  // DSH 的信封形如 `{ type:"server-response", result:{ ok, value, error } }`，
  // 也兼容直接返回业务对象的形态（实测两种都出现过）。
  const inner = rec["result"];
  if (inner !== null && typeof inner === "object") {
    return inner as { ok: boolean; value?: unknown; error?: { message?: string } };
  }
  return rec as { ok: boolean; value?: unknown; error?: { message?: string } };
}

/** 从 settings 快照里读黑名单。 */
function readDisabled(
  settings: ClientSettings | undefined,
): Record<string, Record<string, boolean>> {
  try {
    const view = settings?.describe?.().find((row) => row.ns === SETTINGS_NS);
    const value = view?.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const raw = (value as Record<string, unknown>)[DISABLED_MODELS_KEY];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    const out: Record<string, Record<string, boolean>> = {};
    for (const [provider, per] of Object.entries(raw as Record<string, unknown>)) {
      if (per === null || typeof per !== "object" || Array.isArray(per)) {
        continue;
      }
      out[provider] = per as Record<string, boolean>;
    }
    return out;
  } catch {
    return {};
  }
}

/** 客户端 settings 服务的最小面。 */
interface ClientSettings {
  describe?: () => readonly { ns: string; value?: unknown }[];
  mutate?: (
    ns: string,
    ops: readonly { op: "set" | "unset"; path: readonly string[]; value?: unknown }[],
  ) => Promise<unknown>;
}

/**
 * 写某个模型的可见性。
 *
 * 用 `mutate` 的**路径操作**而不是 `replace`：
 *   - `replace` 会重述整个 section，而客户端只持有 REDACTED 视图 ——
 *     任何被脱敏的字段都会在写回时丢失（官方注释明确警告过这一点）
 *   - 关闭 → `set [disabledModels, provider, modelId] = true`
 *   - 打开 → `unset [disabledModels, provider, modelId]`（删键而非写 false）
 */
async function writeDisabled(
  settings: ClientSettings | undefined,
  modelId: string,
  disabled: boolean,
): Promise<void> {
  if (settings === undefined || typeof settings.mutate !== "function") {
    throw new Error("settings 服务不可用，无法保存模型可见性");
  }
  const path = [DISABLED_MODELS_KEY, PROVIDER_ID, modelId] as const;
  await settings.mutate(SETTINGS_NS, [
    disabled
      ? { op: "set", path: [...path], value: true }
      : { op: "unset", path: [...path] },
  ]);
}

/** 客户端插件入口。 */
export function apply(ctx: Context): void {
  const settings = ctx.get("settings") as ClientSettings | undefined;
  const connection = ctx.get("connection") as ClientConnection | undefined;

  ctx.slots.inject("settings.models.provider-card", () =>
    ctx.slots.register(
      {
        name: "settings.models.provider-card",
        /**
         * ⚠ **必须用 `key` 而不是 `id`**（2026-09-29 实测纠正）。
         *
         * `settings.models.provider-card` 是 `kind: "keyed"` 的槽
         *（`dsh-client-ui-settings-models/lib/client.js` 的槽声明：）。
         * keyed 槽的注册**必须**传 `options.key` —— 传别的名字会被忽略，
         * 而 `dsh-client-ui-slots` 对缺 `key` 的情况直接抛错：
         *
         * ```js
         * case "keyed": {
         *   if (options.key === void 0)
         *     throw new Error(`keyed slot "${options.name}" requires options.key`);
         * ```
         *
         * 而 renderer 的匹配判据也只认 `options.key`：
         *
         * ```js
         * if (spec.kind === "keyed") {
         *   const entry = host.entriesOfSlot(slotKey)
         *     .find((e) => e.options.key === opts?.entryKey);
         *   if (!entry) return ...null;      // ← 永远 miss 就在这里
         * ```
         *
         * 官方三处 `renderSlot` 传的 `entryKey` **都是 `row.entry.settingsNs`**：
         *
         * ```js
         * renderSlot("settings.models.provider-card", { provider, configured, keyConfigured },
         *            { entryKey: row.entry.settingsNs })
         * ```
         *
         * ⇒ 所以本插件必须用 `key: SETTINGS_NS`。
         *
         * ## 早先为什么是 `id`
         *
         * 参照实现 `dsh-codearts-auth/lib/client/jet-hub.js` 用的是 `id` ——
         * 但它挂的是 **`settings.section`，那是 `kind: "list"` 的槽**，
         * list 槽的 cell 才用 `options.id`。**两者规则不同，不能照搬。**
         *
         * 速查：`keyed` → `key`；`list` → `id`；`single` → 都不用。
         */
        key: SETTINGS_NS,
      },
      // 宿主把 owner props 作为参数传入。
      ((props: ProviderCardOwnerProps) =>
        renderModelToggles(
          props,
          {
            providerId: PROVIDER_ID,
            settingsNs: SETTINGS_NS,
            // 全量目录（**不过滤**）—— 若拿过滤后的目录，被关闭的模型
            // 会连开关一起消失，用户再也无法重新打开。
            listAllModels: () => MODELS,
            isDisabled: (modelId: string) =>
              readDisabled(settings)[PROVIDER_ID]?.[modelId] === true,
            setDisabled: (modelId: string, disabled: boolean) =>
              writeDisabled(settings, modelId, disabled),
            // ★ 账号管理三个按钮 —— 走 Host 侧 RPC（见 `../bridge-rpc.ts`）。
            accounts: makeAccountDeps(connection, ctx),
          },
          { ...(ctx.logger === undefined ? {} : { logger: ctx.logger }) },
        )) as never,
    ),
  );
}

/**
 * 构造客户端侧的账号操作依赖 —— 每个操作转成一次 RPC 调用。
 *
 * ## 通道契约（照抄 `dsh-codearts-auth` 的用法）
 *
 * ```js
 * connection.rpc.call("/api", ENDPOINT, { method, payload }, signal)
 * ```
 *
 * 通道名与 Host 侧 `../bridge-rpc.ts` 的 `RPC_CHANNEL` 必须一致。
 *
 * ## 为什么每个方法都包 try/catch
 *
 * RPC 失败（Host 未注册端点、网络异常、桥不可达）不该让 UI 抛异常 ——
 * 三个按钮各自独立，一个失败不能让另外两个不可用。失败统一转成
 * `{ ok: false, message }`，由面板显示成一行红字。
 */
function makeAccountDeps(
  connection: ClientConnection | undefined,
  ctx: Context,
): NonNullable<ModelToggleDepsHooks> {
  const call = async (
    method: string,
    payload?: unknown,
  ): Promise<{ ok: boolean; message: string }> => {
    const rpc = connection?.rpc?.call;
    if (typeof rpc !== "function") {
      return { ok: false, message: "Host 侧 RPC 通道不可用（connection 服务未注入）" };
    }
    try {
      const raw = await rpc(
        "/api",
        RPC_CHANNEL,
        { method, ...(payload === undefined ? {} : { payload }) },
        typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(120_000) : undefined,
      );
      const result = unwrapRpcResult(raw);
      if (result.ok !== true) {
        return {
          ok: false,
          message: result.error?.message ?? "请求失败（Host 未返回原因）",
        };
      }
      // Host 侧 `value` 的形状是 `{ ok, message }`（见 bridge-rpc.ts）。
      const value = result.value as { ok?: unknown; message?: unknown } | undefined;
      if (value !== null && typeof value === "object") {
        return {
          ok: value.ok === true,
          message: typeof value.message === "string" ? value.message : "已完成",
        };
      }
      return { ok: true, message: "已完成" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`[zcode-bridge] RPC ${method} 失败: ${message}`);
      return { ok: false, message: `调用失败：${message}` };
    }
  };

  return {
    status: async () => {
      const rpc = connection?.rpc?.call;
      if (typeof rpc !== "function") {
        return undefined;
      }
      try {
        const raw = await rpc(
          "/api",
          RPC_CHANNEL,
          { method: "status" },
          typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(30_000) : undefined,
        );
        const result = unwrapRpcResult(raw);
        if (result.ok !== true) {
          return undefined;
        }
        return result.value as AccountStatus | undefined;
      } catch {
        return undefined;
      }
    },
    addAccount: () => call("addAccount"),
    checkin: () => call("checkin"),
    startAutoClaim: () => call("startAutoClaim"),
    autoClaimRunning: () => false,
  };
}
