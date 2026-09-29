/**
 * ZCode 桥的宿主侧 RPC —— 让设置页的客户端 UI 能操作账号。
 *
 * ## 为什么需要它
 *
 * 客户端插件跑在**浏览器**里，而三个账号操作（添加账号 / 签到 / 持续领取）
 * 只能由 **Host 侧**执行 —— 它们要读本机发现文件、调实例的 HTTP 桥。
 * 浏览器拿不到文件系统，必须有一条通道把请求转过来。
 *
 * ## 通道形态（照抄 dsh-codearts-auth 的既有模式）
 *
 * `dsh-codearts-auth` 用 DSH 的 `connection.fetch.register()` 注册一条
 * HTTP 端点，通道名 → 路径 `/api/<name>`。客户端用
 * `connection.rpc.call("/api", <channel>, { method, payload })` 调用。
 *
 * 本模块复用同一模式（**不自己发明协议**）：
 *
 * ```
 * Host   : connection.fetch.register({ path: <API_PATH>, methods:["POST"], ... })
 * Client : connection.rpc.call("/api", RPC_CHANNEL, { method, payload })
 * ```
 *
 * ## 端点方法
 *
 * | method | 作用 | 底层 |
 * |---|---|---|
 * | `status`        | 账号状态（额度 / 到期 / 权益模型） | `fetchBilling()` |
 * | `addAccount`    | 添加账号（拉起实例的 OAuth） | `requestCliLogin()` |
 * | `checkin`       | 每日签到（领取额度） | `requestClaim()` |
 * | `startAutoClaim`| 持续领取（定时自动领取） | `createQuotaGuard()` |
 *
 * ## 与「持续领取」的关系
 *
 * `quota-guard` 默认**已在主插件启动时运行**（见 `index.ts`）。本 RPC 的
 * `startAutoClaim` 是给用户一个**显式确认/重启**的入口 —— 若它已经在跑，
 * 返回"已在运行"而不是起第二个（两个 guard 会重复领取，服务端虽幂等，
 * 但会白白消耗 captcha 配额）。
 */

import type { Context } from "@deepseek-ai/cordis";

import {
  fetchBilling,
  requestClaim,
  requestCliLogin,
  type BillingData,
  type ClaimData,
  type CliLoginData,
} from "./bridge-ops.js";

/** RPC 通道名 —— 客户端必须用同一个值。 */
export const RPC_CHANNEL = "zcode-bridge";

/** 端点路径（DSH 会把它挂在 `/api/zcode-bridge`）。 */
export const RPC_PATH = "/api/zcode-bridge";

/** 一次 RPC 的请求体（与 dsh-codearts-auth 同形状）。 */
interface RpcRequest {
  readonly method?: unknown;
  readonly payload?: unknown;
}

/** 一次 RPC 的响应体。 */
interface RpcResponse {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** `status` 返回的形状 —— 与客户端 `AccountStatus` 对应。 */
interface AccountStatusValue {
  readonly label: string;
  readonly signedIn: boolean;
  readonly quota?: string;
  readonly expiresAt?: string;
  readonly providerId?: string;
  readonly entitledModels?: readonly string[];
}

/** 把大数字格式化成带千分位的形式（额度展示用）。 */
function formatUnits(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value).toLocaleString("en-US");
}

/**
 * 从 `fetchBilling()` 的结果里抽出账号状态。
 *
 * ⚠ 字段名以 `bridge-ops.ts` 的 `BillingData` 为准 —— 是**驼峰**
 * （`totalUnits` / `remainingUnits` / `planName` / `expiresAtLocal`），
 * 不是下划线。事件日志里那些下划线字段是上游原始响应，不是本类型。
 *
 * ⚠ 权益模型：`BillingData` 只有**单个** `modelName`（本 provider 的账号
 * 是「一个实例一份权益」模型），故权益集合是 `[modelName]` —— 而模型目录
 * 可能列多个，客户端据此标注哪些模型真正可用。
 */
function toAccountStatus(billing: BillingData): AccountStatusValue {
  const out: {
    label: string;
    signedIn: boolean;
    quota?: string;
    expiresAt?: string;
    providerId?: string;
    entitledModels?: readonly string[];
  } = {
    // 本 provider 的「账号」就是本机实例，没有传统意义上的用户名。
    label: "本机 ZCode 实例",
    // 有 planId/modelName 就说明实例已登录且有权益。
    signedIn:
      (typeof billing.planId === "string" && billing.planId.length > 0)
      || (typeof billing.modelName === "string" && billing.modelName.length > 0),
  };

  const remaining = formatUnits(billing.remainingUnits);
  const total = formatUnits(billing.totalUnits);
  if (remaining !== undefined || total !== undefined) {
    out.quota = `${remaining ?? "?"} / ${total ?? "?"}`;
  }
  if (typeof billing.expiresAtLocal === "string" && billing.expiresAtLocal.length > 0) {
    out.expiresAt = billing.expiresAtLocal;
  } else if (typeof billing.expiresAt === "number" && billing.expiresAt > 0) {
    // 服务端给的是毫秒时间戳；转成本地可读字符串。
    out.expiresAt = new Date(billing.expiresAt).toLocaleString("zh-CN");
  }
  if (typeof billing.planName === "string" && billing.planName.length > 0) {
    out.providerId = billing.planName;
  } else if (typeof billing.planId === "string" && billing.planId.length > 0) {
    out.providerId = billing.planId;
  }
  if (typeof billing.modelName === "string" && billing.modelName.length > 0) {
    out.entitledModels = [billing.modelName];
  }
  return out;
}

/** 把 `requestCliLogin()` 的结果转成客户端能显示的一句话。 */
function toLoginResult(data: CliLoginData): { ok: boolean; message: string } {
  const url = data.authorizeUrl;
  if (typeof url === "string" && url.length > 0) {
    // `browserOpened` 由实例报告 —— 它才是知道浏览器到底开没开的一方。
    return {
      ok: true,
      message: data.browserOpened === true
        ? "已拉起授权页，请在浏览器中完成登录"
        : `请在浏览器打开授权链接完成登录：${url}`,
    };
  }
  if (typeof data.message === "string" && data.message.length > 0) {
    return { ok: true, message: data.message };
  }
  return {
    ok: true,
    message: "登录流程已启动 —— 若浏览器没有自动打开，请查看 ZCode 实例的窗口",
  };
}

/**
 * 把 `requestClaim()` 的结果转成客户端能显示的一句话。
 *
 * ⚠ `ClaimData` 是**多 plan 聚合**形状（`results[]` 每项一个 plan），
 * 没有顶层 `credit` 字段 —— 成功与否要看每个 result 的 `ok`。
 *
 * ⚠ 幂等语义：`upstreamCode === 1003`（已领取）**也算成功**（见类型注释）。
 */
function toClaimResult(data: ClaimData): { ok: boolean; message: string } {
  const results = data.results ?? [];
  if (results.length === 0) {
    // 没发现 plan 时如实说明 —— 这跟「领取失败」是两回事
    //（可能是活动未开始、或当天已无可领）。
    return {
      ok: true,
      message: data.note ?? "未发现可领取的额度活动（可能今天已领完或活动未开始）",
    };
  }

  const succeeded = results.filter((r) => r.ok === true
    || r.upstreamCode === 1003
    || r.alreadyClaimed === true);
  const failed = results.filter((r) => !succeeded.includes(r));
  const already = results.filter((r) => r.alreadyClaimed === true || r.upstreamCode === 1003);

  if (failed.length === 0) {
    if (already.length === results.length) {
      return { ok: true, message: `今天已经领过了（${results.length} 项）` };
    }
    return { ok: true, message: `领取成功（${succeeded.length} 项）` };
  }
  if (succeeded.length === 0) {
    const reason = failed[0]?.error ?? failed[0]?.body ?? "服务端拒绝了请求";
    return { ok: false, message: `领取失败：${reason}` };
  }
  return {
    ok: true,
    message: `部分成功：${succeeded.length} 项已领、${failed.length} 项失败`,
  };
}

/**
 * 注册 RPC 端点。
 *
 * ⚠ **失败只 warn 不抛** —— 端点注册不上时，设置页的三个按钮会显示
 * "Host 侧未提供该接口"，而不是让整个插件加载失败。
 */
export function registerZcodeBridgeRpc(ctx: Context): void {
  ctx.inject(["connection"], (connectionCtx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection = (connectionCtx as any).connection;
    if (!connection || typeof connection.fetch?.register !== "function") {
      ctx.logger?.warn?.(
        "[zcode-bridge] connection.fetch.register 不可用，账号 RPC 端点未注册"
        + "（设置页的账号管理按钮将显示为不可用）",
      );
      return;
    }

    connection.fetch.register({
      path: RPC_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request: Request): Promise<Response> {
        if (request.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        let body: RpcRequest;
        try {
          body = (await request.json()) as RpcRequest;
        } catch {
          return Response.json(
            { ok: false, error: { code: "bad-request", message: "请求体不是合法 JSON" } },
            { status: 400 },
          );
        }

        const method = typeof body.method === "string" ? body.method : "";
        const reply = (value: RpcResponse, status = 200): Response =>
          Response.json(value, { status });

        try {
          switch (method) {
            case "status": {
              const billing = await fetchBilling();
              // ⚠ `BridgeOpsResult.data` 是**可选**的（失败时没有）——
              // 必须逐层判空，不能直接展开。
              if (!billing.ok || billing.data === undefined) {
                // 桥不可达是**预期内**的情况（实例没跑）—— 回 ok:false
                // 让 UI 显示原因，而不是抛成一个「未知故障」。
                return reply({
                  ok: false,
                  error: {
                    code: "bridge-unavailable",
                    message: billing.error
                      ?? "无法从 ZCode 实例读取账号信息（实例可能未运行）",
                  },
                });
              }
              return reply({ ok: true, value: toAccountStatus(billing.data) });
            }

            case "addAccount": {
              const login = await requestCliLogin();
              if (!login.ok || login.data === undefined) {
                return reply({
                  ok: false,
                  error: {
                    code: "login-failed",
                    message: login.error ?? "无法启动 ZCode 登录流程",
                  },
                });
              }
              // ⚠ `ok` 由外层 RPC 信封持有；这里只放**面向用户的结果**，
              // 不重复写 `ok`（TS2783：重复指定会被内层值覆盖，是真空洞）。
              return reply({ ok: true, value: toLoginResult(login.data) });
            }

            case "checkin": {
              const claim = await requestClaim();
              if (!claim.ok || claim.data === undefined) {
                return reply({
                  ok: false,
                  error: {
                    code: "claim-failed",
                    message: claim.error ?? "签到请求失败（实例不可达或未登录）",
                  },
                });
              }
              return reply({ ok: true, value: toClaimResult(claim.data) });
            }

            case "startAutoClaim": {
              // 持续领取由主插件的 quota-guard 承担；这里如实报告它的运行状态。
              // 见本文件顶部「与持续领取的关系」。
              // ⚠ 不重复写 `ok` —— 外层信封已持有（TS2783）。
              if (autoClaimState.running) {
                return reply({
                  ok: true,
                  value: { ok: true, message: "持续领取已在运行中（实例会定时自动领取）" },
                });
              }
              return reply({
                ok: true,
                value: {
                  ok: false,
                  message: "持续领取未在运行 —— 请确认 ZCode 实例正在运行后重试",
                },
              });
            }

            default:
              return reply({
                ok: false,
                error: { code: "bad-request", message: `unknown method: ${method}` },
              });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger?.warn?.(`[zcode-bridge] RPC ${method} 失败: ${message}`);
          return reply({
            ok: false,
            error: { code: "handler-failed", message },
          });
        }
      },
    });

    ctx.logger?.info?.(`[zcode-bridge] 账号 RPC 端点已注册: ${RPC_PATH}`);
  });
}

/**
 * 持续领取的运行状态 —— 由主插件在启动 quota-guard 时置位。
 *
 * 用模块级可变对象而不是「去问 guard」：guard 的 `stop` 存在但
 * 没有「是否运行中」的查询面，加一个查询面要改 guard 的接口；
 * 而这里只需要一个布尔，用共享状态最省。
 */
export const autoClaimState: { running: boolean } = { running: false };
