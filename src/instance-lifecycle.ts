/**
 * ZCode 实例的生命周期绑定。
 *
 * ## 解决的问题
 *
 * 桥跑在 ZCode 实例（electron）里。`start-headless.ps1` 用 `Start-Process`
 * 启动它，父进程（pwsh）随即退出 —— **实例变成孤儿进程，永远活着**。
 *
 * 后果：DSH 关了，实例还在，白占 ~400 MB 内存，而且没有托盘图标可以关它
 * （`ZCODE_HEADLESS=1` 把托盘也禁了）。用户只能开任务管理器。
 *
 * ## 做法
 *
 * 插件在 DSH 进程里挂 `process.on("exit" / SIGINT / SIGTERM)`，退出时
 * 把实例一起带走。
 *
 * ### 为什么必须钩 `process`，不能只靠 `ctx.effect()`
 *
 * `ctx.effect()` 的清理只在**插件被热卸载**时跑，进程被 kill 时不会。
 * 而我们要覆盖的恰恰是后者。cordis 也没有进程级退出事件
 * （`Events` 接口里只有 `internal/*`）。
 *
 * ### 为什么钩 `exit` 而不是 `beforeExit`
 *
 * `beforeExit` 在事件循环空转时触发，**可以被后续任务撤销** —— 不适合做
 * 收尾。`exit` 是最后时机，只允许同步操作，所以这里用 `taskkill` 的
 * 同步形式（`execFileSync`）。
 *
 * ### 只杀自己启动的实例
 *
 * 如果用户是**手动**用 `start-headless.ps1` 起的（或本来就开着官方 ZCode），
 * 我们不能替他决定关掉。判据见 {@link shouldOwnInstance}：
 * 只有当实例是**本插件启动的**（记了 pid）才会被带走。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BASE_URL_ENV,
  DATA_BASE_DIR_ENV,
  TOKEN_ENV,
} from "./product.js";
import { resolveDataBaseDir, resolveBridgePortFilePath, resolveBridgeEndpoint, probeBridge } from "./bridge-endpoint.js";

/** 启动 ZCode 实例所需的配置。 */
export interface ZCodeInstanceSpawnConfig {
  /** electron 可执行文件。 */
  readonly electronPath: string;
  /** app 目录（含 package.json，其 main 指向入口）。 */
  readonly appDir: string;
  /** 数据根目录。 */
  readonly dataBaseDir: string;
  /** 就绪等待上限（毫秒）。 */
  readonly readyTimeoutMs?: number;
}

/** 本插件持有的实例句柄。 */
interface OwnedInstance {
  readonly pid: number;
  readonly startedAt: number;
  readonly portFilePath: string;
}

/** 模块级持有 —— 保证 `process.on("exit")` 能读到。 */
let owned: OwnedInstance | undefined;
let exitHookInstalled = false;

/**
 * 判断是否应该由本插件接管实例的生命周期。
 *
 * 只有在**两端都满足**时才接管：
 *   1. 桥不是由环境变量显式指定的（`ZCODE_BRIDGE_BASE_URL` 为空）——
 *      显式指定说明用户自带实例，我们不该杀它；
 *   2. 实例是**本插件启动的**（`owned` 有记录）。
 *
 * 手动运行 `start-headless.ps1` 起的实例不会被这里碰到 —— 用户明确
 * 用了那个脚本，说明他要自己管。
 */
export function shouldOwnInstance(): boolean {
  if (process.env[BASE_URL_ENV]?.trim()) {
    return false;
  }
  return owned !== undefined;
}

/** 记录本插件启动的实例 pid。 */
export function rememberOwnedInstance(pid: number): void {
  owned = {
    pid,
    startedAt: Date.now(),
    portFilePath: resolveBridgePortFilePath(),
  };
}

/**
 * 杀掉本插件启动的实例。
 *
 * 用 `taskkill /T /F` —— `/T` 连带子进程（electron 有 8-10 个子进程，
 * 只杀主进程会留下一堆渲染进程孤儿），`/F` 强制（窗口已隐藏，
 * 没法走正常关闭流程）。
 *
 * 任何异常都吞掉：这是退出路径，不能因为清理失败而让 DSH 挂住。
 */
export function killOwnedInstance(): void {
  if (owned === undefined) {
    return;
  }
  const pid = owned.pid;
  owned = undefined;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 进程已经退出（最常见）、或权限不足 —— 都不该阻塞 DSH 退出。
  }
}

/**
 * 安装进程退出钩子。
 *
 * 幂等：重复调用只有第一次生效。
 *
 * `exit` 里只做同步 kill；`SIGINT` / `SIGTERM` 里先 kill 再以标准
 * 退出码退出（否则 Ctrl+C 会变成"没反应"）。
 */
export function installInstanceLifecycleHooks(
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;

  process.on("exit", () => {
    if (shouldOwnInstance()) {
      killOwnedInstance();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shouldOwnInstance()) {
        logger.info(`[zcode-bridge] ${signal} 收到，关闭 ZCode 实例`);
        killOwnedInstance();
      }
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * 读发现文件里的实例 id。
 *
 * 用于判断"已经在跑的那个"是不是我们之前启动的 —— 重启 DSH 后
 * `owned` 是空的，但实例可能还在跑（上一次没清干净）。
 */
export function readExistingInstanceId(): string | undefined {
  const file = resolveBridgePortFilePath();
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { instanceId?: unknown };
    return typeof parsed.instanceId === "string" ? parsed.instanceId : undefined;
  } catch {
    return undefined;
  }
}

/** 读发现文件里的 pid（桥写进去的，用于保活判定）。 */
export function readExistingInstancePid(): number | undefined {
  const file = resolveBridgePortFilePath();
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { instancePid?: unknown };
    return typeof parsed.instancePid === "number" && parsed.instancePid > 0
      ? parsed.instancePid
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读发现文件里的端口。
 *
 * 用于「新实例是否已经接管」的判定：新实例的桥会绑一个新端口，
 * 端口值变了就说明换了实例 —— 这个判据不依赖删文件。
 */
export function readExistingPort(): number | undefined {
  const file = resolveBridgePortFilePath();
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { port?: unknown };
    return typeof parsed.port === "number" && parsed.port > 0 ? parsed.port : undefined;
  } catch {
    return undefined;
  }
}

/** 进程是否还活着（Windows 用 tasklist，POSIX 用 signal 0）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // 无匹配时 tasklist 输出 "INFO: No tasks are running..."（本地化会变），
      // 但只要有匹配就会带 CSV 头，且含 PID 字符串。
      return out.includes(`"${pid}"`) || out.includes(`,${pid},`);
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 保活状态机。
 *
 * ## 语义（双向绑定）
 *
 *   DSH 活 → 壳必须活：探活失败就重启
 *   DSH 死 → 壳跟着死：`process.on('exit'/'SIGINT'/'SIGTERM')` 里 kill
 *
 * ## 为什么需要保活
 *
 * 壳可能因为各种原因挂掉（OOM、崩溃、被误杀），而 DSH 侧的插件是无感的
 * —— `listModels()` 会返回 `[]`，用户看到 provider 分组凭空消失，
 * 下一次请求报 `MISSING_CREDENTIAL`。保活把它变成一个可自愈的状态。
 *
 * ## 为什么不用 `ctx.effect` 做清理
 *
 * 那只覆盖插件热卸载；进程被 kill 时不跑。收尾必须挂在 `process` 上。
 */
export interface KeepAliveHandle {
  stop(): void;
}

/** 保活配置。 */
export interface KeepAliveConfig {
  /** 检查间隔（毫秒）。 */
  readonly intervalMs: number;
  /** 连续失败多少次后尝试重启。 */
  readonly failuresBeforeRestart: number;
  /** 重启时的实例配置；省略则只报日志不重启。 */
  readonly spawn?: ZCodeInstanceSpawnConfig;
}

/**
 * 启动保活循环。
 *
 * 同时装上进程退出钩子（DSH 死 → 壳死）。
 */
export function startKeepAlive(
  config: KeepAliveConfig,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): KeepAliveHandle {
  installInstanceLifecycleHooks(logger);

  let failures = 0;
  let restarting = false;
  let stopped = false;
  let ticking = false;

  const timer = setInterval(() => {
    if (stopped || restarting || ticking) {
      return;
    }
    ticking = true;
    void (async () => {
      try {
        await tick();
      } catch {
        // 保活循环里的任何异常都不该让定时器停摆。
      } finally {
        ticking = false;
      }
    })();
  }, config.intervalMs);

  /**
   * 单次保活判定。
   *
   * ## 判活顺序（**先看桥，再看 pid**）
   *
   * 1. **发现文件存在且 `/health` 通** → 壳健康，直接返回。
   *    这一条是最可信的判据：端口活着就说明持有桥的进程活着，
   *    不依赖发现文件里的 `instancePid` 是否可读。
   * 2. 否则退回 pid 判活（发现文件里的 pid 或本插件自己记的 pid）。
   * 3. 都失败才累加失败计数。
   *
   * ## 为什么要加第 1 条（实测踩过的坑）
   *
   * 旧实现只看第 2 条。一旦发现文件被删（例如上一次异常的
   * `spawnZCodeInstance` 留下的状态），`readExistingInstancePid()` 返回
   * undefined → 判为"壳死了" → 重启 → 重启前又删文件 → 文件永远不回来，
   * 形成 **140 秒一轮的无限重启循环**，而桥其实一直活着。
   *
   * 判活必须建立在"端口通不通"这个**外部可观测事实**上，
   * 而不是"某个文件在不在"这种可被自己破坏的内部约定上。
   */
  async function tick(): Promise<void> {
    if (await bridgeAlive()) {
      if (failures > 0) {
        logger.info("[zcode-bridge] 壳已恢复（/health 通过）");
      }
      failures = 0;
      return;
    }

    const pid = owned?.pid ?? readExistingInstancePid();
    if (pid !== undefined && isProcessAlive(pid)) {
      if (failures > 0) {
        logger.info(`[zcode-bridge] 壳已恢复（pid=${pid}）`);
      }
      failures = 0;
      return;
    }

    failures += 1;
    if (failures < config.failuresBeforeRestart) {
      return;
    }

    logger.warn(
      `[zcode-bridge] 壳连续 ${failures} 次探活失败${pid === undefined ? "（无 pid 记录）" : `（pid=${pid}）`}`,
    );
    failures = 0;

    if (config.spawn === undefined) {
      logger.warn("[zcode-bridge] 未配置自动重启（缺 electronPath/appDir），跳过");
      return;
    }

    restarting = true;
    void spawnZCodeInstance(config.spawn, logger)
      .catch((error: unknown) => {
        logger.warn(`[zcode-bridge] 重启失败: ${String(error)}`);
      })
      .finally(() => {
        restarting = false;
      });
  }

  // 保活定时器不得延长 DSH 进程寿命。
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * 桥是否活着（发现文件存在 + `/health` 通）。
 *
 * 这是保活的**首选判据**：端口活着等价于持有桥的进程活着，
 * 比"发现文件里有 pid"更可信 —— 后者可以被本插件自己删掉，
 * 从而制造出"桥明明活着却被判定为死"的假阴性。
 */
async function bridgeAlive(): Promise<boolean> {
  const endpoint = resolveBridgeEndpoint();
  if (endpoint === undefined) {
    return false;
  }
  return probeBridge(endpoint);
}

/**
 * 杀掉残留的 ZCode 实例（只杀本插件认识的那个 electron 可执行文件）。
 *
 * ## 为什么必须由插件来杀
 *
 * ZCode 有**单实例锁**：已有实例在跑时，新 spawn 的 electron 会立刻退出。
 * 如果那个旧实例的桥已经不可用（发现文件丢了、token 对不上），我们既
 * 无法通过它服务请求，又无法靠 spawn 顶替它 —— 死锁。
 *
 * ## 只杀指定的可执行文件
 *
 * 用 `execFileSync` 的 `tasklist` 匹配 `electronPath` 的**完整路径**再杀，
 * 绝不按进程名 `electron.exe` 盲杀 —— 机器上可能同时跑着官方 ZCode、
 * 其它 Electron 应用。误杀是用户无法接受的副作用。
 */
function killResidualInstances(
  electronPath: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): void {
  if (process.platform !== "win32") {
    // 非 Windows 上单实例锁的表现不同，暂不做主动清理 —— 宁可少做不可做错。
    return;
  }
  try {
    // 用 PowerShell 拿「可执行文件完整路径」匹配。
    //
    // ⚠ 只匹配**主进程**（命令行里没有 `--type=`）—— 子进程（renderer/gpu/utility）
    //   会随主进程的 `/T` 一起被带走，单独列出来只会让日志变噪音。
    //
    // ⚠ 路径用单引号包裹并转义内部单引号，避免反斜杠被当成转义序列
    //   （实测踩过：路径里出现 `\\` 会导致匹配全部落空，清理静默失效）。
    const escaped = electronPath.replace(/'/g, "''");
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
      `Where-Object { $_.ExecutablePath -eq '${escaped}' -and $_.CommandLine -notmatch '--type=' } | ` +
      `Select-Object -ExpandProperty ProcessId`;
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const pids = out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (pids.length === 0) {
      return;
    }

    logger.warn(
      `[zcode-bridge] 清理残留实例（它们占着单实例锁，会让重启无效）: ${pids.join(", ")}`,
    );
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch {
        // 已经退出了 —— 正常情况。
      }
    }
    // 让出单实例锁的释放时间，否则紧接着的 spawn 会被尚未退干净的旧实例挡下。
    execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 3"], {
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch (error) {
    logger.warn(`[zcode-bridge] 清理残留实例失败（继续尝试启动）: ${String(error)}`);
  }
}

/**
 * 启动一个新的 ZCode 实例并等它就绪。
 *
 * 只在 `ZCODE_BRIDGE_AUTOSTART=1` 时被调用 —— 默认不自启，因为
 * 实例启动要 ~30 秒、占 ~400 MB，用户可能更愿意自己控制。
 */
export async function spawnZCodeInstance(
  config: ZCodeInstanceSpawnConfig,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<number | undefined> {
  const { spawn } = await import("node:child_process");

  const portFilePath = join(config.dataBaseDir, ".zcode", "v2", "bridge-port.json");

  // ── 启动前先确认确实没有活着的桥 ────────────────────────────────────
  //
  // ⚠ 这一步是**必须**的，不是优化。旧实现在这里无条件 `rmSync` 删发现文件，
  //   后果实测过一次灾难性的循环：
  //
  //     发现文件被删 → 保活读不到 pid → 判"壳死了" → 再 spawn → 又删文件
  //     → 新实例被 ZCode 单实例锁挡下、秒退、永不写回文件 → 无限循环
  //     （实测 140 秒一轮，持续整夜，桥其实一直好好活着）
  //
  //   ZCode 有单实例锁：已有实例在跑时，新 spawn 的 electron 会立刻退出，
  //   既不会写发现文件，也不会顶替旧实例 —— 于是"删文件 + spawn"变成
  //   纯粹的破坏动作，把唯一能让插件找到桥的凭据抹掉。
  //
  //   判据用 `/health`（端口通不通），不用文件在不在。
  const existing = resolveBridgeEndpoint();
  if (existing !== undefined && (await probeBridge(existing))) {
    logger.info(
      `[zcode-bridge] 已有桥在 ${existing.baseUrl} 上运行，复用而不重启（不删发现文件）`,
    );
    return undefined;
  }

  // ── 不删发现文件，改为「记住旧 instanceId」来判定新实例就绪 ──────────
  //
  // 旧实现无条件 `rmSync` 删文件，实测产生过灾难性循环：
  //
  //     文件被删 → 保活读不到 pid → 判"壳死了" → 再 spawn → 又删文件
  //     → ZCode 单实例锁挡下新进程、秒退、永不写回文件 → 无限循环
  //     （实测 140 秒一轮，桥其实一直好好活着）
  //
  // 删文件是**破坏性**动作，而它想解决的问题（"如何知道新实例真的起来了"）
  // 有一个无破坏的解法：发现文件里的 `instanceId` 每次启动都重新生成，
  // 比对 instanceId 变了就说明新实例的桥已经接管，旧端口不会被误判。
  //
  // ★ 基本原则：插件绝不能删除那个唯一能让它找到桥的凭据。
  const previousInstanceId = readExistingInstanceId();
  const previousPort = readExistingPort();

  // ── 清掉占着单实例锁的残留实例 ──────────────────────────────────────
  //
  // 走到这里 = 桥不可用（发现文件缺失或 /health 不通）。
  // 但**可能仍有一个 ZCode 实例活着**：它占着单实例锁，导致新 spawn 的
  // electron 立刻退出、永不写发现文件（实测：25 秒内即死）。
  //
  // 于是"文件丢了 → 重启"这条自愈路径被锁彻底堵死：不杀掉旧的，
  // 新的永远起不来；不重启，文件永远回不来。必须显式清掉残留。
  //
  // 判据用"端口不健康"，不是"进程不存在" —— 只要桥不能服务，
  // 这个实例对本插件就等于不存在，无论它进程状态如何。
  killResidualInstances(config.electronPath, logger);

  const child = spawn(config.electronPath, ["."], {
    cwd: config.appDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      [DATA_BASE_DIR_ENV]: config.dataBaseDir,
      ZCODE_ENV: "production",
      ZCODE_BRIDGE: "1",
      ZCODE_QUIET: "1",
      ZCODE_HEADLESS: "1",
    },
  });
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    logger.warn("[zcode-bridge] 实例启动失败：未拿到 pid");
    return undefined;
  }
  rememberOwnedInstance(pid);
  logger.info(`[zcode-bridge] 已启动 ZCode 实例 pid=${pid}，等待桥就绪…`);

  const timeoutMs = config.readyTimeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // ── 就绪判据 1：instanceId 变了 ─────────────────────────────────
    //   新实例的桥会写一份新的 instanceId。这是最精确的判据，
    //   不会把"上一次遗留的旧端口"误判成本次就绪。
    const currentInstanceId = readExistingInstanceId();
    if (
      currentInstanceId !== undefined &&
      currentInstanceId !== previousInstanceId &&
      (await bridgeAlive())
    ) {
      logger.info(`[zcode-bridge] 桥就绪（新 instanceId），baseUrl=${resolveBridgeEndpoint()?.baseUrl}`);
      return pid;
    }

    // ── 就绪判据 2：端口换了一个新的且 /health 通 ────────────────────
    const currentPort = readExistingPort();
    if (
      currentPort !== undefined &&
      currentPort !== previousPort &&
      (await bridgeAlive())
    ) {
      logger.info(`[zcode-bridge] 桥就绪（新 port=${currentPort}）`);
      return pid;
    }

    // ── 就绪判据 3：没有旧记录（首次启动）且 /health 通 ──────────────
    //   这一条覆盖"此前从来没有发现文件"的场景 —— 此时没有可比对的旧值。
    if (previousInstanceId === undefined && previousPort === undefined && (await bridgeAlive())) {
      logger.info(`[zcode-bridge] 桥就绪（首次启动），baseUrl=${resolveBridgeEndpoint()?.baseUrl}`);
      return pid;
    }
  }

  logger.warn(`[zcode-bridge] 实例在 ${timeoutMs}ms 内未就绪`);
  return pid;
}
