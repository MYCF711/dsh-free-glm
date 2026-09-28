/* eslint-disable max-lines -- Host 入口集中编排 local/remote service wiring，本次退出保护需要在同一处桥接 host 上报。 */
/* eslint-disable max-lines -- host process 入口集中维护 local/remote 初始化和资源回收，realtime bridge 接入后先保持同文件收口。 */
/**
 * Host Process 入口 —— 每个窗口对应一个独立的 host process
 *
 * 同一窗口的 Renderer 和手机 都 attachment 到这个 Host：
 *   Renderer / Mobile ←MessagePort→ Window Host
 *                                      ├─ local services
 *                                      └─ remote connection registry
 *
 * 启动流程：
 * 1. main 进程通过 Electron `utilityProcess.fork()` 创建本进程
 * 2. main 进程只发送一次 init-local 初始化窗口 Host
 * 3. 后续远端 connect / scoped attachment 都由同一 Host 处理
 */
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MessagePortProtocol,
  ChannelServer,
  type IDisposable,
  type IChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
} from "@zcode/rpc";
import { registerHostNetworkTelemetry, stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import {
  ServiceCollection,
  IBotsService,
  IFileService,
  IClientConfigService,
  IMediaPreviewService,
  IOffPeakTaskService,
  IModelSelectionService,
  ISettingService,
  IWindowControllerService,
  IConversationShareService,
  IZCodeAgentService,
  IZCodeTaskService,
  IZCodeSessionService,
  ICuaPipSessionService,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
  collectServiceMemoryDiagnostics,
} from "@zcode/services";
// `getAccountRequestAuthService` 是「Local Host 进程内能力」，按设计
// 不走通用 RPC Channel（见 services/src/node.ts 的注释），所以从 ./node
// 次入口取，而不是包主入口。
import { getAccountRequestAuthService } from "@zcode/services/node";
import {
  createLocalServices,
  getOffPeakRequestAuthBuilder,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  AutomationRepo,
  OffPeakTaskRepo,
  OffPeakTaskService,
  createServiceLogger,
  buildTaskChangeSummary,
  createHostApiNetworkTransport,
  createSettingServiceWithMigrations,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  type HostApiNetworkTransport,
  type OffPeakRequestAuthBuilder,
} from "@zcode/services/node";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import {
  HostMessageTypes,
  HostResponseTypes,
  ZCODE_VERSION,
  formatLogPrefix,
  formatZCodeHostProcessName,
  formatZodError,
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  isOffPeakTicketExpiredError,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  formatModelPickerValue,
  type ZCodePromptAttachment,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type TaskStreamMirrorableEvent,
  type TraceId,
  type ZCodeTaskMode,
  type WindowHostAttachmentScope,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ModelSelection,
} from "@zcode/shared";
import {
  parseHostIncomingMessageEvent,
  rejectUnavailableAttachedServicePort,
} from "./hostMessagePortGuard.js";
// remote backend 相关模块延迟加载：ssh2 的 CJS 依赖链（asn1 等）在 asar 打包后路径断裂，
// 静态 import 会导致 local 模式的 host process 也崩溃。
// 改为动态 import，仅 remote 模式时才加载。
import type {
  ConnectOptions,
  DeployLockMode,
  IRemoteBackend,
  RemoteRuntimeNetworkOptions,
  RemoteAssetNetworkPort,
  RemoteConnection,
} from "@zcode/server/remote";
import type { RemoteTarget } from "@zcode/shared";
import { wrapElectronPort } from "./electronPort.js";
import { createTaskRealtimeBridgeForHostInit } from "./taskRealtimeBridge.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";
import { createHostWorkspaceTaskTracker } from "./hostWorkspaceTaskTracker.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { createHostRemoteWorkspaceProxyState } from "./hostRemoteWorkspaceProxyState.js";
import { createRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";
import { createZCodeBridge, parseMcpServersFromEnv, type ZCodeBridge } from "./zcodeBridgeServer.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";
import { createRemotePromptAttachmentTransferService } from "./promptAttachmentTransferService.js";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import { flushHostE2ECoverage } from "./e2eCoverage.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "./cronRunLifecycle.js";
import {
  createRemotePromptAttachmentSessionService,
  createRemotePromptAttachmentTaskService,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
type RemoteBackendHostConnection = RemoteConnection & {
  backend: IRemoteBackend;
};
type HostRemoteConnection = RemoteBackendHostConnection;
interface HostRemoteConnectionCapabilities {
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
}

let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;

const { parentPort } = process;

// 进程检索体验优化：host 由 utilityProcess 拉起时外壳仍是 Electron Helper，
// 这里根据 main 传入的窗口 label 补一层稳定的 zcode-* title，方便系统进程列表过滤。
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// browser-use host↔main 桥：把 agent 的 browser 命令经 parentPort 转给 main（WebContentsView+CDP）。
// parentPort 为空（不应发生于 host 进程）时 postToMain 抛错，bridge 自身返回 backend_unavailable。
const browserControlMainBridge = createBrowserControlMainBridge({
  postToMain: (message) => {
    if (!parentPort) {
      throw new Error("parentPort unavailable");
    }
    parentPort.postMessage(message);
  },
  materializeRecording: (input) => {
    let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
    if (input.remoteSessionId) {
      const workspaceIdentity = input.workspaceIdentity;
      if (!workspaceIdentity?.trim()) {
        throw new Error("remote Browser recording materialization requires workspaceIdentity");
      }
      // Window Host 重构后同一进程可同时持有多个远端连接，旧的进程级
      // remoteConnection 会串 session。必须用完整 scope 从 registry 的权威 entry 取 uploader。
      remoteBackend = windowRemoteConnectionRegistry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: input.remoteSessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity,
      })?.browserRecordingUploader;
    }
    return materializeBrowserRecordingArtifact({
      ...input,
      ...(remoteBackend ? { remoteBackend } : {}),
    });
  },
});

function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // 日志上报失败不应影响 host 主流程。
  }
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // 连接进度上报失败不应中断 SSH/WSL/Docker 的真实连接流程。
    }
  },
});

function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // 问题反馈以前在 host service 内走 compactLogArchive 的 full fallback，
    // 收集范围和“导出日志”不一致，缺少 zcode-cli 日志、rollout/debug 以及导出链路脱敏。
    // 这里把完整日志打包委托给 main process 的导出日志同源逻辑，host 只拿 zip 路径继续上传。
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

const cronAutomationRepo = new AutomationRepo();
const cronRunSubscriptions = new Map<string, { dispose(): void }>();

// ---- 闲时任务（off-peak）派发：与 cron 并行的独立链路（表/消息/常量互不复用）----
const offPeakTaskRepo = new OffPeakTaskRepo();
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * 续跑提示词（"实现时定"的落地）：3h 时间盒到期 / app 重启恢复后 resume 同一
 * session 续发。不重发原始 prompt（会让模型从头再做一遍），而是指示接续未完成的工作。
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- off-peak 运行时装配（server client + 进程内 mock 网关 + 编排服务，host 域属主）----
// ⚠ 多窗口=多 host 会各自跑一份 sync 轮询（批量接口幂等、写入同库同数据，重复仅多耗请求）；
// mock 网关用固定端口单实例共享票据状态。若多窗口轮询放大成本，再加跨 host 选主。
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** 派发时按本段票据构造逐请求鉴权；静态模型事实由 CLI Built-in Config 提供。 */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
let offPeakRuntime: OffPeakRuntime | null = null;

async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** 终态回填 files_changed：复用现有 task diff 汇总（工具写盘型统计，Bash 改动不计入，接受）。 */
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // 汇总为空（无文件改动）按 0 计——"改了 0 个文件"对完成通知是真实信息。
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
    return undefined;
  }
}

/** loop 终态 → off_peak_tasks 终态：succeeded→completed、stopped→cancelled（用户手动停止）、其余→failed。 */
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  // 自动续跑：票据过期（active 3h 到期 / ready 废票）不是失败——
  // 同 task_id 重取号回 queued，等下一个 ready 再 resume 同 session 续跑。
  if (params.outcome === "failed" && isOffPeakTicketExpiredError(params.error)) {
    const runtime = await ensureOffPeakRuntime();
    if (runtime) {
      await runtime.service.handleTicketExpiredDuringRun(params.offPeakTaskId);
      logger.info(
        `off-peak segment expired, requeued for continuation task=${params.offPeakTaskId}`,
      );
      return;
    }
    // 运行时不可用（服务缺失）时按普通失败落库，避免任务卡在 running。
  }
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  if (!updated) {
    // 终态不可逆出：任务已被用户先一步取消/删除等，丢弃迟到回写（幂等兜底）。
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // 后台完成统一置未读，打开 task 时由导航链路清除（与 cron 同款）。
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): void {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      disposeOffPeakRunSubscription(key);
      void finalizeOffPeakRun({
        zcodeTaskService: params.zcodeTaskService,
        offPeakTaskId: params.offPeakTaskId,
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
      }).catch((error) => logger.warn("off-peak 终态回写失败:", error));
    },
  );
  offPeakRunSubscriptions.set(key, disposable);
}

/**
 * 把一次闲时任务派发提交给当前 host 的 V4 task service。
 * 首跑（无 conversationId）createTask 新建专属 session；续跑/中断恢复 resume
 * 同一会话并以续跑提示词继续。闲时完整 Selection/鉴权仅注入本次执行。
 */
async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId: string;
  sessionId: string;
}> {
  const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  if (!request.serverTicketId) {
    // schedulable 必然已取号；无票派发说明快照失序，按 transient 回执等下轮（轮询会补票）。
    throw new Error("off-peak dispatch without server ticket");
  }
  // idle plan 使用普通 Selection；单次执行约束保证它不写入 Session Selection。
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // 首次派发与复用会话的恢复派发需要在轮次事实中可区分；该字段只描述
  // 当前自动 turn 的调度阶段，不改变稳定 task ID、独立 message ID 或手动消息语义。
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    if (dispatchKind === "bound-first-run") {
      // 绑定首跑：会话内创建的任务在创建它的会话里执行（对齐 dispatchCronRun 的 targetTaskId 路径）。
      // 先探测再写配置：绑定的是用户的工作会话，忙碌时直接 transient 交给调度器退避，
      // 不能先 setMode 再被 session/send 以 -32010 拒绝（那会悄悄改掉用户会话的权限模式）。
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
      };
      const [deletedIds, tasks] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listTasks(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: tasks.find((task) => task.taskId === taskId)?.status === "running",
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // 绑定会话首次盖章归属标记，侧栏归入闲时分组（机制同 cron targetTaskId）。
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    } else if (dispatchKind === "resume") {
      // 续跑段：resume 同一 session（冷恢复水合历史；send 前必须先 resume）。
      taskId = request.conversationId!;
      // 原因：offPeakTaskId 只用于跨 talk 关联；每次自动轮必须生成独立消息身份，
      // 不能复用 task ID，也不能依赖同毫秒时间戳避免碰撞。
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        // pre-打点会话续跑时补写归属标记（bootstrap 回填之外的双保险）。
        offPeakTaskId: request.offPeakTaskId,
      });
      // 权限模式随派发下发（resume 后显式设置，幂等）。
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // 档位是 idle Selection 的一部分，只在 sendPrompt 注入；单独写档位会污染用户会话。
    } else {
      const task = await zcodeTaskService.createTask({
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        // 空 Session 沿用普通初始化；idle Selection 只在下方执行中注入。
        // 在此写入会让闲时轮结束后的普通消息继续使用无票的隐藏 Provider。
        mode: request.permissionMode as ZCodeTaskMode,
        // 闲时任务是无界面的 createTask + sendPrompt 连续派发；空 session 必须在首条
        // V4 admission 内先持久化，否则 session_input 外键会先于 session 主记录写入。
        deferPersistenceUntilFirstPrompt: true,
        // 创建时即盖章持久归属标记（月亮图标/后续系统分组只看该标记，不再反查 store）。
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    trackOffPeakRunOutcome({
      zcodeTaskService,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug 原因：闲时自动 turn 以前只注入 idle plan，没有限制工具面，模型可在后台创建
      // 持久化定时任务。首跑与续跑在此收敛，显式隐藏 CronCreate 且不伪造 cron automation 归属。
      // 闲时轮同时隐藏 OffPeakCreate，OffPeakList 只读保留。
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // 闲时执行凭据只服务主 Turn；完成后不再派生自动 Memory 请求。
        memoryExtraction: "skip",
        selectionScope: "execution",
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "deny",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    // 只有 init 实际新建；绑定首跑和跨票续跑只是原 Session 的后续输入。
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
}

function resolveAutomationTargetServices(request: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ServiceCollection {
  const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(request);
  if (remoteSession) {
    if (!remoteSession.workspaceIdentity) {
      throw new Error("Automation 目标 Remote Host 缺少 workspaceIdentity");
    }
    return windowRemoteConnectionRegistry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: request.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    });
  }
  // 远程 Automation 找不到目标 logical session 时，旧派发会静默落到 Local Host，
  // 从而使用本地模型首选与 Registry。远程身份只能失败，不能跨 Environment fallback。
  if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
    throw new Error("Automation 目标 Remote Host 当前不可用");
  }
  if (!activeServices) {
    throw new Error("Local Host services are not initialized.");
  }
  return activeServices;
}

function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function markCronRunOutcome(params: {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): void {
  void recordCronRunOutcomeBestEffort({
    ...params,
    repo: cronAutomationRepo,
    logWarn: (message, error) => logger.warn(message, error),
  });
}

function disposeCronRunSubscription(key: string): void {
  const disposable = cronRunSubscriptions.get(key);
  if (!disposable) return;
  cronRunSubscriptions.delete(key);
  disposable.dispose();
}

async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function trackCronRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
}): void {
  const key = cronRunSubscriptionKey(params.taskId, params.traceId);
  disposeCronRunSubscription(key);
  markCronRunOutcome({ ...params, outcome: "running" });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        outcome: result.outcome,
        error: result.error,
        repo: cronAutomationRepo,
        logWarn: (message, error) => logger.warn(message, error),
      });
      // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
      disposeCronRunSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          ...params,
          repo: cronAutomationRepo,
          logWarn: (message, error) => logger.warn(message, error),
        })
      : null;
  cronRunSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * 把一次 cron/manual run 直接提交给当前 host 的 V4 task service。
 * 会话内 automation 可能绑定到未激活 session，必须先恢复再应用保存的运行参数。
 */
async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
  taskId: string;
  sessionId: string;
}> {
  const targetServices = resolveAutomationTargetServices(request);
  const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const modelSelectionService = targetServices.getOptional(IModelSelectionService);
  if (!modelSelectionService) {
    throw new Error("目标 Host Model Selection service is not initialized.");
  }
  // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
  // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
  const existingRun = await cronAutomationRepo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService,
    // Repo 已在读取前完成离线导入；不再为迁移绕行 Agent/账号服务。
    // 未迁入或损坏的新值仍由此入口明确拒绝，不能当成跟随 Workspace。
    readSelection: () =>
      cronAutomationRepo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  let trackedKey: string | null = null;
  const workspaceKey = resolveWorkspaceKey(request);
  const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
  const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await zcodeTaskService.createTask({
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          model: formatModelPickerValue(submissionModelSelection),
          mode: request.mode,
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
    // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
    // CLI 无法从 inputId 还原 manual/schedule admission。
    // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
    const promptTraceId = request.runId as TraceId;
    if (request.targetTaskId) {
      // 绑定会话在 app 重启或切换 workspace 后通常不处于 active；旧实现直接
      // setConfig/sendPrompt 会立即报 Session is not active，看起来像「立即运行」没有触发。
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyCronRunConfigToExistingTask({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    const botsService = targetServices.getOptional(IBotsService);
    if (botsService) {
      try {
        await watchCronRunBotDelivery({
          automationId: request.automationId,
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          taskId: task.taskId,
          repo: cronAutomationRepo,
          botsService,
        });
      } catch (error) {
        // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
        logger.warn(
          `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
          error,
        );
      }
    }
    trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
    trackCronRunOutcome({
      zcodeTaskService,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
    });
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    // prompt 创建的定时任务带 targetTaskId，追加原会话不能计成 session_create。
    if (!request.targetTaskId) {
      reportHostSessionCreate(parentPort, {
        sessionId: task.taskId,
        messageId: promptTraceId,
        source: "automation_scheduled",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { taskId: task.taskId, sessionId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeCronRunSubscription(trackedKey);
    markCronRunOutcome({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function dispatchManualAutomationRun(params: {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}): Promise<void> {
  logger.info(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: Awaited<ReturnType<typeof dispatchCronRun>>;
  try {
    result = await dispatchCronRun({
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      targetTaskId: params.automation.targetTaskId,
      modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
      mode: params.automation.mode,
      workspacePath: params.automation.workspacePath,
      workspaceIdentity: params.automation.workspaceIdentity,
    });
  } catch (error) {
    logger.warn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: cronAutomationRepo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: (message, releaseError) => logger.warn(message, releaseError),
    });
    throw error;
  }

  try {
    await cronAutomationRepo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
    // 真实终态仍由 trackCronRunOutcome 收口，避免同一 automation 重复排队。
    logger.warn(
      `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  // sendPrompt ACK 可能只表示进入 busy queue；manual claim 必须保留到对应 turn 终态。
  logger.info(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
}

// Node warning 不是远端连接失败，改成结构化 warn，避免默认 stderr 被误染成 error。
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// Host 进程自身的 60 秒采样：一次读数两个出口——门控后写本地
// `[memory]` 行，同一次读数换算成 HostResourceSample 经 parentPort 送 main 作 heap 来源。
// services 计数器由各 service 工厂自注册。
const hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

const runtimeProcessLifecycleReporter = {
  onSpawn(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessSpawned,
      ...event,
    });
  },
  onReady(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessReady,
      ...event,
    });
  },
  onExit(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessExited,
      ...event,
      signal: event.signal ?? null,
    });
  },
  onError(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessError,
      ...event,
    });
  },
  onException(event) {
    parentPort?.postMessage({ type: HostResponseTypes.AgentProcessException, ...event });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["processLifecycleReporter"];

const runtimeTaskReporter = {
  onRunningTaskCountChanged(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: event.runningTaskCount,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["taskRuntimeReporter"];

const cuaOperationStateReporter = {
  onStateChanged(event) {
    if (!parentPort) {
      return;
    }
    parentPort.postMessage({
      type: HostResponseTypes.CuaOperationState,
      ...event,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["cuaOperationStateReporter"];

let untrackedPromptRpcCount = 0;
function reportHostRunningTaskCount(): void {
  runtimeTaskReporter.onRunningTaskCountChanged({
    runningTaskCount: workspaceTaskTracker.getTotalRunningTaskCount() + untrackedPromptRpcCount,
  });
}

const workspaceTaskTracker = createHostWorkspaceTaskTracker((event) => {
  parentPort?.postMessage({
    type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
    ...event,
  });
  windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount(event);
  reportHostRunningTaskCount();
});

function isZCodeTaskMeta(value: unknown): value is ZCodeTaskMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "workspacePath" in value &&
    "traceId" in value &&
    typeof (value as { taskId?: unknown }).taskId === "string" &&
    typeof (value as { workspacePath?: unknown }).workspacePath === "string" &&
    typeof (value as { traceId?: unknown }).traceId === "string"
  );
}

function isRemoteMirrorableStreamEvent(
  event: ZCodeStreamEvent,
): event is TaskStreamMirrorableEvent {
  return event.type !== "task_stream_mirror_batch" && event.type !== "task_snapshot_updated";
}

function createReportingRemoteZCodeTaskService<T extends object>(
  service: T,
  options?: {
    reportRunningPromptCount?: boolean;
    taskRealtimePort?: ReturnType<typeof createTaskRealtimeBridgeForHostInit>;
    materializePromptAttachments?: (params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    }) => Promise<{ content: string; attachments?: ZCodePromptAttachment[] }>;
  },
): T {
  const workspaceProxyState = createHostRemoteWorkspaceProxyState();

  function forwardSessionMessageRequest(request: unknown): void {
    parentPort?.postMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });
  }

  function subscribeSessionMessageRequests(target: T, meta: ZCodeTaskMeta): void {
    const onDynamicWorkspaceEvent = Reflect.get(target, "onDynamicWorkspaceEvent");
    if (typeof onDynamicWorkspaceEvent !== "function") {
      return;
    }
    const subscribe = onDynamicWorkspaceEvent.call(target, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    if (typeof subscribe !== "function") {
      return;
    }
    workspaceProxyState.ensureWorkspaceSubscription(meta, () =>
      subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "workspace_session_message_send_requested"
        ) {
          forwardSessionMessageRequest((event as { request?: unknown }).request);
        }
      }),
    );
  }

  function rememberTaskMeta(result: unknown): void {
    if (isZCodeTaskMeta(result)) {
      workspaceProxyState.rememberTaskMeta(result);
      subscribeSessionMessageRequests(service, result);
      parentPort?.postMessage({
        type: HostResponseTypes.SessionRouteAnnounce,
        route: {
          sessionId: result.taskId,
        },
      });
    }
  }

  function rememberTaskMetasFromResult(result: unknown): void {
    if (Array.isArray(result)) {
      for (const item of result) {
        rememberTaskMetasFromResult(item);
      }
      return;
    }
    rememberTaskMeta(result);
    if (typeof result !== "object" || result === null) {
      return;
    }
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        rememberTaskMeta(item);
      }
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      rememberTaskMeta((snapshot as { meta?: unknown }).meta);
    }
    rememberTaskMeta((result as { meta?: unknown }).meta);
  }

  async function prepareRemotePromptParams(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }): Promise<{
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }> {
    if (!options?.materializePromptAttachments) {
      return params;
    }
    return {
      ...params,
      ...(await options.materializePromptAttachments(params)),
    };
  }

  async function mirrorRemotePrompt(
    target: T,
    sendPrompt: (...args: unknown[]) => Promise<unknown>,
    params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    },
  ): Promise<unknown> {
    const taskRealtimePort = options?.taskRealtimePort;
    const meta = workspaceProxyState.getTaskMeta(params.taskId);
    if (!taskRealtimePort || !meta) {
      return sendPrompt.call(target, params);
    }

    const mirrorTarget = {
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(meta),
      taskId: params.taskId,
      runId: params.traceId,
      traceId: params.traceId,
    };
    const leaseResult = await taskRealtimePort
      .acquireTaskRunLease(mirrorTarget)
      .catch((error: unknown) => {
        logger.warn("Bot remote runtime realtime lease failed:", error);
        return null;
      });
    if (!leaseResult?.acquired) {
      return sendPrompt.call(target, params);
    }

    taskRealtimePort.publishStreamOp(mirrorTarget, {
      kind: "user_message",
      messageId: `user-${params.traceId}`,
      content: params.content,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    // 写路径（send/stop/交互回执）已收敛 v4 命令面；本镜像属**读路径**——
    // taskRealtimePort → 手机 relay → 手机端
    // zcodeSessionStore 的整条消费链词表都是 ZCodeStreamEvent。两个方案的评估结论：
    // a) relay 直接转发 v4 帧、手机端消费 v4 store（正解）：需要重做 relay stream-op
    //    协议 + 手机端 store；
    // b) 帧→ZCodeStreamEvent 薄映射：等价复刻 adapter mapSessionEvent，
    //    否决。
    // 结论：本镜像保持 legacy 源不动。
    const dynamicStreamEvent = Reflect.get(target, "onDynamicStreamEvent");
    const streamDisposable =
      typeof dynamicStreamEvent === "function"
        ? dynamicStreamEvent.call(
            target,
            params.taskId,
          )((event: ZCodeStreamEvent) => {
            if (isRemoteMirrorableStreamEvent(event)) {
              taskRealtimePort.publishStreamOp(mirrorTarget, {
                kind: "stream_event",
                event,
              });
            }
          })
        : null;

    try {
      return await sendPrompt.call(target, params);
    } finally {
      // 远端 zcode-server 没有 desktop realtime port；由窗口 Host 内的
      // remote facade 接管 lease 和 stream mirror，确保 UI 能持续收到远端会话流。
      streamDisposable?.dispose();
      taskRealtimePort.releaseTaskRunLease(mirrorTarget);
    }
  }

  function finishWorkspaceTask(taskId: string, meta: ZCodeTaskMeta): void {
    workspaceProxyState.disposeTaskReadySubscription(taskId);
    workspaceTaskTracker.finish(taskId, meta);
  }

  function beginWorkspaceTask(target: T, taskId: string, meta: ZCodeTaskMeta): boolean {
    const started = workspaceTaskTracker.begin(taskId, meta);
    if (!started) {
      return false;
    }
    const onDynamicTaskReady = Reflect.get(target, "onDynamicTaskReady");
    if (typeof onDynamicTaskReady !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task service does not expose onDynamicTaskReady");
    }
    const subscribe = onDynamicTaskReady.call(target, taskId);
    if (typeof subscribe !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task ready event is not subscribable");
    }
    workspaceProxyState.trackTaskReady(
      taskId,
      meta,
      (listener) => subscribe(listener),
      () => finishWorkspaceTask(taskId, meta),
    );
    return true;
  }

  // remote workspace 的 ZCode Agent manager 跑在远端 server，desktop main 不能直接看到
  // `handles` 状态。sendPrompt Promise 只是远端 ACK，必须等待 task ready 才能允许回收 workspace。
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "createTask" || property === "resumeTask") && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMeta(result);
          return result;
        };
      }
      if (
        (property === "listTasks" ||
          property === "listPinnedTasks" ||
          property === "listTaskList" ||
          property === "listArchivedTasks" ||
          property === "getTaskMeta" ||
          property === "getTaskSnapshot" ||
          property === "getTaskSnapshotWithEtag") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMetasFromResult(result);
          return result;
        };
      }
      if (property === "releaseWorkspacePreparation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const context = args[0];
          if (
            typeof context === "object" &&
            context !== null &&
            typeof (context as { workspacePath?: unknown }).workspacePath === "string"
          ) {
            const workspaceContext = context as {
              workspacePath: string;
              workspaceIdentity?: string;
            };
            // pooled Host 不随 tab 退出；runtime 成功释放后必须同步解除 Host 代理层引用，
            // 否则 task meta 和动态事件 listener 会在整个应用生命周期内单调增长。
            workspaceProxyState.clearWorkspace(workspaceContext);
            workspaceTaskTracker.clearWorkspace(workspaceContext);
          }
          return result;
        };
      }
      const shouldWrapSendPrompt =
        options?.reportRunningPromptCount !== false ||
        Boolean(options?.taskRealtimePort) ||
        Boolean(options?.materializePromptAttachments);
      if (property !== "sendPrompt" || typeof value !== "function" || !shouldWrapSendPrompt) {
        return value;
      }

      return async (...args: unknown[]) => {
        let trackedTask: { taskId: string; meta: ZCodeTaskMeta; started: boolean } | undefined;
        let tracksOnlyRpcLifetime = false;
        try {
          const params = args[0];
          if (
            typeof params === "object" &&
            params !== null &&
            typeof (params as { taskId?: unknown }).taskId === "string" &&
            typeof (params as { traceId?: unknown }).traceId === "string" &&
            typeof (params as { content?: unknown }).content === "string"
          ) {
            const promptParams = params as {
              taskId: string;
              traceId: TraceId;
              content: string;
              attachments?: ZCodePromptAttachment[];
            };
            const taskMeta = workspaceProxyState.getTaskMeta(promptParams.taskId) as
              | ZCodeTaskMeta
              | undefined;
            if (taskMeta) {
              trackedTask = {
                taskId: promptParams.taskId,
                meta: taskMeta,
                started: beginWorkspaceTask(target, promptParams.taskId, taskMeta),
              };
            } else if (options?.reportRunningPromptCount !== false) {
              // task meta 缺失时无法安全伪造 workspace identity；仅保留 ACK 期间的 Host 退出诊断，
              // 不让该 fallback 参与 workspace runtime 的释放裁决。
              tracksOnlyRpcLifetime = true;
              untrackedPromptRpcCount += 1;
              reportHostRunningTaskCount();
            }
            const preparedParams = await prepareRemotePromptParams(promptParams);
            return await mirrorRemotePrompt(
              target,
              value.bind(target) as (...promptArgs: unknown[]) => Promise<unknown>,
              preparedParams,
            );
          }
          if (options?.reportRunningPromptCount !== false) {
            tracksOnlyRpcLifetime = true;
            untrackedPromptRpcCount += 1;
            reportHostRunningTaskCount();
          }
          return await value.apply(target, args);
        } catch (error) {
          if (trackedTask?.started) {
            finishWorkspaceTask(trackedTask.taskId, trackedTask.meta);
          }
          throw error;
        } finally {
          if (tracksOnlyRpcLifetime) {
            untrackedPromptRpcCount = Math.max(0, untrackedPromptRpcCount - 1);
            reportHostRunningTaskCount();
          }
        }
      };
    },
  });
}

function warmUpZCodeAgent(
  services: ServiceCollection,
  context: { workspacePath?: string; workspaceIdentity?: string },
  reason: string,
): void {
  if (!context.workspacePath) {
    return;
  }
  const workspacePath = context.workspacePath;
  const workspaceIdentity = context.workspaceIdentity;
  const zcodeSessionService = services.getOptional(IZCodeSessionService);
  if (!zcodeSessionService) {
    return;
  }
  void zcodeSessionService
    .initializeWorkspace({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .then((result) => {
      if (!result.available) {
        if (result.reasonCode === "provider_not_ready") {
          logger.info(
            `ZCode agent warmup waiting for provider/model (${reason}) workspace=${workspacePath}`,
          );
          return;
        }
        logger.warn(
          `ZCode agent warmup unavailable (${reason}) workspace=${workspacePath} reason=${result.reason ?? "unknown"}`,
        );
        return;
      }
      // 模型候选和首选项已经由目标 Host ModelSelectionView 提供；workspace
      // presentation 只剩 mode 与 slash commands。预热不能为读取 presentation 额外创建
      // Agent App，否则其 MCP close 会占住协议通道并阻塞真正的 Session 初始化。
      logger.info(
        `ZCode agent warmup ready (${reason}) workspace=${workspacePath} transport=${result.transportKind ?? "unknown"}`,
      );
    })
    .catch((error) => {
      logger.warn(`ZCode agent warmup failed (${reason}) workspace=${workspacePath}:`, error);
    });
}

// 后台输出轮询仍需独立的 debug logger，不能随其他日志调用方移除而丢失工厂导入。
const rpcDebugLogger = createServiceLogger("rpc");

function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
    case "docker":
      return `docker:${target.container}`;
  }
}

console.log = (...args: unknown[]) => {
  rawConsole.log(...args);
  reportHostLog("info", args);
  remoteConnectionProgressContext.report("info", args);
};

console.warn = (...args: unknown[]) => {
  rawConsole.warn(...args);
  reportHostLog("warn", args);
  remoteConnectionProgressContext.report("warn", args);
};

console.error = (...args: unknown[]) => {
  rawConsole.error(...args);
  // Electron 会把 Node warning 先走 console.error，而 process warning listener 随后还会
  // 结构化记录 warn；若这里继续上报，就会为同一个 warning 留下一条 error 和一条 warn。
  if (!shouldReportHostConsoleError(args)) {
    return;
  }
  reportHostLog("error", args);
  remoteConnectionProgressContext.report("error", args);
};

/** 当前 host 已注册的服务集合，进程退出时用于统一回收本地资源 */
let databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
const pendingStartupAttachments = new Map<string, () => void>();
let activeServices: ServiceCollection | null = null;
let activeHostApiNetworkTransport: HostApiNetworkTransport | null = null;
/** 本地 host services 的资源遥测订阅；远端连接的订阅由各自的 connection handle 持有。 */
let activeLocalResourceTelemetry: IDisposable | null = null;
/** 免费额度 HTTP 桥实例（ZCODE_BRIDGE=1 时启动）。 */
let activeZCodeBridge: ZCodeBridge | null = null;
// 资源管理器采样只在 main 请求时执行一次，Host 不维护任何周期定时器。
const hostResourceUsageResponder = createHostResourceUsageResponder({
  getAgentService: () => activeServices?.getOptional(IZCodeAgentService),
  postMessage: (message) => parentPort?.postMessage(message),
});
let activeSessionRealtimePort: ReturnType<typeof createTaskRealtimeBridgeForHostInit> = null;
let hasDisposedHostResources = false;
let disposeHostResourcesInFlight: Promise<HostShutdownResult> | null = null;

function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!activeHostApiNetworkTransport) {
    // Bug 原因：remote asset 若在 Host 网络策略就绪前回退 global fetch，会绕过设置页显式代理。
    throw new Error("Window Host network transport is not initialized");
  }
  return activeHostApiNetworkTransport;
}

async function resolveDesktopRemoteRuntimeNetwork(
  target: RemoteTarget,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (target.kind !== "wsl") {
    return undefined;
  }
  const settingService = activeServices?.getOptional(ISettingService);
  if (!settingService) {
    return undefined;
  }
  try {
    const settings = await settingService.get();
    return {
      authoritative: true,
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
    };
  } catch {
    // 设置读取失败时保留原有远程连接行为，不让网络增强把 WSL 工作区直接阻断。
    return undefined;
  }
}

async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  await connection.disposeAndWait({ timeoutMs: 5_000 });
}

async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("远程连接已取消");
  }
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  const connection = await setupRemoteConnection(
    params.target,
    params.remoteAssets,
    { fetch: requireActiveHostApiNetworkTransport().fetch },
    await resolveDesktopRemoteRuntimeNetwork(params.target),
    (exitCode) => notifyClose({ exitCode, signal: null }),
    params.target.kind === "ssh" ? "caller-serialized" : "remote",
    params.target.kind === "ssh" ? params.signal : undefined,
  );

  if (params.signal.aborted) {
    await disposeHostRemoteConnection(connection);
    throw new Error("远程连接已取消");
  }

  const backendConnection = connection;
  const materializePromptAttachments = async (request: {
    taskId: string;
    traceId: TraceId | string;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }) => {
    const result = await materializeRemotePromptAttachments(request, {
      backend: backendConnection.backend,
    });
    return { content: result.content, attachments: result.attachments };
  };
  const promptAttachmentTransferService = createRemotePromptAttachmentTransferService(
    backendConnection.backend,
    {
      onJanitorError: (error: unknown) =>
        logger.warn("remote prompt attachment janitor failed", error),
    },
  );
  const services = createRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: backendConnection.services,
    sourceServices: activeServices ?? undefined,
    parentPort,
    createRemotePromptAttachmentSessionService: (service) =>
      createRemotePromptAttachmentSessionService(service, {
        materializePromptAttachments,
      }),
    createRemotePromptAttachmentTaskService: (service) =>
      createRemotePromptAttachmentTaskService(service, {
        materializePromptAttachments,
      }),
    createReportingRemoteZCodeTaskService: (service) =>
      createReportingRemoteZCodeTaskService(service, {
        taskRealtimePort: activeSessionRealtimePort ?? undefined,
      }),
    promptAttachmentTransferService,
    runtimePreferencesBridge: {
      onError: (error: unknown) => logger.warn("remote runtime preferences bridge failed", error),
    },
  });

  let disposed = false;
  // 远端 workspace 的 CLI 与 MCP 样本走与本地同一条路径：远端 zcode-server → 本地 Host → main。
  // 订阅寿命等于这份远端 services 的寿命：由 connection handle 持有，registry 释放 entry
  // （WSL idle 回收、最后一个 logical session 关闭、掉线后的 session 清理）时随 dispose 一起收口。
  const resourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "remote",
    environmentKey: resolveResourceTelemetryEnvironmentKey(params.target),
    onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
  });
  const remoteMediaPreviewFactory = !remoteMediaRangePreviewEnabled
    ? undefined
    : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
        createRemoteMediaPreviewProxy({
          fileService: services.get(IFileService),
          logger: {
            debug: (message, metadata) => {
              if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
            },
            warn: (message, metadata) => logger.warn(message, metadata),
          },
          scope,
          requestLimiter: hostRemoteMediaRequestLimiter,
        });
  return {
    services,
    capabilities:
      "backend" in connection
        ? {
            browserRecordingUploader: connection.backend,
            ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
          }
        : {},
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      closeListeners.clear();
      resourceTelemetry.dispose();
      await disposeServiceResourcesAndWait(services);
      await disposeHostRemoteConnection(connection);
    },
  };
}

const windowRemoteConnectionRegistry = createWindowRemoteConnectionRegistry<
  ServiceCollection,
  HostRemoteConnectionCapabilities
>({
  connect: (request) => createWindowRemoteConnectionHandle(request),
  createId: randomUUID,
  releaseWorkspace: async (services, context) => {
    await services.get(IZCodeTaskService).releaseWorkspacePreparation({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      provider: "glm",
    });
    logger.info(
      `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
    );
  },
  onWorkspaceReleaseError: (context, error) => {
    logger.warn(
      `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      error,
    );
  },
  onSessionClosed: (event) => {
    // logical session 已离线时 attachment 仍持有旧 services/订阅；后续 sessionId
    // 换代只释放 transport，无法按旧 ID 找回这些端口。Host 在失效源头统一关闭所有 clientMode。
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(event.remoteSessionId);
    const session = windowRemoteConnectionRegistry.getSession(event.remoteSessionId);
    if (session?.workspacePath && session.workspaceIdentity) {
      windowHostControllerRuntime.disconnectSource({
        kind: "remote",
        remoteSessionId: event.remoteSessionId,
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
      });
    }
    parentPort?.postMessage({
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: event.remoteSessionId,
      reason: "connection-closed",
      exitCode: event.exitCode,
      signal: event.signal,
      ...(event.error ? { error: event.error } : {}),
    });
    logWindowHostTopology("remote-connection-closed");
  },
});

const windowHostControllerRuntime = createWindowHostControllerRuntime({
  createId: randomUUID,
  onSourceError: (scope, operation, error) => {
    logger.warn(
      `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
      error,
    );
  },
  resolveSource: (scope) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
      const controllerScope = {
        kind: "remote" as const,
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: remoteSession.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      };
      if (remoteSession.sourceAvailability !== "online") {
        return { scope: controllerScope, sourceAvailability: "offline" as const };
      }
      const services = windowRemoteConnectionRegistry.resolveScopedServices(controllerScope);
      return {
        scope: controllerScope,
        taskService: services.get(IZCodeTaskService),
        agentService: services.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    }
    // 远程 history scope 未连接或已被移除时，绝不能落回本地 tasks-index。
    if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
      return null;
    }
    const taskService = activeServices?.getOptional(IZCodeTaskService);
    if (!taskService) {
      return null;
    }
    return {
      scope: {
        kind: "local" as const,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      },
      taskService,
      agentService: activeServices?.getOptional(IZCodeAgentService),
      sourceAvailability: "online" as const,
    };
  },
});

/**
 * 静默后台模式开关（`ZCODE_QUIET=1`）。
 *
 * 开启后跳过**纯诊断性质**的后台常驻订阅 —— 这些订阅只服务于本地遥测面板，
 * 对模型调用链路零贡献，却会让日志每 60 秒刷一批 `perf_* flushed` /
 * `memory role=...`（实测：3 分钟产生 ~60 行噪音）。
 *
 * 保留的是功能性订阅（task index 同步、session 广播、模型选择），
 * **不要**在这里加它们的开关 —— 那些一关就会破坏会话。
 */
function isQuietMode(): boolean {
  return process.env["ZCODE_QUIET"] === "1";
}

function wireLocalResourceTelemetry(services: ServiceCollection): void {
  activeLocalResourceTelemetry?.dispose();
  if (isQuietMode()) {
    activeLocalResourceTelemetry = null;
    logger.info("[quiet] local resource telemetry disabled (ZCODE_QUIET=1)");
    return;
  }
  activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

/**
 * 免费额度 HTTP 桥（可选，默认关闭）。
 *
 * 用途：把**只有本进程能走通**的免费额度通道（`account:bigmodel-start-plan` + captcha）
 * 暴露成本地 HTTP 接口，供外部程序（如 DSH 插件）调用。
 *
 * 为什么必须在这里做：
 *   - 该通道强制要求阿里云 captcha，而 captcha 只能在渲染进程里跑（需要 DOM + CDN 脚本）；
 *   - 请求由本 host 发出，渲染进程经 `interaction/requestProviderRuntimeHeaders` 回传验证头；
 *   - 外部进程无法复用这条链：`app-server` 只支持 `--stdio`（父子私有管道），
 *     而独立 spawn 的 app-server 走 `standalone` 路径——该路径硬编码只支持
 *     `individual-coding-plan` 且永不产 captcha 头。
 *
 * 开关：环境变量 `ZCODE_BRIDGE=1`（默认关闭，避免影响正常使用）。
 * 端口：随机分配并写入 `<dataBaseDir>/.zcode/v2/bridge-port.json`（含 token）。
 */
async function startZCodeBridgeIfEnabled(services: ServiceCollection): Promise<void> {
  if (process.env["ZCODE_BRIDGE"] !== "1") return;

  const taskService = services.getOptional(IZCodeTaskService);
  if (!taskService) {
    logger.warn("ZCode bridge skipped: IZCodeTaskService unavailable");
    return;
  }

  // 推理档位。默认仍是 `"max"` —— **不擅自降级**，因为档位直接影响回答质量，
  // 而且很难预判用户的偏好。
  //
  // ⚠ 但要知道代价（2026-09-27 实测）：**每一轮对话都跑最高推理档**，
  //   包括「生成会话标题」「压缩摘要」这类一句话任务。历史日志里
  //   `textLength<=5` 的 41 条短请求中位耗时 **21885ms** —— 其中很大一部分
  //   就是这个档位造成的。
  //
  // ⇒ 想显著提速就把它调低（`high` / `medium`），代价是复杂任务的推理深度下降。
  //   这是**用户取舍**，不该由代码替他决定。
  const reasoningLevel = process.env["ZCODE_BRIDGE_REASONING_LEVEL"]?.trim() || "max";
  const turnTimeoutMs = Number(process.env["ZCODE_BRIDGE_TIMEOUT_MS"] ?? "") || 180_000;
  // 外部工具（MCP HTTP/SSE）—— DSH 工具面进入 ZCode 会话的唯一通道。
  const mcpServers = parseMcpServersFromEnv(process.env["ZCODE_BRIDGE_MCP"]);
  if (mcpServers) {
    logger.info(
      `[zcode-bridge] MCP servers injected: ${mcpServers.map((s) => `${s.name}(${s.type})`).join(", ")}`,
    );
  }

  /**
   * 【本地扩展】捕获壳每次产出的 provider auth 材料（含 captcha 头）。
   *
   * ## 为什么
   *
   * start-plan（免费额度）通道每次模型请求都必须带阿里云 captcha 头，而它只能
   * 在渲染进程里产出。这些材料原本只回给壳内 agent，桥拿不到 —— 于是桥只能
   * 退化成"让壳替它跑一轮对话"（工具面全丢、壳内工具会真执行、180 秒超时）。
   *
   * 通过 `registerProviderAuthMaterialObserver`（只观察、不应答，不影响壳内
   * agent）把材料抄一份存下来，桥就有机会**自己发请求**。
   *
   * ## 缓存策略：只留最新一份
   *
   * captcha param 是一次性的（每次验证都新 mint，重复提交会撞 F008），所以
   * **缓存旧值没有意义、还可能有害**。这里只保留最近一份，供"先看到材料存在"
   * 这一步验证；真正转发时应改为**每次请求现取**。
   */
  const latestAuthMaterial = {
    value: undefined as
      | {
          providerId: string;
          modelId: string;
          apiKey?: string;
          headers?: Record<string, string>;
          rawRequestAuth?: { apiKey?: string; headers?: Record<string, string> };
          requestShape?: unknown;
        }
      | undefined,
    at: 0,
  };
  const agentService = services.getOptional(IZCodeAgentService);
  if (agentService) {
    agentService.registerProviderAuthMaterialObserver((material) => {
      latestAuthMaterial.value = material;
      latestAuthMaterial.at = Date.now();
      logger.info("[zcode-bridge] 捕获到 provider auth 材料（旁路）", {
        providerId: material.providerId,
        modelId: material.modelId,
        hasApiKey: Boolean(material.apiKey),
        headerNames: Object.keys(material.headers ?? {}),
      });
    });
  } else {
    logger.warn("[zcode-bridge] IZCodeAgentService 不可用，auth 材料旁路未注册");
  }

  try {
    activeZCodeBridge = await createZCodeBridge({
      dataBaseDir: resolveZCodeDataBaseDir(),
      reasoningLevel,
      ...(mcpServers === undefined ? {} : { mcpServers }),
      log: (message, detail) => logger.info(`[zcode-bridge] ${message}`, detail),
      /**
       * ★ 触发账号登录（2026-09-28）。
       *
       * ## ⚠⚠ 重要：这里刻意做成「不完整」的，原因如下
       *
       * 曾经想做成 host → main → preload → renderer 的完整链路（让
       * `POST /oauth/login` 真正拉起登录页）。但那条链路要贯通四层、
       * 每层都有 zod schema 校验（`hostResponseMessageSchema.safeParse`），
       * 是个跨层工程；而它**与桥的核心功能无关**。
       *
       * 更严重的是：中途在 host 里写了
       * `import { BrowserWindow } from "electron"` —— host 是**纯 Node fork**，
       * 该 import 会让它启动即崩：
       *
       *   SyntaxError: Named export 'BrowserWindow' not found.
       *   The requested module 'electron' is a CommonJS module ...
       *
       * → main 侧看到 `database-startup: transport_closed`
       * → **整个应用卡在「无法完成启动准备」**（实测踩过）。
       *
       * ## 现在的形态
       *
       * 只做**能力探测与说明**，不产生副作用 —— 保证 host 绝对安全。
       * 真正的登录脚本化留待后续（或直接由 agent 用 AutoGLM 驱动浏览器，
       * 那对「打开网页」这类任务本来就够用）。
       */
      /**
       * ★ 触发账号登录（2026-09-28）。
       *
       * ## 为什么这样做
       *
       * ZCode 登录五步全在 renderer，而 `state` 必须由 ZCode 自己生成
       * （`handleCallback()` 校验 `state === pending.state`），
       * 外部无法模拟回调。唯一自动化点是「让 ZCode 自己走一遍 startLogin」。
       *
       * 链路：host --postMessage--> main --webContents.send--> renderer
       *
       * ## ⚠⚠ 绝不能在这里 import electron（踩过，代价很大）
       *
       * host 是**纯 Node fork**。写 `import { BrowserWindow } from "electron"` 会抛：
       *
       *   SyntaxError: Named export 'BrowserWindow' not found.
       *   The requested module 'electron' is a CommonJS module ...
       *
       * → host 启动即崩 → main 侧 `database-startup: transport_closed`
       * → **整个应用卡在「无法完成启动准备」**（实测，排查了很久）。
       */
      /**
       * ★ 用系统浏览器打开 URL（2026-09-28 新增）。
       *
       * ## 用途
       *
       * 服务端中介登录（`/oauth/cli-login`）需要打开一个授权页。
       * 与 `startLogin` 不同，这条路径**不需要 renderer**——
       * 授权在服务端完成，token 由轮询返回，不经过故障的 `/oauth/token`。
       *
       * ## ⚠ 同样不能 import electron
       *
       * host 是纯 Node fork（见 `startLogin` 上方的详细说明）。
       * electron 的 `shell.openExternal` 在这里拿不到，
       * 所以用 host 已有的 postMessage 通道请 main 代劳。
       */
      openUrl: async (targetUrl: string) => {
        try {
          if (!parentPort) {
            return { ok: false, message: "host 子进程没有 parentPort，无法请求主进程打开网页。" };
          }
          parentPort.postMessage({
            type: HostResponseTypes.OpenExternalUrl,
            url: targetUrl,
          });
          return { ok: true, message: "已请求主进程用系统浏览器打开授权页。" };
        } catch (error) {
          return {
            ok: false,
            message: `请求打开网页失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },

      startLogin: async ({ providerId }) => {
        try {
          if (!parentPort) {
            return { ok: false, message: "host 子进程没有 parentPort，无法转交登录请求。" };
          }
          parentPort.postMessage({
            type: HostResponseTypes.StartOAuthLogin,
            providerId,
          });
          return {
            ok: true,
            message:
              "已请求 renderer 发起登录，系统浏览器应已打开授权页。" +
              "请在浏览器完成授权，回调会自动写回凭据。",
          };
        } catch (error) {
          return {
            ok: false,
            message: `转发登录请求失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
      /**
       * 读最近一次捕获的 auth 材料（旁路）。
       *
       * 与 `resolveAuthMaterial` 的区别：那个只能拿到 apiKey（不带 captcha 头），
       * 这个拿的是壳**实际用于发请求**的完整材料 —— 含 captcha。诊断端点优先用它。
       */
      getLatestAuthMaterial: () => latestAuthMaterial.value,
      /**
       * 主动 mint 新鲜材料（含 captcha 头）。
       *
       * captcha param 一次性，观察到的旧材料复用会撞 3007；要自己发请求就必须
       * 每次现 mint。具体机制见 `mintProviderAuthMaterial` 的说明。
       */
      mintAuthMaterial: async ({ providerId, modelId, workspacePath, sessionId }) => {
        const agent = services.getOptional(IZCodeAgentService);
        if (!agent) return undefined;
        return await agent.mintProviderAuthMaterial({
          // ⚠ workspacePath 必须与 renderer 订阅的那个桶一致。
          //
          // captcha 事件面按 resolveWorkspaceKey(workspace) 分桶，不同 key 是
          // **不同的 Emitter 实例**；renderer 回调里还有一层
          // requestBelongsToWorkspace 路径过滤。用错的路径 → 事件投递到没人
          // 监听的桶 → 稳定 20 秒超时，且 renderer 侧连 request.received 都
          // 不打日志（极易被误判为"captcha 组件没渲染"）。
          //
          // 调用方（桥）传的是它自己跑会话链路用的同一个路径，两者天然一致。
          // 缺省才退回数据根目录（仅为兼容，不保证能收到应答）。
          workspace: {
            workspacePath: workspacePath?.trim() || resolveZCodeDataBaseDir(),
          },
          providerId,
          modelId,
          ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}),
        });
      },
      /**
       * 【诊断 / 性能实验】直接调 agent 的 `workspace/generateText`。
       *
       * 与 `runConversation`（createTask + sendPrompt，完整 agent turn）的区别：
       * 这个方法**不建 task、不跑 turn 循环** —— 只是「一次模型调用」。
       * 协议定义见 `packages/shared/src/zcode-protocol/index.ts:2075`，
       * 服务侧实现见 `zcodeAgentService.ts:4819`（`getClient()` 复用同一连接）。
       *
       * 目的是**量化 turn 循环占那 20 秒里的多少**：
       *   - 明显更快 → 应当把 adapter 改到这条路上
       *   - 一样慢   → 开销在 captcha/模型本身，与 turn 无关
       */
      generateWorkspaceText: async ({
        workspacePath,
        providerId,
        modelId,
        reasoningLevel,
        messages,
        maxOutputTokens,
      }) => {
        const agent = services.getOptional(IZCodeAgentService);
        if (!agent) {
          throw new Error("IZCodeAgentService unavailable");
        }
        // 与 runConversation 用同一个 workspacePath，确保 captcha 分桶一致。
        const result = await agent.generateWorkspaceText({
          workspacePath,
          workspaceKey: resolveWorkspaceKey(workspacePath),
          // ⚠ selection 的形状必须严格匹配 `modelSelectionSchema`
          //   （`packages/shared/src/model-selection.ts:5-16`，`.strict()`）：
          //     { providerId, modelId, options?: { reasoningLevel?: string } }
          //
          //   实测踩过两次，两个错误方向都试过：
          //   ① 写成顶层 `reasoningLevel`
          //      → `Invalid params — selection: Unrecognized key: "reasoningLevel"`
          //   ② 完全不传 options
          //      → `Reasoning level is required for account:.../GLM-5.3-Flash`
          //   ⇒ 正确形状是 **`options.reasoningLevel`**，且对 start-plan 账号**必填**。
          selection: {
            providerId,
            modelId,
            options: { reasoningLevel: reasoningLevel ?? "max" },
          },
          messages,
          querySource: "bridge-diagnostics",
          // ⚠ `maxOutputTokens` 对 workspace/generateText 是**必填**，且必须落在
          //   模型自身的取值域内。
          //
          // 依据：`apps/zcode-cli/packages/adapters/src/model/model.ts:106-118`
          //   if (maxOutputTokens === undefined || ... || > specs.maxOutputTokens.max)
          //     throw invalidRequest("maxOutputTokens is outside the model option range")
          // —— **undefined 也抛这个错**，所以「不传」不是选项。
          //
          // 桥这一侧不知道模型的上限，所以取一个**保守但足够**的值：8192。
          // 本端点是性能探针，不需要精确控制输出长度；普通对话远用不到 8K。
          maxOutputTokens: maxOutputTokens ?? 8192,
        });
        return {
          text: result.text ?? "",
          ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
        };
      },
      /**
       * 【诊断】测模型连通性 —— 协议里最轻的「真实模型调用」。
       *
       * 依据：`zcodeAgentService.ts:4876` 的实现
       *     async testModelConnectivity(params) {
       *       const client = await getClient(params);
       *       await ensureAccountProviderConfigSynced({ client, reason: "provider_test_model_connectivity", workspace: params });
       *       return client.request(zcodeProtocolMethods.providerTestModelConnectivity, {
       *         workspace: buildWorkspaceRef(params),
       *         selection: params.selection,
       *       }, zcodeProviderTestModelConnectivityResultSchema, { signal: params.signal });
       *     }
       *
       * 注意它**复用同一个 `getClient()`**（与 generateWorkspaceText 相同），
       * 所以它不会新建连接 —— 差异只在协议方法本身。
       */
      testModelConnectivity: async ({ workspacePath, providerId, modelId, reasoningLevel }) => {
        const agent = services.getOptional(IZCodeAgentService);
        if (!agent) {
          throw new Error("IZCodeAgentService unavailable");
        }
        const result = await agent.testModelConnectivity({
          workspacePath,
          workspaceKey: resolveWorkspaceKey(workspacePath),
          // 与 generateWorkspaceText 同样的 selection 形状（modelSelectionSchema，strict）
          selection: {
            providerId,
            modelId,
            options: { reasoningLevel: reasoningLevel ?? "max" },
          },
        });
        return { success: result.success === true };
      },
      /**
       * 解析请求鉴权材料（`{ apiKey, headers }`），供诊断端点用。
       *
       * ## 为什么需要它
       *
       * 桥现在走会话链路（`runConversation`），把壳当"对话代理"用 ——
       * 工具面进不去、壳内工具会真的执行（180 秒超时的根源）、且会话状态
       * 导致必须串行。
       *
       * 若这条路能拿到完整的 `{ apiKey, headers }`，桥就能**裸发标准 HTTP
       * 请求**到上游：工具面原生可用、无壳内工具干扰、可并发。
       *
       * ## 材料的两个来源（缺一不可）
       *
       *   1. `apiKey` —— `IAccountRequestAuthService.resolveCurrent()`
       *   2. captcha 头（`X-Aliyun-Captcha-Verify-Param` / `-Region`）
       *      —— 只能在 Renderer 里产出，经 `providerRuntimeHeaders.request`
       *      会话事件面广播、由 Renderer 回调应答。
       *
       * 本实现只覆盖第 1 部分。第 2 部分需要在诊断端点里另行驱动 Renderer，
       * 尚未接通 —— 所以当前端点用于**验证路线可行性**（apiKey 是否可独立取得），
       * 而不是直接拿去发请求。
       */
      resolveAuthMaterial: async ({ providerId, modelId }) => {
        const authService = getAccountRequestAuthService(services);
        if (!authService) {
          logger.warn("ZCode bridge diagnostics: IAccountRequestAuthService unavailable");
          return undefined;
        }
        // start-plan 的 accountAccess 是静态可构造的（见 zcodeProviderAccountAccessSchema）。
        const accountAccess = {
          type: "zhipu-account" as const,
          accountType: "bigmodel" as const,
          mode: "start-plan" as const,
          entitled: true,
        };
        const material = await authService.resolveCurrent({
          providerId,
          modelId,
          accountAccess,
          reason: "model-request",
        });
        return material;
      },
      /**
       * 走**会话链路**（与界面同款），而非 workspace/generateText。
       *
       * 实测：同一实例同一时刻，界面路径 200，generateWorkspaceText 走 3012。
       * 所以这里 createTask → sendPrompt，与 `botsService.ts:4868` 同构。
       */
      runConversation: async (params) => {
        const workspacePath = params.workspacePath;
        const modelSelection = {
          providerId: params.providerId,
          modelId: params.modelId,
          options: { reasoningLevel: params.reasoningLevel ?? reasoningLevel },
        };

        // 1. 创建 task（会同步建 ZCode session）
        //
        //    mcpServers：外部工具注入通道。`sendPrompt` 只有 toolDenylist
        //    没有 allowlist，所以 DSH 的工具面只能经 MCP 进入会话。
        //
        //    ⚠ `headers` 在本模块是可选的（`ZCodeBridgeMcpServer.headers?`），
        //      而壳内 `createTask` 要求它必填。桥这一侧没有头就显式给空数组，
        //      而不是把 undefined 递进去（曾因此报 TS2345）。
        const task = await taskService.createTask({
          workspacePath,
          modelSelection,
          v4Create: true,
          ...(params.mcpServers === undefined
            ? {}
            : {
                mcpServers: params.mcpServers.map((server) => ({
                  ...server,
                  headers: server.headers ?? [],
                })),
              }),
        });
        const taskId = task.taskId;
        // 【实验】把真实 taskId 落盘，供 `/diagnostics/direct` 用 `sessionId` 复用。
        //
        // 背景：`mintProviderAuthMaterial` 默认凭空造 sessionId → 上游 3012
        // （0.15 秒浅层拒绝）。而 `sessionId === taskId`
        // （本文件 L979：`return { taskId: task.taskId, sessionId: task.taskId }`），
        // 所以把真实 taskId 记下来，就能让 mint 的材料绑定到**已注册的会话**。
        try {
          writeFileSync(
            join(resolveZCodeDataBaseDir(), "bridge-last-task.json"),
            JSON.stringify({ taskId, sessionId: taskId, at: Date.now() }),
            "utf8",
          );
        } catch {
          /* 诊断用，失败不影响主流程 */
        }
        // 2-0.【真流式】建立**会话级**动态事件订阅（onDynamicTaskEvent）。
        //
        // 背景（HANDOFF-BRIDGE-BLOCKER.md §六，旧「收不到」归因已被推翻）：
        // 此前 `onDynamicStreamEvent(taskId)` 收不到任何事件，真正原因**不是**
        // emitter 实例不共享 —— 两者本就是同一实例（zcodeTaskServiceAdapter 的
        // emitTaskEvent 同时 fire task/global 两个 emitter）。真正原因是：这棵
        // 事件树的生产者 `mapServiceEvent` 只有在 `onDynamicTaskEvent` 建立
        // agentService 会话订阅之后才会被调用 —— 桥此前从未调用过它，没有任何
        // 代码路径往 emitter 里 fire。
        //
        // ⇒ 在 createTask 后立刻建立订阅（deliveryKind "continuous"，与
        //   botsService.ts:4206-4221 的标准用法同构），mapServiceEvent 开始运行：
        //   - `agent_message_chunk`（一等文本增量，event.content）累积后喂给
        //     onPartialText —— 这就是真流式源；
        //   - `tool_call` / `tool_call_update` 经 global emitter 复活下方 2a 的
        //     onDynamicStreamEvent 捕获（工具面透传同样受益）。
        //
        // onPartialText 语义保持「累积全文」（见 ZCodeBridgeDeps 注释）：这里自己
        // 做 chunk → 累积文本，调用方（桥）仍按长度差量推送。
        //
        // 【实验落盘】每个 text 增量实时追加 NDJSON（绝对毫秒 + 相对毫秒），用于
        // 验证「增量次数 ≥10 且时间戳分布均匀 = 真流式源确认」。
        const streamLogPath = join(resolveZCodeDataBaseDir(), "_stream_events.jsonl");
        const streamStartedAt = Date.now();
        let accumulatedText = "";
        const dynamicTaskSub = taskService.onDynamicTaskEvent({
          workspacePath,
          taskId,
          deliveryKind: "continuous",
        })((event) => {
          const record = event as {
            type?: unknown;
            content?: unknown;
            parentToolUseId?: unknown;
          };
          if (record.type !== "agent_message_chunk") return;
          // parentToolUseId 非空 = 子 agent 增量，不属于主回复流。
          if (record.parentToolUseId !== null && record.parentToolUseId !== undefined) return;
          const delta = typeof record.content === "string" ? record.content : "";
          if (delta.length === 0) return;
          try {
            appendFileSync(
              streamLogPath,
              JSON.stringify({
                at: Date.now(),
                sinceStartMs: Date.now() - streamStartedAt,
                taskId,
                len: delta.length,
                text: delta.slice(0, 120),
              }) + "\n",
            );
          } catch {
            // 落盘失败不影响主流程。
          }
          if (params.onPartialText === undefined) return;
          accumulatedText += delta;
          params.onPartialText(accumulatedText);
        });

        // 2a.【工具面透传】订阅结构化流事件，收集模型发起的工具调用。
        //
        // ## 为什么能这么做（子代理实读代码确认）
        //
        // `IZCodeTaskService.onDynamicStreamEvent(taskId)` 推的 `ZCodeStreamEvent`
        // 是一等公民事件：其中的 `tool_call` 带 `toolId` / `toolName` / `input`
        // （完整参数），`tool_call_update` 带 `status` / `content` / `error`。
        //
        // 这条通道**纯进程内**（adapter 的 `getGlobalTaskEmitter` 直接 fire），
        // 桥与 agent 同进程，所以能直接订阅 —— 不需要 MCP、不需要 RPC。
        //
        // ## 用途
        //
        // 让工具调用以**结构化**形式回到 DSH，而不是靠提示词模拟。
        // 这是「工具面原生可用」的正道：模型调什么、参数是什么，都是上游自己
        // 产出的，不用猜、不用解析文本。
        const capturedToolCalls: Array<{
          toolId: string;
          toolName?: string;
          input: unknown;
          status?: string;
          output?: unknown;
          error?: string;
        }> = [];
        const toolIndexById = new Map<string, number>();

        const streamSub = taskService.onDynamicStreamEvent(taskId)((event) => {
          const record = event as {
            type?: unknown;
            toolId?: unknown;
            toolName?: unknown;
            input?: unknown;
            status?: unknown;
            content?: unknown;
            error?: unknown;
          };
          // 【诊断】把每个流事件落到文件 —— 用文件而不是 logger，
          // 因为 host logger 的签名可能吞掉多参数调用，且事件频率高。
          if (params.allowTools === true) {
            try {
              appendFileSync(
                join(resolveZCodeDataBaseDir(), "bridge-stream-events.ndjson"),
                `${JSON.stringify({
                  at: Date.now(),
                  taskId,
                  type: String(record.type),
                  toolId: record.toolId,
                  toolName: record.toolName,
                  keys: Object.keys(record),
                })}\n`,
              );
            } catch {
              // 诊断失败不影响主流程。
            }
          }
          if (record.type === "tool_call") {
            const toolId = typeof record.toolId === "string" ? record.toolId : "";
            if (toolId.length === 0) return;
            if (!toolIndexById.has(toolId)) {
              toolIndexById.set(toolId, capturedToolCalls.length);
              capturedToolCalls.push({
                toolId,
                ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
                input: record.input,
              });
            }
            return;
          }
          if (record.type === "tool_call_update") {
            const toolId = typeof record.toolId === "string" ? record.toolId : "";
            const index = toolIndexById.get(toolId);
            if (index === undefined) return;
            const entry = capturedToolCalls[index];
            if (entry === undefined) return;
            // 就地补全：update 会先后带来 name / status / output。
            if (entry.toolName === undefined && typeof record.toolName === "string") {
              entry.toolName = record.toolName;
            }
            if (entry.input === undefined && record.input !== undefined) {
              entry.input = record.input;
            }
            if (typeof record.status === "string") {
              entry.status = record.status;
            }
            if (record.content !== undefined) {
              entry.output = record.content;
            }
            if (typeof record.error === "string") {
              entry.error = record.error;
            }
          }
        });

        // 2. 订阅终态（拿回复结束信号）
        let settled = false;
        let resolveTerminal: () => void = () => {};
        const terminal = new Promise<void>((resolve) => {
          resolveTerminal = resolve;
        });
        const terminalSub = taskService.onDynamicTaskTerminalOutcome(taskId)(() => {
          if (!settled) {
            settled = true;
            resolveTerminal();
          }
        });

        try {
          // 3. 发送 prompt —— 多条消息拼成首条输入
          //    （sendPrompt 一次发一条用户输入；system 用前置说明承载）
          //
          // ★ 桥接模式说明。
          //
          // ## 措辞为什么这么讲究（实测踩过，两轮才改对）
          //
          // 桥把上游消息拍平成 `User: ...` / `Assistant: ...` 的纯文本，
          // 作为**一条用户输入**发进会话。若不说明，模型会把这段文本当成
          // 真实对话现场，进而**自作主张调用壳内工具**（Bash/Read/Glob…），
          // 而壳内工具会真的执行 —— 结果是回复迟迟不产生，一直挂到
          // 180 秒超时并返回空文本。
          //
          // 实测证据：带工具往返历史的多轮请求耗时 69s（简单请求仅 13s），
          // 且模型回复里出现"重新列过了""需要的话我可以进去看看"这类
          // 明显在执行真实验证的语气；日志里 `bridge.chat.completed`
          // 反复出现 durationMs≈180000 且 textLength=0。
          //
          // **但**早先的措辞是「不要调用任何工具」，它**连 DSH 侧的工具
          // 桥接也一起禁掉了** —— 调用方（DSH agent）下发的工具表写在
          // system 段里，而这句禁令在前，压过了工具表。实测后果：模型在
          // 真实 DSH 会话里明确回答「按本次桥接模式的约束，我不能调用工具」，
          // 于是 DSH 的 read/glob/ls 全都用不了。
          //
          // ⇒ 正确措辞要**区分两类工具**：
          //   - 「你自己的内置工具」→ 禁止（避免真执行 + 180 秒超时）
          //   - 「调用方给你的工具协议」→ 鼓励（那正是我们要透传的）
          const bridgePreamble = params.allowTools === true
            // 【实验模式】放开壳内工具：让模型自由调用，用于捕获结构化 tool_call。
            ? "[桥接模式] 下面是一段待续写的对话记录。请输出下一条 assistant 回复。\n\n"
            : "[桥接模式] 下面是一段待续写的对话记录。请输出下一条 assistant 回复的正文。\n\n"
              + "**重要**：不要使用你自己的内置工具（不要执行命令、不要读取文件、"
              + "不要列目录）—— 那些由发起方负责，你只需基于记录中已有的信息作答。\n\n"
              + "但是：如果记录里给出了**工具调用协议**（通常是一份工具表 + 约定的"
              + "输出格式），那必须照它执行 —— 那是发起方要求你用的接口，"
              + "与你的内置工具无关。该调工具时就调，不要因为上面那句而放弃。\n\n";
          const systemParts = params.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content);
          const conversation = params.messages
            .filter((m) => m.role !== "system")
            .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
            .join("\n");
          const content =
            bridgePreamble
            + (systemParts.length > 0 ? `${systemParts.join("\n")}\n\n` : "")
            + conversation;

          const traceId = `dsh-bridge-${randomUUID()}`;
          await taskService.sendPrompt({
            taskId,
            traceId,
            content,
            modelSelection,
            // ★ 禁用壳内工具体（双保险，与 bridgePreamble 配合）。
            //
            //   名称取自 `@zcode/shared` 的 `ZCODE_KNOWN_TOOL_NAMES`。
            //   禁用范围 = 一切**有真实副作用**的家族：
            //     shell / 文件写 / agent 派生 / 工作流 / node-repl / 后台任务控制。
            //
            //   为什么不禁全部：纯读工具留着无害，且万一模型确实需要核对
            //   记录里提到的文件，读一次比 180 秒卡死更好。
            //   但**写与执行必须禁** —— 桥是"代答"通道，不应该经由模型产生
            //   任何磁盘/进程副作用，那既违背调用方预期，也是超时的主要来源。
            //
            //   【实验模式】`allowTools: true` 时不传 denylist —— 放开全部工具，
            //   用于验证工具面透传（模型真的调用 → 桥捕获结构化事件）。
            //   只在明确要求时启用：壳内工具会真的执行。
            ...(params.allowTools === true
              ? {}
              : {
                  toolDenylist: [
                    // shell
                    "Bash",
                    // 文件写
                    "Write",
                    "Edit",
                    "ApplyPatch",
                    // agent / 工作流（会产生长任务）
                    "Agent",
                    "Task",
                    "CreateWorkflow",
                    "AmendWorkflow",
                    "submit_result",
                    // node repl
                    "js",
                    "js_reset",
                    "js_add_node_module_dir",
                    "mcp__node_repl__js",
                    "mcp__node_repl__js_reset",
                    "mcp__node_repl__js_add_node_module_dir",
                    // 会阻塞等人的交互工具
                    "AskUserQuestion",
                  ],
                }),
          });

          // 4. 等终态（或超时）
          //
          // 【流式增量】等终态的同时轮询快照，把新增文本通过回调吐给调用方，
          // 让上游（桥 → DSH）能边生成边转发，而不是干等 20-120 秒。
          //
          // ## 为什么轮询而不是订阅事件
          //
          // `onDynamicStreamEvent` 在这条路径上**收不到任何事件** —— 实测
          // 落盘诊断完全无输出。根因（查证）：那棵树的生产者是
          // `mapServiceEvent`，而它只由 `onDynamicTaskEvent` 建立会话订阅
          // 后才被调用；桥从来没有调用过 `onDynamicTaskEvent`。
          // ⇒ emitter 是同一个实例，但**没有任何代码路径往里 fire**。
          // 【2026-09-27 更新】runConversation 已改为在 createTask 后立即调用
          // onDynamicTaskEvent 建立会话订阅（见 2-0）—— 该根因已消除；轮询
          // 保留为兜底，与订阅并行不冲突。
          //
          // `getTaskSnapshot` 则实测可用：中位 129ms（其中 99% 是
          // `resumeSession` 的 RPC，SQLite 索引只占 1ms）。
          //
          // ## 代价控制（2026-09-27 重新实测后修正）
          //
          // 旧注释写「1200ms 下 20 秒的请求约 16 次快照，累计开销约 2 秒（10%），
          // 可接受」—— **这个前提是错的，实测证明那些快照全是无用功**：
          //
          //   ① 给 bridge.chat.completed 加 ttftMs 打点后，实测**恒为 undefined**
          //      —— onPartialText 一次都没回调过。
          //   ② 直接观测 `db.sqlite` 与 `db.sqlite-wal` 的大小：24 秒的请求期间
          //      **两者一个字节都没变**（21348352 / 2587392 恒定）。
          //
          // ⇒ 壳在整轮期间**不落库中间态**，只在对局结束时一次性写入。
          //   所以 `getTaskSnapshot` 在整轮期间必然返回空文本，
          //   16 次快照 = 16 次无用 RPC（每次约 130ms）+ 约 2 秒纯浪费。
          //
          // ## 修正做法：延迟启动轮询
          //
          // 实测首字从不早于 **8.4 秒**（三次采样：8.4 / 19.4 / 25.7 秒完成，
          // 且首个 SSE 块与最后一个同时到达）。所以前 8 秒的轮询是**确定无用**的。
          //
          // 保留轮询而非直接删掉，是因为：一旦上游将来改成分段落库
          // （或 `mapServiceEvent` 那条事件路径被接通），轮询能立刻受益。
          // 延迟启动只是不给「确定没有增量」的时间段白付代价。
          //
          // ⚠ 这个延迟是**性能优化**，不是正确性依赖：
          //   终态那次 `getTaskSnapshot` 仍会拿到完整结果（轮询之外的那条路径）。
          const PARTIAL_POLL_START_DELAY_MS = 8000;
          let pollForPartialText: ReturnType<typeof setInterval> | undefined;
          const pollStartTimer =
            params.onPartialText === undefined
              ? undefined
              : setTimeout(() => {
                  pollForPartialText = setInterval(() => {
                    void (async () => {
                      try {
                        const partial = await taskService.getTaskSnapshot({
                          taskId,
                          workspacePath,
                          messageLimit: 50,
                        });
                        const partialText = extractAssistantText(partial);
                        if (partialText.length > 0) {
                          params.onPartialText?.(partialText);
                        }
                      } catch {
                        // 快照轮询失败不影响主流程 —— 终态那次仍会拿到完整结果。
                      }
                    })();
                  }, 1200);
                  pollForPartialText.unref?.();
                }, PARTIAL_POLL_START_DELAY_MS);
          pollStartTimer?.unref?.();

          try {
            await Promise.race([
              terminal,
              new Promise<void>((resolve) => setTimeout(resolve, turnTimeoutMs)),
            ]);
          } finally {
            if (pollStartTimer !== undefined) {
              clearTimeout(pollStartTimer);
            }
            if (pollForPartialText !== undefined) {
              clearInterval(pollForPartialText);
            }
          }

          // 5. 读回复（快照里含持久化的消息列表）
          const snapshot = await taskService.getTaskSnapshot({
            taskId,
            workspacePath,
            messageLimit: 50,
          });
          const text = extractAssistantText(snapshot);
          // 【工具面透传】快照里持久化了结构化工具调用，事后再拉也拿得到
          // （不依赖事件订阅的时机与实例一致性 —— 见 extractToolCalls 的说明）。
          const snapshotToolCalls = extractToolCalls(snapshot);
          // 【诊断】把快照的 assistant 消息结构落盘 —— 用于确认真实字段名，
          // 而不是靠类型声明的猜测（第一版按 `tools` 猜，实测没拿到）。
          if (params.allowTools === true) {
            try {
              const s = snapshot as {
                messages?: Array<Record<string, unknown>>;
              };
              const shape = (s?.messages ?? [])
                .filter((m) => (m as { role?: unknown }).role === "assistant")
                .map((m) => ({
                  keys: Object.keys(m),
                  content: typeof m.content,
                  tools: Array.isArray(m.tools) ? (m.tools as unknown[]).length : typeof m.tools,
                  parts: Array.isArray(m.parts) ? (m.parts as unknown[]).length : typeof m.parts,
                  toolsSample:
                    Array.isArray(m.tools) && (m.tools as unknown[]).length > 0
                      ? JSON.stringify((m.tools as unknown[])[0]).slice(0, 600)
                      : null,
                }));
              appendFileSync(
                join(resolveZCodeDataBaseDir(), "bridge-snapshot-shape.ndjson"),
                `${JSON.stringify({ at: Date.now(), taskId, shape })}\n`,
              );
            } catch {
              // 诊断失败不影响主流程。
            }
          }
          return {
            text,
            finishReason: settled ? "stop" : "timeout",
            // 优先快照（可靠）；事件流捕获到的作为补充（若将来订阅生效）。
            toolCalls: snapshotToolCalls.length > 0 ? snapshotToolCalls : capturedToolCalls,
          };
        } finally {
          terminalSub.dispose();
          streamSub.dispose();
          dynamicTaskSub.dispose();
          // 清理临时 task（避免堆积）
          await taskService
            .deleteTask({ taskId, workspacePath })
            .catch(() => undefined);
        }
      },
    });
    logger.info("ZCode bridge started", {
      port: activeZCodeBridge.port,
      portFilePath: activeZCodeBridge.portFilePath,
      transport: "session-path",
    });
  } catch (error) {
    logger.warn("ZCode bridge failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 从 task snapshot 里抽出最后一条 assistant 文本。 */
function extractAssistantText(snapshot: unknown): string {
  try {
    const s = snapshot as { messages?: Array<{ role?: string; content?: unknown }> };
    const msgs = s?.messages;
    if (!Array.isArray(msgs)) return "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((p: unknown) =>
            typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string"
              ? (p as { text: string }).text
              : "",
          )
          .join("");
      }
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * 【工具面透传】从 task snapshot 里抽出**结构化**工具调用。
 *
 * ## 为什么走快照而不是事件流（实测踩过）
 *
 * 首选方案是订阅 `onDynamicStreamEvent(taskId)` 拿实时的 `tool_call` /
 * `tool_call_update` 事件。**实测该订阅在本路径上收不到任何事件**：
 * 在两处都加了落盘诊断，模型确实执行了工具（拿到真实的目录条目），
 * 但事件回调一次都没触发 —— 诊断文件根本没生成。
 *
 * 推测原因是 emitter 实例不共享（host 侧 `IZCodeTaskService` 与真正
 * fire 事件的 adapter 不是同一个内存实例），但**没有实测确认**。
 *
 * 所以改用**快照**：`ZCodeTaskSnapshot.messages[].tools[]` 里本来就持久化了
 * 每个工具调用的 `toolName` / `input` / `status` / `output` / `error`，
 * 数据一直都在，只是早先的 `extractAssistantText` 只读 `content` 把它丢了。
 *
 * 快照方案的额外好处：**不依赖订阅时机**（事件可能在订阅建立前就 fire 完，
 * 而快照是事后拉取，必然拿得到），也不需要跨实例共享 emitter。
 *
 * ## `parts` 的顺序
 *
 * `messages[].parts` 用 `{type:"tool-call", toolIndex}` 保留工具调用与文本的
 * **交错顺序**。这里按 `parts` 的顺序输出（缺失时退回 `tools` 数组顺序），
 * 这样调用方看到的次序与模型实际的产出次序一致。
 */
function extractToolCalls(snapshot: unknown): Array<{
  toolId: string;
  toolName?: string;
  input: unknown;
  status?: string;
  output?: unknown;
  error?: string;
}> {
  const out: Array<{
    toolId: string;
    toolName?: string;
    input: unknown;
    status?: string;
    output?: unknown;
    error?: string;
  }> = [];
  try {
    const s = snapshot as {
      messages?: Array<{
        role?: string;
        tools?: Array<{
          toolName?: unknown;
          input?: unknown;
          output?: unknown;
          error?: unknown;
          status?: unknown;
        }>;
        parts?: Array<{ type?: unknown; toolIndex?: unknown }>;
      }>;
    };
    const msgs = s?.messages;
    if (!Array.isArray(msgs)) return out;

    for (const message of msgs) {
      if (message?.role !== "assistant") continue;
      const tools = Array.isArray(message.tools) ? message.tools : [];
      if (tools.length === 0) continue;

      // 按 parts 的交错顺序展开；没有 parts 就按数组顺序。
      const order: number[] = [];
      if (Array.isArray(message.parts)) {
        for (const part of message.parts) {
          if (part?.type !== "tool-call") continue;
          const index = typeof part.toolIndex === "number" ? part.toolIndex : -1;
          if (index >= 0 && index < tools.length && !order.includes(index)) {
            order.push(index);
          }
        }
      }
      for (let i = 0; i < tools.length; i++) {
        if (!order.includes(i)) order.push(i);
      }

      for (const index of order) {
        const tool = tools[index];
        if (tool === undefined) continue;
        const toolName = typeof tool.toolName === "string" ? tool.toolName : undefined;
        out.push({
          // 快照里没有上游的 `toolId`，用「消息序号 + 工具序号」合成一个稳定 id。
          // 调用方只需要一个稳定的关联键，不需要它是上游原值。
          toolId: `snapshot-${out.length}`,
          ...(toolName === undefined ? {} : { toolName }),
          input: tool.input,
          ...(typeof tool.status === "string" ? { status: tool.status } : {}),
          ...(tool.output === undefined ? {} : { output: tool.output }),
          ...(typeof tool.error === "string" ? { error: tool.error } : {}),
        });
      }
    }
    return out;
  } catch {
    return out;
  }
}

function resolveZCodeDataBaseDir(): string {
  const fromEnv = process.env["ZCODE_DATA_BASE_DIR"]?.trim();
  if (fromEnv) return fromEnv;
  return homedir();
}

function disposeLocalResourceTelemetry(): void {
  try {
    activeLocalResourceTelemetry?.dispose();
  } catch {
    // 资源遥测释放失败不能阻塞 Host 的既有 shutdown barrier。
  } finally {
    activeLocalResourceTelemetry = null;
  }
}

type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(): void;
};

function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    windowHostControllerRuntime.service.mutateTask({
      address: await windowHostControllerRuntime.resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, { kind: "pin", pinned: params.pinned });
          if (!meta) throw new Error("pin mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("archive mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return windowHostControllerRuntime.service.deleteArchivedTasks({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          windowHostControllerRuntime.service.deleteArchivedTask({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("unread mutation 后 task 投影缺失");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
): ExposedServicePortHandle {
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // remote 模式延迟发送 Initialize：远程建连需要时间，如果构造时就发 Initialize，
  // renderer 会立即发请求但 channel 还没注册，导致 "Unknown channel" 超时错误。
  // attach 模式复用已就绪服务，必须立即初始化新的 RPC MessagePort。
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `host-rpc-${randomUUID()}`,
        clientMode,
      })
    : undefined;
  services.register(IWindowControllerService, windowHostControllerRuntime.service);
  const controllerAttachment = windowHostControllerRuntime.createAttachmentService();
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // 远端媒体必须按 attachment 的 clientMode 选择数据面：桌面使用 Host loopback Range，手机保持 inline。
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // Share service 若继续持有 raw Agent，会绕过当前 MessagePort 已握手的 trusted carrier，
    // rowsRange 会以 connection untrusted 拒绝。必须复用同一 attachment connection scope。
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
      ),
    );
  }
  services.exposeOnChannelServer(server, overrides);
  let disposed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardFlowState = (state: "saturated" | "drained" | "closed") => {
    if (!connectionScope) return Promise.resolve();
    const update = flowUpdateChain.then(() => connectionScope.setTransportFlowState(state));
    flowUpdateChain = update.catch((error) => {
      logger.warn("failed to forward attachment connection flow state", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return update;
  };
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband 已在 protocol 层与 Uint8Array 分流；这里只把 owning scope
    // 的 edge 串行送往 CLI，不能由 control object 指定 connectionId。
    void forwardFlowState(state).catch(() => {});
  });
  const handle: ExposedServicePortHandle = {
    server,
    dispose() {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close 排在所有已接收 SAT/DRN 之后；scope.dispose 自身会再次幂等确保 closed，
      // 但绝不让迟到 saturated 在 close 后复活 CLI pause state。
      void forwardFlowState("closed")
        .catch(() => {})
        .then(() => connectionScope?.dispose());
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

const windowHostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!activeServices) {
        throw new Error("local services 尚未初始化");
      }
      return { services: activeServices, generation: 1 };
    }
    const session = windowRemoteConnectionRegistry.getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: windowRemoteConnectionRegistry.resolveScopedServices(scope),
      generation: session.generation,
      capabilities: windowRemoteConnectionRegistry.resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities }) =>
    exposeServicesOnMessagePort(port, services, false, clientMode, scope, capabilities),
});

function logWindowHostTopology(reason: string): void {
  const stats = windowRemoteConnectionRegistry.getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${windowHostAttachmentRegistry.size()}`,
  );
}

function disposeAttachedServicePorts(): void {
  windowHostAttachmentRegistry.dispose();
}

async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  databaseStartup?.dispose();
  pendingStartupAttachments.clear();
  if (hasDisposedHostResources) {
    return (
      (await disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hasDisposedHostResources = true;

  disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    stopHostNetworkTelemetry();
    hostSelfResourceTelemetry.stop();
    disposeLocalResourceTelemetry();
    disposeAttachedServicePorts();
    windowHostControllerRuntime.dispose();
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
    cronAutomationRepo.close();
    for (const key of Array.from(offPeakRunSubscriptions.keys())) {
      disposeOffPeakRunSubscription(key);
    }
    disposeOffPeakRuntime();
    offPeakTaskRepo.close();

    if (activeSessionRealtimePort) {
      activeSessionRealtimePort.dispose();
      activeSessionRealtimePort = null;
    }

    const servicesToDispose = activeServices;
    activeServices = null;
    // Registry 是全部远端 connection 的唯一 owner；释放失败不能阻塞本地服务继续收口。
    const shutdownResult = await runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => windowRemoteConnectionRegistry.dispose(),
          timeoutMs: 6_000,
        },
        ...(servicesToDispose
          ? [
              {
                name: "service-dispose",
                run: () => disposeServiceResourcesAndWait(servicesToDispose),
                timeoutMs: 3_500,
              },
            ]
          : []),
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

function disposeHostResourcesBestEffort(reason: string): void {
  if (hasDisposedHostResources) {
    return;
  }
  hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  stopHostNetworkTelemetry();
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  windowHostControllerRuntime.dispose();
  for (const key of Array.from(cronRunSubscriptions.keys())) {
    disposeCronRunSubscription(key);
  }
  cronAutomationRepo.close();
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
  disposeOffPeakRuntime();
  offPeakTaskRepo.close();
  void windowRemoteConnectionRegistry.dispose();

  if (activeServices) {
    try {
      disposeServiceResources(activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      activeServices = null;
      activeHostApiNetworkTransport = null;
    }
  }

  if (activeSessionRealtimePort) {
    activeSessionRealtimePort.dispose();
    activeSessionRealtimePort = null;
  }
}

process.once("SIGTERM", () => {
  void disposeHostResources("SIGTERM").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("SIGINT", () => {
  void disposeHostResources("SIGINT").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("disconnect", () => {
  // parent IPC 消失后不会再有人发送 Dispose；有界清理结束后必须明确退出，避免 Host 常驻。
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});

process.once("exit", () => {
  disposeHostResourcesBestEffort("exit");
});

let handlingFatalUncaughtException = false;
process.on(
  "uncaughtException",
  createHostUncaughtExceptionHandler({
    onRecovered: (error, origin) => {
      const memoryUsage = process.memoryUsage();
      logger.warn("contained host allocation failure from native TLS callback", {
        arrayBuffers: memoryUsage.arrayBuffers,
        external: memoryUsage.external,
        heapUsed: memoryUsage.heapUsed,
        message: error.message,
        origin,
        rss: memoryUsage.rss,
      });
    },
    onFatal: (error, origin) => {
      if (handlingFatalUncaughtException) {
        process.exit(1);
      }
      handlingFatalUncaughtException = true;
      logger.error(`uncaughtException origin=${origin}:`, error);
      void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
    },
  }),
);

parentPort.on("message", async (e: Electron.MessageEvent) => {
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  const port = e.ports[0];
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // 取不到服务时过去静默丢弃，focus-changed 于是从链路上凭空消失
      // （dev 实测 0 条，正式包同期 92 条）。补这条才能把「main 没发」与
      // 「host 收到了但服务没注册」分开。
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingFeedbackLogArchiveRequests.delete(msg.requestId);
    if (msg.ok && msg.path && typeof msg.size === "number") {
      pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
      pending.resolve({ path: msg.path, size: msg.size });
      return;
    }
    pending.reject(new Error(msg.error ?? "反馈日志归档创建失败"));
    return;
  }

  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
    if (!pending) return;
    pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
    if (msg.ok && msg.path) {
      logger.info("local media preview path authorization OK");
      pending.resolve(msg.path);
    } else {
      pending.reject(new Error(msg.error ?? "本地视频预览路径授权失败"));
    }
    return;
  }

  if (msg.type === HostMessageTypes.CronRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchCronRun({
          ...msg,
          mode: msg.mode as ZCodeTaskMode | undefined,
        });
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          failureKind: "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.OffPeakRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchOffPeakRun(msg);
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // 确定性模型/凭证配置错误重试不会自愈；交给 scheduler 转 failed，
          // 未知及生命周期错误仍按 transient 保持原退避语义。
          failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // main 的 WebContentsView+CDP 执行完 browser 命令，按 requestId 关联回 bridge 的 pending。
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  if (msg.type === HostMessageTypes.Dispose) {
    // main 进程通知清理（窗口关闭 / app 退出时）
    // 这里必须等待统一资源清理完成（含异步收尾写回），再让进程退出；main 侧仍有强杀 timer 兜底。
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: "ZCode task service is not initialized.",
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
      return;
    }

    void zcodeTaskService
      .deliverSessionMessage(msg.request)
      .then((deliveryResult) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: deliveryResult,
        });
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: {
            error: error instanceof Error ? error.message : String(error),
            messageId: msg.request.messageId,
            requestId: msg.request.requestId,
            sessionId: msg.request.fromSessionId,
            status: "failed",
          },
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      logger.warn("session message delivery result received before ZCode task service initialized");
      return;
    }
    void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
      logger.warn("failed to forward session message delivery result:", error);
    });
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    const session = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (
      !session ||
      !session.workspaceIdentity ||
      buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
    ) {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: "Remote Environment registration 已失效",
      });
      return;
    }
    const scope = {
      kind: "remote",
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath ?? "/",
      workspaceIdentity: session.workspaceIdentity,
    } as const;
    void Promise.resolve()
      .then(() =>
        (() => {
          const provisioningService = getRemoteProviderProvisioningExecutor(
            windowRemoteConnectionRegistry.resolveScopedServices(scope),
          );
          if (!provisioningService) {
            throw new Error("Remote Environment 不支持 Provider Provisioning");
          }
          return provisioningService.syncLocalToRemote();
        })(),
      )
      .then((result) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: result.status,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
        });
      })
      .catch((error: unknown) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    const workspacePath = msg.workspacePath ?? "/";
    const workspaceIdentity =
      msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
    logger.info(
      `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
    );
    void remoteConnectionProgressContext
      .run(msg.requestId, () =>
        windowRemoteConnectionRegistry.connect({
          requestId: msg.requestId,
          target: msg.target,
          remoteAssets: msg.remoteAssets,
          workspacePath,
          workspaceIdentity,
        }),
      )
      .then(async (descriptor) => {
        const replacedOfflineSessions = windowRemoteConnectionRegistry
          .listSessions()
          .filter(
            (session) =>
              session.remoteSessionId !== descriptor.remoteSessionId &&
              session.state === "disconnected" &&
              session.workspacePath === descriptor.workspacePath &&
              session.workspaceIdentity === descriptor.workspaceIdentity,
          );
        for (const replaced of replacedOfflineSessions) {
          if (replaced.workspacePath && replaced.workspaceIdentity) {
            const previousScope = {
              kind: "remote",
              remoteSessionId: replaced.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            const nextScope = {
              kind: "remote",
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            try {
              const services = windowRemoteConnectionRegistry.resolveScopedServices(nextScope);
              await windowHostControllerRuntime.replaceDisconnectedSource(previousScope, {
                scope: nextScope,
                taskService: services.get(IZCodeTaskService),
                sourceAvailability: "online",
              });
            } catch (error) {
              // source 已连接但 task-index 暂时不可读时不能回滚 transport，也不能删除上一代
              // 离线可信投影。Controller 会保留 pending replacement，后续 query 成功后原子替换。
              logger.warn("failed to atomically replace disconnected Controller source", error);
            }
          }
          windowHostAttachmentRegistry.detachRemoteSessionAttachments(replaced.remoteSessionId);
          await windowRemoteConnectionRegistry.disposeSession(replaced.remoteSessionId);
          // 重连替换后旧 remoteSessionId 已不再可 attachment；同步清理 Main 的端口请求关联，
          // 但不向 Renderer 伪报一次新的 transport failure。
          parentPort.postMessage({
            type: HostResponseTypes.RemoteWorkspaceClosed,
            remoteSessionId: replaced.remoteSessionId,
            reason: "disposed",
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnected,
          requestId: msg.requestId,
          descriptor,
        });
        logWindowHostTopology("remote-connected");
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnectFailed,
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    windowRemoteConnectionRegistry.cancelConnect(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    const previous = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    let workspaceReady: Promise<void>;
    try {
      workspaceReady = windowRemoteConnectionRegistry.bindWorkspaceContext({
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
      });
    } catch (error) {
      logger.warn(
        `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      return;
    }
    const current = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (current) {
      // scope generation 换代后，旧 Renderer/手机 attachment 不得继续持有远端 IO facade。
      windowHostAttachmentRegistry.detachStaleRemoteSessionAttachments(
        msg.remoteSessionId,
        current.generation,
      );
    }
    void workspaceReady.catch((error) => {
      logger.warn(
        `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
    });
    if (previous?.workspacePath && previous.workspaceIdentity) {
      windowHostControllerRuntime.removeSource({
        kind: "remote",
        remoteSessionId: msg.remoteSessionId,
        workspacePath: previous.workspacePath,
        workspaceIdentity: previous.workspaceIdentity,
      });
    }
    logger.info(
      `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
    );
    return;
  }

  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    const disposedSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(msg.remoteSessionId);
    void windowRemoteConnectionRegistry
      .disposeSession(msg.remoteSessionId)
      .then(() => {
        if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            remoteSessionId: msg.remoteSessionId,
            workspacePath: disposedSession.workspacePath,
            workspaceIdentity: disposedSession.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: msg.remoteSessionId,
          reason: "disposed",
        });
        logWindowHostTopology("remote-session-disposed");
      })
      .catch((error) => {
        logger.warn(
          `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
      });
    return;
  }

  if (
    msg.type === HostMessageTypes.BotRemoteWorkspaceReconnectResult ||
    msg.type === HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult ||
    msg.type === HostMessageTypes.BotRemoteWorkspaceRuntimePort
  ) {
    // Bugfix: Bot bridge 也监听 parentPort，main 回传的 runtime MessagePort 是给 Bot 作为
    // 远端 RPC client 使用的。host 入口必须跳过这些控制消息，避免误把同一个端口注册成 ChannelServer。
    return;
  }

  if (msg.type === HostMessageTypes.AttachServicePort) {
    if (!port) {
      logger.error("attach-service-port message missing MessagePort");
      return;
    }
    if (msg.scope.kind === "local" && databaseStartup?.coordinator.snapshot.phase !== "ready") {
      // 刷新/手机 attachment 复用同一 Host，等待现有准备，不启动第二个执行者。
      pendingStartupAttachments.set(msg.attachmentId, () => {
        windowHostAttachmentRegistry.attach({ ...msg, port });
      });
      port.once("close", () => pendingStartupAttachments.delete(msg.attachmentId));
      return;
    }
    try {
      if (msg.scope.kind === "remote") {
        // Bind 与 Attach 共用 parentPort，但 WSL 上一代 workspace release 可能仍在途。
        // 持有已转移 port 等待 Host 内 generation barrier，避免新 attachment 踩过旧 runtime 清理。
        await windowRemoteConnectionRegistry.waitForScopedServices(msg.scope);
      }
      windowHostAttachmentRegistry.attach({
        requestId: msg.requestId,
        attachmentId: msg.attachmentId,
        clientMode: msg.clientMode,
        scope: msg.scope,
        port,
      });
      logger.info(
        `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
      );
      logWindowHostTopology("attachment-added");
    } catch (error) {
      // 跨 logical session 或旧 identity 的 port 若继续暴露，会把远端请求路由到错误 source。
      // scope 校验失败必须关闭已转移端口并明确记录，禁止回退 active local services。
      rejectUnavailableAttachedServicePort(port, false);
      logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
    }
    return;
  }

  if (msg.type === HostMessageTypes.DetachServicePort) {
    pendingStartupAttachments.delete(msg.attachmentId);
    windowHostAttachmentRegistry.detach(msg.attachmentId);
    logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
    logWindowHostTopology("attachment-removed");
    return;
  }

  if (!port) {
    return;
  }

  if (msg.type === HostMessageTypes.InitLocal) {
    if (!port) {
      logger.error("init-local message missing MessagePort");
      return;
    }
    if (databaseStartup) {
      port.close();
      databaseStartup.coordinator.publish();
      return;
    }
    let basePortClosed = false;
    port.once("close", () => {
      basePortClosed = true;
    });
    databaseStartup = createHostDatabaseStartup({
      startupId: msg.databaseStartupId,
      cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
      workingDirectories:
        msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
        (msg.workspacePath ? [msg.workspacePath] : []),
      env: msg.runtimeProcessEnvPatch,
      publish: (state) => {
        parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
        if (state.phase === "ready") {
          for (const attach of pendingStartupAttachments.values()) {
            try {
              attach();
            } catch (error) {
              logger.warn("startup attachment failed", error);
            }
          }
          pendingStartupAttachments.clear();
        }
      },
      onFailure: (error) =>
        logger.error(
          `local database startup failed attempt=${databaseStartup?.coordinator.snapshot.attemptId}`,
          error,
        ),
      initializeServices: async () => {
        logger.info("initializing local services");
        activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort);
        // 旧 Team 补组织必须与网络代理读取共用同一个 Setting 实例及写队列。
        // 只注入 service 会跳过默认装配分支，导致缺组织的升级用户永远无法恢复连接。
        const { service: settingService, prepareLegacyAccountConnections } =
          createSettingServiceWithMigrations();
        const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
          const settings = await settingService.get();
          return {
            httpProxy: settings.httpProxy,
            noProxy: settings.httpProxyNoProxy,
            caCertPath: settings.httpProxyCaCertPath,
          };
        });
        const services = await initializeHostApiNetworkTransportOwner({
          transport: hostApiNetworkTransport,
          log: (message, details) => logger.warn(message, details),
          establishOwner: () => {
            const initializedServices = createLocalServices({
              parentPort,
              settingService,
              prepareLegacyAccountConnections,
              hostApiNetworkTransport,
              authorizeLocalMediaPreviewPath,
              runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
              agentRuntimeContext: {
                getDeviceMid: () => msg.deviceMid,
                runtimeSurface: "desktop_local_host",
              },
              serviceAuthorityMode: "desktop-local",
              zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
              zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
              processLifecycleReporter: runtimeProcessLifecycleReporter,
              taskRuntimeReporter: runtimeTaskReporter,
              feedback: {
                getDeviceMid: () => msg.deviceMid,
                apiBaseUrl: msg.feedbackApiBase,
                createFullLogArchive: createFullFeedbackLogArchiveViaMain,
              },
              forwardSessionMessageSendRequested: (request) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.SessionMessageSendRequested,
                  request,
                });
              },
              onAutomationManualRunRequested: dispatchManualAutomationRun,
              onOffPeakSchedulerWakeRequested: () => {
                parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
              },
              onProviderProvisioningSourceChanged: (trigger) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.ProviderProvisioningSourceChanged,
                  trigger,
                });
              },
              // browser-use：agent 的 interaction/browserExecute 经 zcodeAgentService 转到这个 executor，
              // 再经 parentPort 到 main 的 WebContentsView+CDP 执行。
              browserControlExecutor: browserControlMainBridge,
              // CUA 顶部提示属于物理 Windows 桌面投影；非 Windows 和远端 authority 都不得上报。
              cuaOperationStateReporter:
                process.platform === "win32" ? cuaOperationStateReporter : undefined,
            });
            activeServices = initializedServices;
            activeHostApiNetworkTransport = hostApiNetworkTransport;
            return initializedServices;
          },
        });
        const zcodeTaskService = services.getOptional(IZCodeTaskService);
        if (zcodeTaskService) {
          const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(
            zcodeTaskService,
            {
              reportRunningPromptCount: false,
            },
          );
          services.register(IZCodeTaskService, reportingZCodeTaskService);
        }
        wireLocalResourceTelemetry(services);
        await startZCodeBridgeIfEnabled(services);
        hasDisposedHostResources = false;
        disposeHostResourcesInFlight = null;
        const agentWarmupTargets =
          msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
            ? msg.agentWarmupTargets
            : msg.workspacePath
              ? [
                  {
                    workspacePath: msg.workspacePath,
                    ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                  },
                ]
              : [];
        // Main 已按最近使用顺序把启动预热限制为 3 个；Host 必须显式消费这份
        // 固定名单，不能让后续 task-list observer 再隐式扩大，也不能因单个失败扫描补位。
        agentWarmupTargets.forEach((target, index) => {
          warmUpZCodeAgent(
            services,
            target,
            `local host init (${index + 1}/${agentWarmupTargets.length})`,
          );
        });
        logger.info("exposing services on ChannelServer...");
        if (!basePortClosed)
          windowHostAttachmentRegistry.attach({
            requestId: `init-local-${randomUUID()}`,
            attachmentId: `base-${randomUUID()}`,
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
            port,
          });
        logWindowHostTopology("base-attachment-ready");
        logger.info("local services ready, all channels registered");
      },
    });
    await databaseStartup.coordinator.start();
  }
});

async function setupRemoteConnection(
  target: RemoteTarget,
  remoteAssets: RemoteAssetDirs,
  remoteAssetNetwork: RemoteAssetNetworkPort,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
  onDidRemoteClose: (exitCode: number) => void,
  deployLockMode: DeployLockMode = "remote",
  signal?: AbortSignal,
): Promise<HostRemoteConnection> {
  // 延迟加载 remote backend，避免 local 模式下因 ssh2 依赖链进入 asar 后崩溃
  const { createRemoteBackend, connectRemote, pickRemoteRuntimeEnv } =
    await import("@zcode/server/remote");
  const backend = await createRemoteBackend(target);
  const connection = await connectRemote(backend, {
    ...remoteAssets,
    remoteAssetNetwork,
    remoteRuntimeNetwork,
    signal,
    // SSH/Docker 远端 server 由 host process 单独启动，不能依赖桌面 main 的环境继承。
    // 这里显式透传编译期版本，避免漏导入后生成裸 ZCODE_VERSION 引用导致 SSH 初始化直接 ReferenceError。
    appVersion: ZCODE_VERSION,
    // 远端 zcode-server/agent 是独立进程，不能继承 host 里的测试/生产 endpoint 选择。
    // 这里只透传 server 侧白名单允许的公开环境变量，避免把 credential/token 带到远端机器。
    remoteRuntimeEnv: pickRemoteRuntimeEnv(process.env),
    assetInstallMode: target.kind === "ssh" ? target.assetInstallMode : undefined,
    // SSH 由窗口级 registry 串行复用，其余 transport 仍保留远端 connector 自身锁。
    deployLockMode,
    onDidRemoteClose: ({ code }) => {
      onDidRemoteClose(code);
    },
  });
  return { ...connection, backend };
}
