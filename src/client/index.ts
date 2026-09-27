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

import { renderModelToggles, type ProviderCardOwnerProps } from "./model-toggles.js";

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

/** 与 Host 侧保持一致的常量（改这里必须同步改 `../product.ts`）。 */
const PROVIDER_ID = "zcode-bridge";
const SETTINGS_NS = "zcode-bridge";
const DISABLED_MODELS_KEY = "disabledModels";

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
 * `settings` 走 `ctx.get()` 可选取用 —— 静态注入会让插件在缺该服务的
 * 环境里永久 pending，进而整个 profile 加载失败。
 */
export const inject = ["slots"];

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

  ctx.slots.inject("settings.models.provider-card", () =>
    ctx.slots.register(
      {
        name: "settings.models.provider-card",
        id: "zcode-bridge-model-toggles",
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
          },
          { ...(ctx.logger === undefined ? {} : { logger: ctx.logger }) },
        )) as never,
    ),
  );
}
