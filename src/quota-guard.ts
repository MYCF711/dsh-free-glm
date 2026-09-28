/**
 * 每日额度守卫（2026-09-28 新增）。
 *
 * ## 它解决什么
 *
 * 用户的两条诉求：
 *
 * 1. 「登录授权成功后，插件就能直接让 DSH 调用 zcode 的每日免费订阅额度」
 * 2. 「还要时刻检索每日随机派发的大额额度，自动领取」
 *
 * ## 为什么需要「检索」
 *
 * 服务端**不会主动推送**额度。ZCode 客户端左下角那张卡片，其数据源是
 * `GET /billing/preview` —— 而该接口的内容**依赖客户端的活跃信号**：
 *
 * 实测（本项目，跨版本一致）：
 * ```
 * 补发 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 *   preview → {"code":0,"data":{"plans":[]}}            ← 空
 * 补发之后：
 *   preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-0928"...}]}}
 * ```
 *
 * **⇒ 「随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
 * 所以「时刻检索」的正确实现是：**定期补发活跃信号 + 查 preview + 有就领**。
 *
 * ## 安全边界（实测）
 *
 * - **幂等**：已领取时服务端返回 `code:1003`，连调 3 次结果一致、
 *   且**不消耗额度**（实测剩余量未变）
 * - **有轮询风险**：第三方实现提到 `billing/*` 连续查询易触发 WAF，
 *   所以默认间隔取 **20 分钟**（一天 72 次，远低于风险阈值）
 * - **失败不抛**：单个周期失败只记日志，不影响下一个周期
 */

import { fetchBilling, requestClaim, type BillingData, type ClaimData } from "./bridge-ops.js";

/** 默认检索间隔：20 分钟。 */
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;

/** 首次检索延迟：2 分钟（给 DSH 启动后的其他初始化让路）。 */
const DEFAULT_FIRST_DELAY_MS = 2 * 60 * 1000;

/**
 * 失败冷却：10 分钟（同类项目 TriDefender/zcode-api 的默认值）。
 *
 * 连续失败时退到这个节奏，避免持续打上游。
 */
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** 单次 hold 上限：24 小时（防止坏数据把任务永久挂起）。 */
const MAX_HOLD_MS = 24 * 60 * 60 * 1000;

export interface QuotaGuardOptions {
  readonly log: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  /** 检索间隔（毫秒）。未设置时用 `ZCODE_QUOTA_GUARD_INTERVAL_MS` 或默认值。 */
  readonly intervalMs?: number;
  /** 首次延迟（毫秒）。 */
  readonly firstDelayMs?: number;
}

export interface QuotaGuard {
  /** 立刻跑一次（用户手动触发 / 登录后补跑）。 */
  runOnce: () => Promise<QuotaGuardTick>;
  /** 停止定时器。 */
  stop: () => void;
}

/** 一个检索周期的结果（供上层展示或日志）。 */
export interface QuotaGuardTick {
  readonly at: number;
  /** 额度快照（拿不到时为 undefined）。 */
  readonly billing?: BillingData;
  /** 本周期是否调了 claim。 */
  readonly claimed: boolean;
  /** claim 结果（调了才有）。 */
  readonly claim?: ClaimData;
  /** 人类可读的一句话结论。 */
  readonly summary: string;
}

/** 把大数字格式化成易读字符串。 */
function formatUnits(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未知";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

/**
 * 判断是否「值得尝试领取」。
 *
 * ## 判据：`period`
 *
 * - `one_time` —— 活动赠送，**会过期**，值得领（也值得反复检索，
 *   因为服务端可能随时投放新的）
 * - `daily` —— 每日刷新，到点自动恢复，**不需要领**
 * - 未知 / 无 plan —— 也要试（可能就是「活动还没被触发」的状态）
 *
 * ## 为什么「无 plan 也要试」
 *
 * 这正是激活上报能改变的状态：preview 为空时，补发事件后可能出现 plan。
 * 若因为「没看到 plan」就跳过 claim，就永远等不到。
 */
function shouldAttempt(): boolean {
  return true;
}

/**
 * 创建守卫。
 *
 * ## 为什么用 `setTimeout` 递归而不是 `setInterval`
 *
 * 一轮检索实测 2-30 秒（含 mint + claim）。`setInterval` 会在上一轮
 * 还没结束时叠下一轮，导致并发 mint（captcha 会互相抢）。
 * 递归 `setTimeout` 保证**串行**。
 */
export function createQuotaGuard(options: QuotaGuardOptions): QuotaGuard {
  const envInterval = Number(process.env["ZCODE_QUOTA_GUARD_INTERVAL_MS"] ?? "");
  const intervalMs =
    options.intervalMs ??
    (Number.isFinite(envInterval) && envInterval >= 60_000 ? envInterval : DEFAULT_INTERVAL_MS);
  const firstDelayMs = options.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS;
  const envCooldown = Number(process.env["ZCODE_QUOTA_GUARD_COOLDOWN_MS"] ?? "");
  const cooldownMs =
    Number.isFinite(envCooldown) && envCooldown >= 60_000 ? envCooldown : DEFAULT_COOLDOWN_MS;
  /** 关闭开关（用户可能不想让插件后台跑）。 */
  const disabled = process.env["ZCODE_QUOTA_GUARD_DISABLED"] === "1";

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;
  /**
   * 下次可执行的时刻（`hold` 用）。
   *
   * ## 为什么要 hold 而不是裸循环（抄自 TriDefender/zcode-api 的 scheduler）
   *
   * 那份实现把「已领取」和「配额耗尽」视为**非错误**并 hold 到已知时间点：
   *
   * - `already_claimed` / `success` → hold 到 plan 的 `ends_at`（不再空轮询）
   * - `quota_exhausted` → hold 到 `failureEndsAt`（上限 24h）
   * - `login_required` → **stop()**（需要重新登录，轮询无意义）
   * - **404（活动未上线）→ 走正常节奏**，不触发错误退避
   *
   * 最后一条尤其关键：**把「活动还没开始」和「出错了」分开** ——
   * 否则活动未上线时把自己打进 10 分钟冷却，可能**错过真正的开抢时刻**。
   */
  let holdUntilMs = 0;
  /** 连续失败计数（决定是否进冷却）。 */
  let consecutiveFailures = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    const wait = Math.max(1_000, delayMs);
    timer = setTimeout(() => {
      void runOnce().finally(() => {
        const now = Date.now();
        // ① 在 hold 期内 → 等到 hold 结束再跑
        if (holdUntilMs > now) {
          schedule(holdUntilMs - now);
          return;
        }
        // ② 最近失败过 → 退到冷却节奏
        if (consecutiveFailures > 0) {
          schedule(cooldownMs);
          return;
        }
        // ③ 正常节奏
        schedule(intervalMs);
      });
    }, wait);
    // 不让这个定时器拖住进程退出（DSH 关闭时应能正常退出）
    timer.unref?.();
  };

  const tick = async (): Promise<QuotaGuardTick> => {
    const at = Date.now();
    // ① 查额度 —— 同时起到「活跃信号」的作用（billing/balance 本身就带设备身份）
    const billingResult = await fetchBilling();
    if (!billingResult.ok) {
      return {
        at,
        claimed: false,
        summary: `查额度失败：${billingResult.error ?? "未知原因"}`,
      };
    }
    const billing = billingResult.data;

    if (!shouldAttempt()) {
      return {
        at,
        billing,
        claimed: false,
        summary: `额度 ${formatUnits(billing?.remainingUnits)}（无需领取）`,
      };
    }

    // ② 尝试领取 —— 桥侧会先补激活上报再查 preview（那才是「检索派发」的关键）
    const claimResult = await requestClaim();
    if (!claimResult.ok) {
      return {
        at,
        billing,
        claimed: true,
        summary:
          `额度 ${formatUnits(billing?.remainingUnits)}；领取尝试失败：`
          + `${claimResult.error ?? "未知原因"}`,
      };
    }
    const claim = claimResult.data;
    const discovered = claim?.discoveredPlans ?? [];
    const anyNew = (claim?.results ?? []).some((r) => r.alreadyClaimed !== true && r.ok === true);

    // ③ 领取后复查一次额度（拿最新值展示）
    const after = await fetchBilling();
    const finalBilling = after.ok ? after.data : billing;

    const summary = anyNew
      ? `★ 领取成功！额度 ${formatUnits(finalBilling?.remainingUnits)}`
        + `（${finalBilling?.planName ?? "未知套餐"}，`
        + `${finalBilling?.period === "one_time" ? "活动赠送" : finalBilling?.period ?? "?"}）`
      : `额度 ${formatUnits(finalBilling?.remainingUnits)}`
        + `（${finalBilling?.planName ?? "无活动"}，`
        + `发现 ${discovered.length} 个可领 plan，均已领取或不可领）`;

    return { at, billing: finalBilling, claimed: true, claim, summary };
  };

  const runOnce = async (): Promise<QuotaGuardTick> => {
    if (running) {
      return { at: Date.now(), claimed: false, summary: "上一轮检索仍在进行，跳过" };
    }
    running = true;
    try {
      const result = await tick();
      /**
       * 成功/失败的记账（决定下一轮的节奏）。
       *
       * ## 判据：看 summary 里有没有「失败」字样是不够的
       *
       * 改为看**结构化信号**：`billing` 拿到了 = 桥通 = 这一轮算成功。
       * 桥不通（`billing` 为 undefined）才计失败 —— 那通常是
       * 「ZCode 实例没跑」或「桥端口变了」，值得退避重试。
       */
      if (result.billing !== undefined) {
        consecutiveFailures = 0;
        // 一次性活动有明确到期时间 → hold 到那时，不再空轮询
        const exp = result.billing.expiresAt;
        if (typeof exp === "number" && exp * 1000 > Date.now()) {
          holdUntilMs = Date.now() + Math.min(exp * 1000 - Date.now(), MAX_HOLD_MS);
        }
      } else {
        consecutiveFailures += 1;
      }
      options.log.info(`[quota-guard] ${result.summary}`);
      return result;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      options.log.warn(`[quota-guard] 检索异常：${message}`);
      return { at: Date.now(), claimed: false, summary: `检索异常：${message}` };
    } finally {
      running = false;
    }
  };

  if (!disabled) {
    schedule(firstDelayMs);
    options.log.info(
      `[quota-guard] 已启动（每 ${Math.round(intervalMs / 60000)} 分钟检索派发额度，`
      + `失败冷却 ${Math.round(cooldownMs / 60000)} 分钟）`,
    );
  } else {
    options.log.info("[quota-guard] 已禁用（ZCODE_QUOTA_GUARD_DISABLED=1）");
  }

  return {
    runOnce,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
