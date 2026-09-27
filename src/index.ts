/**
 * DSH 插件：ZCode 桥 provider。
 *
 * 把 ZCode 开源版实例内部的**免费额度通道**（`account:bigmodel-start-plan`
 * + 阿里云 captcha）接进 DSH，作为一个普通模型 provider 使用。
 *
 * ## 架构
 *
 *   DSH ──▶ 本插件 ──▶ 本机 HTTP 桥 ──▶ ZCode 实例的 session 链路 ──▶ zcode.z.ai
 *          (provider)      (loopback)        (createTask/sendPrompt)     (免费额度)
 *
 * ## 为什么必须经过 ZCode 实例（妥协条件）
 *
 * 免费额度通道强制要求阿里云 captcha，而 captcha 只能在真实 Electron
 * renderer 里运行（需要 DOM + CDN 脚本）。且 3012 风控的判据是**调用路径** ——
 * 只有实例内部的 session 链路（`createTask` + `sendPrompt`）能通过，
 * 裸 HTTP 调用一律 405/3012。
 *
 * **⇒ 使用本插件的前提：本机已安装并运行 ZCode 开源版实例（`ZCODE_BRIDGE=1`）。**
 * 用 `D:\zcode-glm5.3f\scripts\start-headless.ps1` 可无头静默启动。
 *
 * ## 独立运行
 *
 * 本插件不依赖 Jet Hub。桥不可用（ZCode 没跑）时，`listModels()` 返回 `[]`，
 * DSH 会把整个 provider 分组隐藏 —— 不会留下一个点不动的条目。
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ZCodeBridgeAdapter } from "./adapter.js";
import { PROVIDER } from "./product.js";
import { ModelVisibility } from "./model-visibility.js";
import { probeBridge, resolveBridgeEndpoint } from "./bridge-endpoint.js";
import {
  installInstanceLifecycleHooks,
  killOwnedInstance,
  spawnZCodeInstance,
  startKeepAlive,
} from "./instance-lifecycle.js";

/**
 * 插件配置 schema —— **必须有，否则模型设置页看不到本 provider**。
 *
 * ## 为什么（实测踩过的坑）
 *
 * `dsh-settings` 的 `describe()` 这样筛出「有 namespace 的 entry」
 * （`dsh-settings/lib/index.js:413-419`）：
 *
 * ```js
 * const schema = this.schema(entry);
 * if (schema === void 0 || ...) return [];
 * const form = volatileForm(schema);
 * if (form === void 0) return [];       // ← 没 schema 就没有 namespace
 * ```
 *
 * 没有 namespace 的 entry，模型设置页渲染不出那一行 ——
 * DSH 的原话是 **"Undeclared live routes render nowhere"**。
 *
 * 实测症状：provider 分组完全不出现（不是显示为"未配置"，是**整个不渲染**），
 * 而实例日志里既不报错也不提这个插件，排查时极易误判成"插件没加载"。
 * 用激活自证（打印 `settings.describe()` 的 ns 列表）才看出：
 * 桥端点解析正常，但 `zcode-bridge` 不在 ns 列表里。
 *
 * ## 字段设计
 *
 * `disabledModels` 是模型可见性开关的存储位置（设置页的拨动开关写这里）。
 * 用 `z.dict(z.dict(z.boolean()))` —— 形状是 `{ [provider]: { [modelId]: true } }`。
 * 默认空对象，表示"全部可见"。
 *
 * ## ⚠ 必须声明 `.volatile`（第二个坑，2026-09-27 实测）
 *
 * `dsh-settings` 用 `volatileForm()` 过滤出「设置页可编辑的字段」，
 * 它的实现只认两条路（`dsh-settings/lib/index.js`）：
 *
 * ```js
 * function volatileForm(schema) {
 *   if (schema.meta.volatile) return plainSchema(schema);   // ① 整棵树放行
 *   if (schema.type === "object") { ...逐字段递归... }       // ② 只认 object
 *   // 其他类型一律返回 undefined
 * }
 * ```
 *
 * 而 `z.dict(...)` 的 `type` 是 **`"dict"`，不是 `"object"`** ——
 * 递归到 `disabledModels` 时返回 undefined → 唯一字段被丢弃 →
 * `Object.keys(dict).length === 0` → **整个 form 变成 undefined** →
 * `describe()` 直接 `return []` 跳过这个 entry →
 * settings 里没有 namespace → **模型设置页根本渲染不出本 provider**。
 *
 * 实测症状与 `Config` 缺失时**完全一样**（provider 分组整个不出现，
 * 日志无任何报错），所以极易误判成"Config 没导出"。
 * 判据是 `settings.describe()` 里有没有自己的 ns，不是日志。
 *
 * `meta.volatile` 是本场景的正确开关：它是"部署期可变的配置"，
 * 变化后不需要重挂插件即可生效（DSH 的 Volatile configuration 机制）。
 */
// 显式标注返回类型：不标会让 tsc 去推断 cosmokit 的内部类型并报 TS2742
// （"The inferred type cannot be named without a reference to ..."，不可移植）。
//
// `.volatile()` 是 schemastery 的链式标记（`Schema.prototype.volatile`），
// 等价于 `.extra("volatile", true)` —— 对应 `meta.volatile = true`。
// 注意不要写成 `.meta({ volatile: true })`：那个方法返回 Meta 包装而不是
// schema，会丢掉 schema 类型（TS2349）。
const configSchema = z
  .object({
    disabledModels: z.dict(z.dict(z.boolean())).default({}),
  })
  .volatile();

export const Config: z<{ disabledModels: Record<string, Record<string, boolean>> }> =
  configSchema as unknown as z<{ disabledModels: Record<string, Record<string, boolean>> }>;

/**
 * 保活检查间隔。
 *
 * 10 秒是"用户察觉不到的恢复延迟"与"无谓进程枚举开销"的折中：
 * `tasklist /FI PID eq <n>` 在本机约 30-60 ms，10 秒一次完全无感。
 * 更短（如 2 秒）会让 DSH 空转，更长（如 60 秒）则壳挂后用户要等一分钟。
 */
const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * 连续几次探活失败才重启。
 *
 * 取 2 而非 1：进程枚举偶尔会因为系统负载阻塞超时，单次失败不足以判定死亡。
 * 10 秒 × 2 = 20 秒内恢复，仍远快于用户手动处理。
 */
const KEEPALIVE_FAILURES_BEFORE_RESTART = 2;

/**
 * 壳（ZCode 实例）的启动配置。
 *
 * ## 设计原则：装完就能用，不要用户先手工起壳
 *
 * 早期版本要求用户先跑 `start-headless.ps1` 把壳吊起来，否则 provider 分组
 * 是空的、看起来像插件坏了。**那是错误的设计** —— 依赖的东西应该由插件自己
 * 负责拉起。
 *
 * ## 自动探测
 *
 * 三样东西都有稳定的默认位置，不需要用户配置：
 *   1. **electron 可执行文件** —— ZCode 开源版的 `node_modules/electron/dist/electron.exe`
 *   2. **app 目录** —— 它的 `packages/desktop`
 *   3. **数据根目录** —— 与其他 ZCode 数据放一起（`ZCODE_DATA_BASE_DIR` 或家目录）
 *
 * 探测顺序（前者优先）：
 *   1. 环境变量显式指定（`ZCODE_BRIDGE_ELECTRON_PATH` / `ZCODE_BRIDGE_APP_DIR` /
 *      `ZCODE_DATA_BASE_DIR`）—— 给非常规安装位置留的口子
 *   2. 已知的安装路径候选表
 *
 * ## 开关
 *
 * `ZCODE_BRIDGE_AUTOSTART=0` 可显式关闭自启（默认 **开**）。
 * 关掉后插件只保活**已经存在**的壳，不会自己拉新的。
 */
interface SpawnConfig {
  readonly electronPath: string;
  readonly appDir: string;
  readonly dataBaseDir: string;
}

/**
 * electron 可执行文件的候选位置。
 *
 * ## 为什么必须动态生成（2026-09-27 修正）
 *
 * 早先这里是**写死的绝对路径**（作者本机的 `D:\DSH-WEB\ZCode-official\...`）。
 * 后果：**任何别人装这个插件都会静默不可用** —— 三个候选全部不存在，
 * `resolveSpawnConfig()` 返回 `undefined`，插件不报错、不提示，
 * 只是 provider 分组永远空着（因为桥不可用就隐藏分组）。
 *
 * 现在改成**按已知安装位置动态枚举**，覆盖：
 *   - 源码检出（开发者）：任意盘符下的 `<...>/ZCode-official/node_modules/electron/dist/electron.exe`
 *   - 官方安装版：`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 等
 *
 * 仍以环境变量为最高优先（非常规位置留的口子）。
 */
function electronCandidates(): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };

  // ① 本插件自己所在的数据目录旁边找源码检出（开发者机器最常见）。
  //    从插件安装位置向上找 `ZCode-official` 目录。
  try {
    let dir = __dirname;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, "node_modules", "electron", "dist", "electron.exe");
      push(candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // __dirname 在某些打包形态下不可用，忽略。
  }

  // ② 常见盘符下的源码检出（用户按项目文档 clone 的默认位置）。
  for (const drive of ["C:", "D:", "E:", "F:"]) {
    push(`${drive}\\DSH-WEB\\ZCode-official\\node_modules\\electron\\dist\\electron.exe`);
    push(`${drive}\\ZCode-official\\node_modules\\electron\\dist\\electron.exe`);
    push(`${drive}\\code\\ZCode-official\\node_modules\\electron\\dist\\electron.exe`);
  }

  // ③ 官方安装版的可执行文件（Electron 打包版）。
  const localAppData = process.env["LOCALAPPDATA"]?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    push(join(localAppData, "Programs", "ZCode", "ZCode.exe"));
    push(join(localAppData, "ZCode", "ZCode.exe"));
  }
  const programFiles = process.env["ProgramFiles"]?.trim();
  if (programFiles !== undefined && programFiles.length > 0) {
    push(join(programFiles, "ZCode", "ZCode.exe"));
  }

  return out;
}

/**
 * app 目录（含 package.json，其 main 指向入口）的候选位置。
 *
 * 与 {@link electronCandidates} 同源：源码检出用 `packages/desktop`。
 */
function appDirCandidates(): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };

  for (const drive of ["C:", "D:", "E:", "F:"]) {
    push(`${drive}\\DSH-WEB\\ZCode-official\\packages\\desktop`);
    push(`${drive}\\ZCode-official\\packages\\desktop`);
    push(`${drive}\\code\\ZCode-official\\packages\\desktop`);
  }

  return out;
}

/**
 * 数据根目录的候选位置（其下应有 `.zcode` 子目录）。
 *
 * 顺序即优先级：
 *   1. `ZCODE_DATA_BASE_DIR`（显式指定，最高优先）
 *   2. `~/.zcode` 的父目录 —— 即**家目录**。这是官方版的默认位置，
 *      所以放前面。插件通过「其下是否存在 `.zcode` 子目录」来确认。
 *   3. 源码检出的数据目录常见位置
 */
function dataDirCandidates(): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };

  push(process.env["ZCODE_DATA_BASE_DIR"]);
  // 家目录：官方版把数据写在 `~/.zcode`，所以 `homedir()` 就是 dataBaseDir。
  push(homedir());
  push(process.env["APPDATA"]);
  push(process.env["LOCALAPPDATA"]);

  for (const drive of ["C:", "D:", "E:", "F:"]) {
    push(`${drive}\\zcode-glm5.3f\\_oss_data`);
  }

  return out;
}

/** 取第一个存在的候选；都不存在返回 undefined。 */
function firstExisting(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // 权限/路径异常一律视为"这个候选不可用"，继续试下一个。
    }
  }
  return undefined;
}

function resolveSpawnConfig(): SpawnConfig | undefined {
  // 显式关闭自启。默认开 —— 用户装完插件重启 DSH 就该能用。
  if (process.env["ZCODE_BRIDGE_AUTOSTART"] === "0") {
    return undefined;
  }

  const electronPath =
    process.env["ZCODE_BRIDGE_ELECTRON_PATH"]?.trim() ??
    firstExisting(electronCandidates());
  const appDir =
    process.env["ZCODE_BRIDGE_APP_DIR"]?.trim() ??
    firstExisting(appDirCandidates());
  const dataBaseDir =
    process.env["ZCODE_DATA_BASE_DIR"]?.trim() ??
    (process.env["ZCODE_BRIDGE_BASE_URL"]?.trim() ? undefined : firstExisting(dataDirCandidates()));

  // 三者缺一不可：electron 用来启动，appDir 是它的入口，dataBaseDir 决定
  // 桥写发现文件的位置（readBridgePortFile 也按同一规则找）。
  if (electronPath === undefined || appDir === undefined || dataBaseDir === undefined) {
    return undefined;
  }
  return { electronPath, appDir, dataBaseDir };
}

/** 插件名（与 package.json 的 `name` 保持一致）。 */
export const name = "zcode-bridge";

/**
 * 静态注入的服务。
 *
 * ⚠ **不含 `credentials`** —— 本 provider 不要用户配置任何凭据
 * （端口与 token 都从桥的发现文件自动读取）。把 `credentials` 列进来
 * 会让插件在 headless/CLI profile 里永久 pending，进而整个 profile 以
 * `plugin tree failed to load` 启动失败。
 *
 * ⚠ **不含 `settings`** —— 该服务通过 `ctx.get('settings')` 可选取用，
 * 静态注入同样会在没有它的 profile 里卡住。
 */
export const inject = ["llm"];

/** 模块级持有适配器实例（便于将来加 RPC/诊断端点时取回）。 */
let registeredAdapter: ZCodeBridgeAdapter | undefined;

/** 取回已注册的适配器实例（未注册时 undefined）。 */
export function getRegisteredZCodeBridgeAdapter(): ZCodeBridgeAdapter | undefined {
  return registeredAdapter;
}

/**
 * settings namespace —— **必须等于 profile 里本插件 entry 的 `id`**。
 *
 * ## 为什么不是自己起一个名字
 *
 * `dsh-settings`（0.1.7-rc.2）的 `describe()` 用 `ns: entry.options.id`
 * 构造描述符（`lib/index.js:432`）—— 也就是说 namespace 是**按 profile
 * entry id 寻址**的，插件不能自定义。
 *
 * ## 为什么之前页面上没有这个 provider
 *
 * 之前这里写的是 `llm-zcode-bridge`（照搬 Jet Hub 的 `llm-<id>` 命名习惯）。
 * 但那个 namespace 在 settings 里**根本不存在** —— 于是模型设置页：
 *   - `joinProviderDirectory()` 能列出这一行（目录来自 `registerConfigurableProviders`）
 *   - 但该行**没有可编辑的 settings 地址** → 渲染不出编辑器
 *   - README 原文："Undeclared live routes render nowhere"
 *
 * 改成 `zcode-bridge`（与 cordis.patch.yml 的 entry id 一致）后，
 * settings 里能查到该 entry，模型设置页才能正常渲染。
 */
const SETTINGS_NS = "zcode-bridge";

/**
 * 探测 settings 服务是否可用（**不需要注册任何东西**）。
 *
 * 0.1.7-rc.2 的 `dsh-settings` 已经把 `register()` 移除了 —— namespace
 * 由 profile entry 的 `id` 天然构成，无需插件声明。所以这里只做可用性
 * 探测，供诊断输出用；**不再调用 `settings.register()`**（那个方法不存在，
 * 调用会抛 `settings.register is not a function`）。
 *
 * 保留这个函数是为了在日志里如实区分「settings 服务缺失」与
 * 「namespace 没对上」两种故障 —— 前者是 headless profile 的正常状态，
 * 后者才是配置错误。
 */
function probeSettings(ctx: Context): { available: boolean; namespaces: string[] } {
  const settings = ctx.get("settings") as { describe?: () => { ns: string }[] } | undefined;
  if (settings === undefined || typeof settings.describe !== "function") {
    return { available: false, namespaces: [] };
  }
  try {
    return { available: true, namespaces: settings.describe().map((d) => d.ns) };
  } catch {
    // describe() 会遍历所有 entry 的 schema；任一不合规都会抛。
    // 其他插件的问题不该阻断本插件注册，所以吞掉并如实标注。
    return { available: true, namespaces: [] };
  }
}

/**
 * 构造模型可见性存储。
 *
 * ## settings 服务的真实契约（0.1.7-rc.2）
 *
 * `dsh-settings` 在 rc.2 里**没有 `register()`** —— namespace 由 profile
 * entry 的 `id` 天然构成（`ns: entry.options.id`，见 `dsh-settings/lib/index.js:432`）。
 * 插件只能 `describe()` 读、`update()` / `replace()` / `mutate()` 写。
 *
 * 所以这里不注册任何东西，直接从 `describe()` 里找属于本插件的那个
 * namespace，用它构造一个 `{ get, replace }` 的 scope：
 *   - `get()` 读当前 section（含用户已存的 disabledModels）
 *   - `replace()` 整体写回（**必须 spread 保留其它字段**）
 *
 * ## settings 缺失时
 *
 * headless / CLI profile 没有 settings 服务，返回 `undefined` ——
 * 适配器不过滤，那些 profile 也没有设置页，开关无从谈起。
 */
function createModelVisibility(ctx: Context): ModelVisibility | undefined {
  const settings = ctx.get("settings") as
    | {
        describe?: () => { ns: string; value?: unknown }[];
        replace?: (ns: string, section: object) => Promise<void>;
      }
    | undefined;

  if (settings === undefined || typeof settings.describe !== "function") {
    return undefined;
  }

  const findNamespace = (): { ns: string; value?: unknown } | undefined => {
    try {
      return settings.describe!().find((row) => row.ns === SETTINGS_NS);
    } catch {
      // describe() 遍历所有 entry 的 schema，别人不合规也会抛。
      // 不该因此让本插件的开关失效 —— 返回 undefined 走降级路径。
      return undefined;
    }
  };

  if (findNamespace() === undefined || typeof settings.replace !== "function") {
    ctx.logger?.warn?.(
      `[zcode-bridge] settings 里没有 "${SETTINGS_NS}" entry，模型开关不持久化（仅进程内）`,
    );
    // 仍然返回实例：进程内黑名单照常工作，只是重启后丢失。
    return new ModelVisibility(undefined);
  }

  const scope = {
    get: (): Record<string, unknown> | undefined => {
      const row = findNamespace();
      const value = row?.value;
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    },
    replace: async (value: Record<string, unknown>): Promise<void> => {
      await settings.replace!(SETTINGS_NS, value);
    },
  };
  return new ModelVisibility(scope);
}

/**
 *
 * 注册顺序：先探 settings（诊断用），再 provider 声明 + 适配器 + 保活。
 */
export async function apply(ctx: Context): Promise<void> {
  const logger = {
    info: (...args: unknown[]) => ctx.logger?.info?.(String(args[0] ?? "")),
    warn: (...args: unknown[]) => ctx.logger?.warn?.(String(args[0] ?? "")),
  };

  // ── 激活自证（轻量诊断）────────────────────────────────────────────
  // ctx.logger 的输出未必落到 DSH 的日志文件里，"插件到底有没有激活"
  // 无法从日志判断。这里落一个标记文件，记录三个关键事实：
  //   ① settings 里有没有本插件的 namespace（决定模型设置页能否渲染）
  //   ② 桥端点（决定 provider 是否可用）
  //
  // ⚠ 采样必须延迟：settings 的 describe() 只收录 `fiber.state === 2`
  //   （激活完成）的 entry，而此处本插件还在 apply 中，自己必然不在列表里。
  //   立即采样会产生假阴性 —— 实测踩过，差点误判成 Config 没导出。
  setTimeout(() => {
    try {
      const probe = probeSettings(ctx);
      const endpoint = resolveBridgeEndpoint();

      // 关键：模型选择器「选不中 / 没反应」的直接原因只有两个可能 ——
      //   ① provider 没进 llm 路由表（listProviders 里没有）
      //   ② 进了但 listModels() 返回空（DSH 会把空目录的 provider 藏起来）
      // 这里把两者都记下来，一次判定到底卡在哪一层。
      let providers: unknown = null;
      let models: unknown = null;
      try {
        const llm = (ctx as unknown as {
          get: (name: string) => {
            listProviders?: () => { id?: string; name?: string }[];
          } | undefined;
        }).get("llm");
        providers = (llm?.listProviders?.() ?? []).map((p) => p.id ?? null);
      } catch (error) {
        providers = { probeError: String(error) };
      }
      void (async () => {
        try {
          models = (
            await (getRegisteredZCodeBridgeAdapter()?.listAllModels() ??
              Promise.resolve([]))
          ).map((m) => m.id);
          const listed = await getRegisteredZCodeBridgeAdapter()?.listModels(PROVIDER);
          models = {
            all: models,
            afterVisibilityFilter: (listed ?? []).map((m) => m.id),
            catalogReachable: await (getRegisteredZCodeBridgeAdapter()?.refreshCatalog() ??
              Promise.resolve(false)),
          };
        } catch (error) {
          models = { probeError: String(error) };
        }
        try {
          writeFileSync(
            join(tmpdir(), "dsh-zcode-bridge-settled.json"),
            JSON.stringify(
              {
                sampledAt: new Date().toISOString(),
                settingsNsExpected: SETTINGS_NS,
                settingsNsFound: probe.namespaces.includes(SETTINGS_NS),
                namespaces: probe.namespaces,
                bridgeEndpoint: endpoint?.baseUrl ?? null,
                llmProviders: providers,
                models,
              },
              null,
              2,
            ),
            "utf8",
          );
        } catch {
          // 诊断失败不影响功能。
        }
      })();
    } catch {
      // 诊断失败不影响功能。
    }
  }, 5000).unref?.();

  // settings 探测（只诊断，不注册 —— 见 probeSettings 的说明）。
  const settingsProbe = probeSettings(ctx);
  if (!settingsProbe.available) {
    logger.info("[zcode-bridge] settings 服务不可用（headless/CLI profile），跳过配置页");
  } else if (!settingsProbe.namespaces.includes(SETTINGS_NS)) {
    // 这条是真正的配置错误：provider 会在模型选择器里可见，
    // 但模型设置页渲染不出这一行（README："Undeclared live routes render nowhere"）。
    logger.warn(
      `[zcode-bridge] settings 里没有 "${SETTINGS_NS}" entry —— `
        + `模型设置页不会显示本 provider。请确认 profile 的 cordis.patch.yml 里 `
        + `entry id 与 SETTINGS_NS 一致。当前已有: ${settingsProbe.namespaces.join(", ")}`,
    );
  }

  // ── 壳的生命周期（双向绑定）────────────────────────────────────────
  //
  // 壳挂 = 对话断：每次请求都要过壳的 session 链路拿 captcha 并走免费额度，
  // 壳不在就整条链路断掉。所以这里不是"优化"，是可用性前提。
  //
  //   ① 拉起：DSH 起来时壳不在 → **立即自动启动**（默认开）
  //   ② 保活：DSH 活着期间壳挂了 → 自动重启
  //   ③ 收尾：DSH 退出 → 壳跟着退（不留孤儿）
  //
  // ★ ① 是刚需，不是可选项。早期版本要用户先手工跑 `start-headless.ps1`，
  //   否则 provider 分组是空的、看起来像插件坏了 —— 那是错误的设计。
  const spawnConfig = resolveSpawnConfig();

  // 先看壳是否已经在跑（发现文件存在 + /health 通）。
  // 已在跑就不重复启动 —— 否则会起出第二个实例，两个都抢同一个端口文件。
  const bridgeAlreadyUp =
    resolveBridgeEndpoint() !== undefined &&
    (await probeBridge(resolveBridgeEndpoint()!));

  if (!bridgeAlreadyUp && spawnConfig !== undefined) {
    logger.info("[zcode-bridge] 壳未运行，自动启动（可用 ZCODE_BRIDGE_AUTOSTART=0 关闭）");
    // 不 await 完整就绪 —— 壳要 ~30 秒，阻塞 apply 会拖慢 DSH 启动。
    // 启动后在后台等就绪，桥就绪时 provider 的 listModels() 自然能看到。
    void spawnZCodeInstance(spawnConfig, logger)
      .then((pid) => {
        if (pid !== undefined) {
          logger.info(`[zcode-bridge] 壳已就绪 pid=${pid}`);
        }
      })
      .catch((error: unknown) => {
        logger.warn(`[zcode-bridge] 壳自动启动失败: ${String(error)}`);
      });
  } else if (!bridgeAlreadyUp && spawnConfig === undefined) {
    logger.warn(
      "[zcode-bridge] 壳未运行，且未探测到 ZCode 安装位置 —— provider 不可用。"
        + "请用 ZCODE_BRIDGE_ELECTRON_PATH / ZCODE_BRIDGE_APP_DIR 指定，"
        + "或设 ZCODE_BRIDGE_BASE_URL + ZCODE_BRIDGE_TOKEN 直连已有桥。",
    );
  }

  const keepAlive = startKeepAlive(
    {
      intervalMs: KEEPALIVE_INTERVAL_MS,
      failuresBeforeRestart: KEEPALIVE_FAILURES_BEFORE_RESTART,
      ...(spawnConfig === undefined ? {} : { spawn: spawnConfig }),
    },
    logger,
  );

  const llm = ctx.get("llm") as
    | {
        registerConfigurableProviders: (entries: readonly unknown[]) => void;
        registerAdapter: (providers: readonly string[], adapter: unknown) => void;
      }
    | undefined;

  if (llm === undefined) {
    ctx.logger?.error?.("[zcode-bridge] llm 服务不可用，provider 未注册");
    return;
  }

  // ── 模型可见性（拨动开关）──────────────────────────────────────────
  //
  // DSH 核心没有「逐模型开关」—— Jet Hub 那套是它自己写的，这里复刻。
  // 存储走 settings 的 `zcode-bridge` section（与 profile entry id 同名）。
  //
  // settings 服务缺失时（headless/CLI profile）返回 undefined，
  // 适配器不做过滤 —— 那些 profile 没有设置页，也就没有开关可言。
  const visibility = createModelVisibility(ctx);

  llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: "ZCode Bridge (GLM free)",
      // ★ 必须等于 profile entry 的 id —— settings 是按 entry id 寻址的。
      //   用别的名字会让模型设置页渲染不出这一行（详见 SETTINGS_NS 的注释）。
      settingsNs: SETTINGS_NS,
      settingsPath: [],
    },
  ]);

  const adapter = new ZCodeBridgeAdapter({
    ...(visibility === undefined ? {} : { visibility }),
    logger: {
      info: (message: unknown) => ctx.logger?.info?.(message),
      warn: (message: unknown) => ctx.logger?.warn?.(message),
    },
  });

  llm.registerAdapter([PROVIDER], adapter);
  adapter.start();

  ctx.effect(() => () => {
    adapter.dispose();
    // 插件被热卸载时停掉保活循环，并带走壳（若壳是本插件启动的）。
    // 注意：这条只覆盖热卸载；进程被 kill 的路径由 instance-lifecycle 的
    // `process.on("exit")` 兜底 —— 两者都要有，缺一会漏场景。
    keepAlive.stop();
    killOwnedInstance();
    if (registeredAdapter === adapter) {
      registeredAdapter = undefined;
    }
  });

  registeredAdapter = adapter;
  ctx.logger?.info?.(`[zcode-bridge] provider "${PROVIDER}" 已注册（端口从桥发现文件读取）`);
}

/**
 * 把 Config 挂到 `apply` 函数本身。
 *
 * ## 为什么必须这样做（cordis 源码实测）
 *
 * cordis 建插件 runtime 时取的是**传入 plugin 对象的** `Config`
 * （`@deepseek-ai/cordis/lib/index.js:1623-1633`）：
 *
 * ```js
 * const callback = this.resolve(plugin);   // 函数式插件 → 返回函数本身
 * runtime = { name, callback, fibers: ..., Config: plugin.Config };
 * ```
 *
 * 而 `resolve()`（同文件 `RegistryService.resolve`）：
 *
 * ```js
 * if (typeof plugin === "function") return plugin;   // ← 函数式插件走这条
 * if (isApplicable(plugin)) return plugin.apply;
 * ```
 *
 * 如果 loader 把**裸 `apply` 函数**传进来，那么 `plugin` 就是那个函数 ——
 * `plugin.Config` 只有在 **`apply.Config` 存在**时才取得到。
 * 仅靠模块级 `export const Config` 时，`runtime.Config` 会是 undefined，
 * 于是 settings 的 `schema(entry)` 返回 undefined，`describe()` 跳过这个
 * entry → **没有 namespace → 模型设置页渲染不出这个 provider**。
 *
 * 挂成静态属性是两种传法下都成立的写法，因此无副作用地消除这个不确定性。
 */
apply.Config = Config;
