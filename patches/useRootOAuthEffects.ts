/* eslint-disable max-lines -- OAuth lifecycle effects intentionally share one coordination point. */
import { useEffect, useRef } from "react";
import type {
  IPlatformService,
  OAuthProviderId,
  OAuthSessionCallbackResult,
  UserInfo,
} from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  DesktopCommandIds,
  resolveProviderFamilyDomainFromOAuthProvider,
  ZAI_PROVIDER_ID,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useAlertDialog } from "@/hooks/useAlertDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { reportAppTelemetryEvent, resolveProviderTelemetryLabel } from "@/lib/appTelemetry.js";
import { logger } from "@/logger.js";
import { setProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import type { ModelProviderFamilyConnectionSelection } from "@/lib/modelProviderFamilyConnectionSelection.js";
import {
  refreshLatestModelProviderFamilySelectionAfterLogin,
  refreshRestoredOAuthProviderFamilyAfterStartup,
} from "@/root/oauthProviderFamilySelectionRefresh.js";
import { applyCachedOAuthSessionRestoreResult } from "@/root/oauthCachedSessionRestore.js";
import { markZcodeJwtInvalidRestart } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { shouldApplyOAuthPollingFailure } from "@/root/oauthLoginAttemptGuard.js";
import { useAccountConnectionLossNotification } from "@/root/useAccountConnectionLossNotification.js";

export { refreshRestoredOAuthProviderFamilyAfterStartup } from "@/root/oauthProviderFamilySelectionRefresh.js";

async function handleOAuthCallbackSuccess(params: {
  result: OAuthSessionCallbackResult;
  platform: Pick<IPlatformService, "reportTelemetryEvent">;
  refreshLatestModelProviderFamilySelection?: (
    provider: OAuthProviderId,
  ) => Promise<ModelProviderFamilyConnectionSelection | null>;
  refreshAppSettings?: () => Promise<void>;
  refreshProviderState: () => Promise<void>;
  setProviderFamilyDomain: (provider: OAuthProviderId) => Promise<void>;
  setUser: (user: UserInfo | null) => void;
  setOAuthError: (error: string | null) => void;
}) {
  const loginProvider = resolveProviderTelemetryLabel(params.result.provider);
  params.setUser(params.result.userInfo);
  params.setOAuthError(null);
  await params.setProviderFamilyDomain(params.result.provider);
  if (params.refreshLatestModelProviderFamilySelection) {
    let selection: ModelProviderFamilyConnectionSelection | null = null;
    try {
      selection = await params.refreshLatestModelProviderFamilySelection(params.result.provider);
    } catch (error) {
      // selectedKey 后台校正失败只影响默认连接方式展示，不能回滚已经成功的 OAuth 登录态。
      logger.warn("[Root] OAuth 登录后刷新 provider family selectedKey 失败", {
        provider: params.result.provider,
        error,
      });
    }
    const selectedConnection = selection ? JSON.stringify(selection) : "";
    if (selection && params.refreshAppSettings) {
      try {
        // selectedKey 由 settingService 直接落盘，输入框和 context hover
        // 读取的是 renderer settings 快照。登录后必须先刷新快照，再按最终套餐刷新
        // 模型可用态和剩余额度，否则 UI 会一直拿旧 selectedKey，直到打开设置页或重启。
        await params.refreshAppSettings();
      } catch (error) {
        logger.warn("[Root] OAuth 登录后刷新 App settings 快照失败", {
          provider: params.result.provider,
          selectedConnection,
          error,
        });
      }
    }
  }
  // selectedKey 与账号状态收敛后统一刷新 Account Source 与 Registry。
  await params.refreshProviderState();
  if (loginProvider) {
    void reportAppTelemetryEvent(
      params.platform,
      {
        elementName: "app_login_success",
        eventRegion: "app_profile",
        eventType: "view",
        eventExtraDetail: {
          login_provider: loginProvider,
        },
      },
      "Root",
    );
  }
  logger.info("[Root] OAuth 登录成功:", params.result.userInfo.username);
}

export function useRootOAuthEffects({
  accountIntentKey,
  platform,
  services,
  refreshProviderState,
  refreshAppSettings,
  setUser,
  setIsRestoringOAuthSession,
  setOAuthError,
  oauthPollingActive,
  setOAuthPollingActive,
  markOAuthSuccess,
  onReauthenticationRequired,
}: {
  accountIntentKey: string;
  platform: IPlatformService;
  services: IServiceAccessor;
  refreshProviderState: () => Promise<void>;
  refreshAppSettings?: () => Promise<void>;
  setUser: (user: UserInfo | null) => void;
  setIsRestoringOAuthSession: (restoring: boolean) => void;
  setOAuthError: (error: string | null) => void;
  oauthPollingActive: boolean;
  setOAuthPollingActive: (active: boolean) => void;
  markOAuthSuccess: (provider?: OAuthProviderId) => void;
  onReauthenticationRequired: () => void;
}) {
  useAccountConnectionLossNotification(services, accountIntentKey, refreshAppSettings);
  const requestAlert = useAlertDialog();
  const { intl } = useZCodeIntl();
  const oauthLoginSucceededRef = useRef(false);
  const oauthLoginSuccessInFlightRef = useRef(false);
  const oauthLoginSuccessOwnerRef = useRef<"polling" | "deep-link" | null>(null);

  useEffect(() => {
    let disposed = false;
    async function restoreOAuthSessionInBackground() {
      logger.info("[Root] 后台启动 OAuth 本地会话恢复");
      let hasRestoredUser = false;
      try {
        // zai / bigmodel 的 OAuth token 生命周期较短，启动时如果仍走远端校验，
        // 用户会在 token 过期后被立刻打回“未登录”，和“已完成登录但未主动退出”的产品语义冲突。
        // 这里改为只读取登录成功时缓存的 user_info，展示态由“是否主动退出”决定，而不是由短 token 决定。
        const result = await services.oauthService.restoreCachedSessionState();

        if (disposed) {
          return;
        }

        hasRestoredUser = await applyCachedOAuthSessionRestoreResult({
          result,
          setUser,
          requestAlert,
          onReauthenticationRequired,
          copy: {
            title: intl.formatMessage({ id: "login.expired.title" }),
            description: intl.formatMessage({ id: "login.expired.description" }),
            actionLabel: intl.formatMessage({ id: "login.expired.action" }),
          },
        });
      } catch (error) {
        logger.error("[Root] 恢复 OAuth 本地登录态失败:", error);
        if (disposed) {
          return;
        }
      }

      // 启动恢复是异步后台流程，慢网时如果不单独暴露“恢复中”状态，
      // sidebar 会先按 user=null 渲染成“登录”，而登录弹窗又还能读到本地 activeProvider，
      // 用户就会看到“外面未登录、弹窗里已登录提供方”的分裂展示。
      // 这里在恢复主流程结束后立刻落定状态，让 footer 先显示 loading，再收敛到最终登录态。
      setIsRestoringOAuthSession(false);

      try {
        if (hasRestoredUser) {
          const activeProvider = await services.oauthService.getActiveProvider();
          if (disposed) return;
          await refreshRestoredOAuthProviderFamilyAfterStartup({
            activeProvider,
            services,
            refreshAppSettings,
          });
        }

        // OAuth 会话恢复与 Provider Runtime 刷新保持后台执行，避免首屏等待网络链路。
        await refreshProviderState();
      } catch (error) {
        // 启动刷新失败不能跳过后续订阅，否则网络恢复后账号失效协调也永久停止。
        // 保留当前事实，继续由 Provider View 的正常更新驱动，不另起重试循环。
        logger.warn("[Root] 启动账号配置刷新失败，继续观察后续更新", { error });
      }
    }

    void restoreOAuthSessionInBackground();

    return () => {
      disposed = true;
    };
  }, [
    intl,
    onReauthenticationRequired,
    refreshAppSettings,
    refreshProviderState,
    requestAlert,
    services,
    setIsRestoringOAuthSession,
    setUser,
  ]);

  useEffect(() => {
    let disposed = false;
    const disposable = services.broadcastService.onMessage((message) => {
      if (message.channel !== ZCODE_JWT_INVALID_BROADCAST_CHANNEL || disposed) {
        return;
      }
      void (async () => {
        const confirmed = await requestAlert({
          title: intl.formatMessage({ id: "login.expired.title" }),
          description: intl.formatMessage({ id: "login.expired.description" }),
          actionLabel: intl.formatMessage({ id: "login.expired.restart" }),
        });
        if (disposed) {
          return;
        }
        if (!confirmed) {
          onReauthenticationRequired();
          return;
        }
        markZcodeJwtInvalidRestart();
        if (typeof window !== "undefined" && !("zcode" in window)) {
          // Web 没有 Electron RelaunchApp；marker 写入后立即刷新，避免停留在僵尸登录态。
          window.location.reload();
          return;
        }
        await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
      })();
    });
    return () => {
      disposed = true;
      disposable.dispose();
    };
  }, [intl, onReauthenticationRequired, platform, requestAlert, services.broadcastService]);

  useEffect(() => {
    if (!oauthPollingActive) {
      return;
    }
    oauthLoginSucceededRef.current = false;
    oauthLoginSuccessInFlightRef.current = false;
    oauthLoginSuccessOwnerRef.current = null;
    let pollInFlight = false;
    const pollTimer = window.setInterval(() => {
      if (pollInFlight) {
        return;
      }
      pollInFlight = true;
      void services.oauthService
        .pollPendingOAuth()
        .then(async (result) => {
          if (!result || result.kind !== "session") {
            return;
          }
          oauthLoginSuccessOwnerRef.current = "polling";
          oauthLoginSuccessInFlightRef.current = true;
          await handleOAuthCallbackSuccess({
            result,
            platform,
            refreshLatestModelProviderFamilySelection: (provider) =>
              refreshLatestModelProviderFamilySelectionAfterLogin({ provider, services }),
            refreshAppSettings,
            refreshProviderState,
            setProviderFamilyDomain: async (provider) => {
              const domain = resolveProviderFamilyDomainFromOAuthProvider(provider);
              if (domain) {
                await setProviderFamilyDomain(services.settingService, domain);
              }
            },
            setUser,
            setOAuthError,
          });
          oauthLoginSucceededRef.current = true;
          oauthLoginSuccessOwnerRef.current = null;
          oauthLoginSuccessInFlightRef.current = false;
          markOAuthSuccess(result.provider);
          setOAuthPollingActive(false);
        })
        .catch((error) => {
          setOAuthPollingActive(false);
          const ownSuccessHandlerFailed = oauthLoginSuccessOwnerRef.current === "polling";
          if (ownSuccessHandlerFailed) {
            oauthLoginSuccessOwnerRef.current = null;
            oauthLoginSuccessInFlightRef.current = false;
          }
          const shouldApplyFailure = shouldApplyOAuthPollingFailure(
            oauthLoginSucceededRef.current,
            ownSuccessHandlerFailed ? false : oauthLoginSuccessInFlightRef.current,
          );
          logger.warn("[Root] OAuth polling 失败判定", {
            succeeded: oauthLoginSucceededRef.current,
            successInFlight: oauthLoginSuccessInFlightRef.current,
            shouldApplyFailure,
          });
          if (shouldApplyFailure) {
            setOAuthError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
          }
          logger.error("[Root] OAuth 轮询处理失败:", error);
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, 1_000);

    return () => {
      window.clearInterval(pollTimer);
    };
  }, [
    intl,
    markOAuthSuccess,
    oauthPollingActive,
    platform,
    refreshAppSettings,
    refreshProviderState,
    services,
    setOAuthError,
    setOAuthPollingActive,
    setUser,
  ]);

  useEffect(() => {
    const disposeOAuth = platform.onOAuthCallback(async (url) => {
      try {
        const result = await services.oauthService.handleCallback(url);
        // 取消或切换 flow 会使已接收的回调失效，正常空结果不能被当作登录异常。
        if (!result) {
          logger.info("[Root] 已忽略失效 OAuth 回调");
          return;
        }
        if (result.kind === "attribution") {
          logger.info("[Root] OAuth 登录归因参数已缓存:", result.provider);
          return;
        }
        if (result.kind === "duplicate") {
          logger.info("[Root] 已忽略 polling 完成后的迟到 OAuth deep link");
          return;
        }

        oauthLoginSuccessOwnerRef.current = "deep-link";
        oauthLoginSuccessInFlightRef.current = true;
        await handleOAuthCallbackSuccess({
          result,
          platform,
          refreshLatestModelProviderFamilySelection: (provider) =>
            refreshLatestModelProviderFamilySelectionAfterLogin({
              provider,
              services,
            }),
          refreshAppSettings,
          refreshProviderState,
          setProviderFamilyDomain: async (provider) => {
            const domain = resolveProviderFamilyDomainFromOAuthProvider(provider);
            if (!domain) {
              return;
            }
            await setProviderFamilyDomain(services.settingService, domain);
          },
          setUser,
          setOAuthError,
        });
        oauthLoginSucceededRef.current = true;
        oauthLoginSuccessOwnerRef.current = null;
        oauthLoginSuccessInFlightRef.current = false;
        setOAuthPollingActive(false);
        markOAuthSuccess(result.provider);
      } catch (err) {
        // 之前把底层 OAuth 错误原文写入 UI，用户会看到 provider/token 等具体失败原因。
        // 登录页只保留统一可重试提示，具体原因继续进入 logger 便于排查。
        // polling 成功后可能收到迟到/重复的 deep-link；该回调失败不能覆盖已完成的登录态。
        const ownSuccessHandlerFailed = oauthLoginSuccessOwnerRef.current === "deep-link";
        if (ownSuccessHandlerFailed) {
          oauthLoginSuccessOwnerRef.current = null;
          oauthLoginSuccessInFlightRef.current = false;
        }
        const shouldApplyFailure = ownSuccessHandlerFailed
          ? !oauthLoginSucceededRef.current
          : shouldApplyOAuthPollingFailure(
              oauthLoginSucceededRef.current,
              oauthLoginSuccessInFlightRef.current,
            ) && !oauthPollingActive;
        logger.warn("[Root] OAuth deep-link 失败判定", {
          succeeded: oauthLoginSucceededRef.current,
          successInFlight: oauthLoginSuccessInFlightRef.current,
          pollingActive: oauthPollingActive,
          shouldApplyFailure,
        });
        if (shouldApplyFailure) {
          setOAuthError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        }
        logger.error("[Root] OAuth 回调处理失败:", err);
      }
    });
    /**
     * ★ 监听「宿主请求发起登录」（2026-09-28 新增）。
     *
     * ## 用途
     *
     * 桥提供 `POST /oauth/login` → 宿主 → `PlatformChannels.StartOAuthLogin`
     * → 本回调 → 这里调 `oauthService.startOAuthWithPolling` 完成登录五步。
     *
     * ## 为什么由 renderer 做
     *
     * 登录需要 `state` 并调用 `platform.registerOAuthState`（写实例内存 Map），
     * 且要 `platform.openExternal` 开浏览器 —— 两者都只有 renderer 侧能拿全。
     * 宿主拿到的是 `startLogin` 的调用请求，不是实现。
     *
     * ## fire-and-forget
     *
     * 这里**不 await 登录完成** —— OAuth 是异步的，结果经
     * `zcode://oauth/callback` deep link 回流（上面的 onOAuthCallback 已处理）。
     * 只做「生成 state + 注册 + 开浏览器」三件事。
     */
    /**
   * ★ 落盘诊断（2026-09-28）。
   *
   * 项目方法论：「验证插件改动要用落盘诊断，不要只用 logger」。
   * 这里同样适用 —— renderer 的 logger 未必落到我能看到的地方，
   * 而「宿主请求登录」这条链路此前**没有任何可观测证据**。
   *
   * 写到哪里：用 Electron 的 userData 目录（renderer 可写）。
   * 文件名 `dsh-oauth-diag.ndjson`，追加写。
   */
  const writeOAuthDiag = (entry: Record<string, unknown>): void => {
    try {
      /** renderer 里没有 node:fs，改用「请求主进程代写」不可行，
       *  所以退一步：写到 localStorage（renderer 一定有），
       *  再由排查侧通过 devtools 或桥的端点读取。 */
      const KEY = "dsh-oauth-diag";
      const prev = window.localStorage.getItem(KEY) ?? "";
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      window.localStorage.setItem(KEY, (prev + line + "\n").slice(-8000));
    } catch {
      /* 诊断失败不影响主流程 */
    }
  };

  /**
   * 记录「platform 有没有暴露 onStartOAuthLogin」——
   * 这是判断链路是否可能工作的**第一手事实**。
   * 它若是 undefined，后面的回调永远不会被调用（可选调用的静默失败）。
   */
  writeOAuthDiag({
    event: "hook-mounted",
    hasOnStartOAuthLogin: typeof platform.onStartOAuthLogin === "function",
    hasOnOAuthCallback: typeof platform.onOAuthCallback === "function",
  });

  const disposeStartLogin = platform.onStartOAuthLogin?.((payload) => {
    writeOAuthDiag({ event: "callback-invoked", payload });
      void (async () => {
        try {
          /**
           * ⚠ `payload.providerId` 必须是 **OAuth provider ID**
           *   （`BIGMODEL_PROVIDER_ID = "bigmodel"` / `"zai"`），
           *   不是桥的 provider 名（`account:bigmodel-start-plan`）——
           *   后者会抛 `不支持的 OAuth provider: account:...`（实测踩过）。
           */
          const raw = String(payload?.providerId ?? "").trim();
          const provider = (
            raw === "zai" || raw.includes("zai") ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID
          ) as OAuthProviderId;
          logger.info("[Root] 收到宿主发起的登录请求", { provider, raw });
          const started = await services.oauthService.startOAuthWithPolling(provider);
          // 关键：把 state 注册进实例内存，否则 deep link 回调查不到目标窗口
          platform.registerOAuthState({ state: started.state, provider: started.provider });
          platform.openExternal(started.authorizeUrl);
          logger.info("[Root] 已打开授权页，等待 zcode:// 回调", {
            provider: started.provider,
          });
        } catch (err) {
          logger.error("[Root] 宿主发起的登录失败:", err);
        }
      })();
    });
    platform.notifyRendererReady();
    return () => {
      disposeOAuth();
      disposeStartLogin?.();
    };
  }, [
    intl,
    platform,
    refreshAppSettings,
    refreshProviderState,
    services,
    markOAuthSuccess,
    oauthPollingActive,
    setUser,
    setOAuthError,
    setOAuthPollingActive,
  ]);
}
