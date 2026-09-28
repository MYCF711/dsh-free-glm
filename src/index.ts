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
import { probeBridge, resolveBridgeEndpoint, resolveLiveBridgeEndpoint } from "./bridge-endpoint.js";
import {
  fetchBilling,
  requestClaim,
  requestCliLogin,
  requestLogin,
  type BillingData,
  type ClaimData,
} from "./bridge-ops.js";
import { createQuotaGuard, type QuotaGuard } from "./quota-guard.js";
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
 * ## 顺序即优先级，且**检出目录必须在家目录之前**（2026-09-27 实测修正）
 *
 * 旧顺序把 `homedir()` 放在检出目录前面，后果实测过：
 *
 *   launcher 环境块过期 → `ZCODE_DATA_BASE_DIR` 读不到
 *     → `firstExisting()` 命中 `homedir()`（它永远存在）
 *     → 插件**把壳启动到家目录**，壳把发现文件写到
 *       `C:\Users\Administrator\.zcode\v2\bridge-port.json`
 *     → 而 `D:\...\_oss_data\.zcode\v2\` 里还留着**上一个实例**的旧文件
 *     → 两份并存、一活一死，端点解析挑错就触发保活误杀
 *       （观测现象：实例进程树每 10-30 秒整体消失一次）
 *
 * 为什么检出目录优先：`<盘符>\zcode-glm5.3f\_oss_data` 这个路径**不会凭空
 * 出现**，它存在就证明这台机器上装过源码版实例；而 `homedir()` 人人都有，
 * 只是个"碰巧存在的目录"，不构成证据。
 *
 * 实测两个目录的内容差异（2026-09-27）也支持这个判断：
 *   - `homedir()` 的 `tasks-index.sqlite` 483 KB（故障后才新建的空壳）
 *   - 检出目录的 `tasks-index.sqlite` 2.4 MB（真实会话史）
 *
 * ⚠ 与 `bridge-endpoint.ts` 的 `dataDirCandidates()` **必须保持同序** ——
 *   一个管「壳往哪写」，一个管「插件往哪读」，顺序不一致就会重新分裂。
 */
function dataDirCandidates(): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0 && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  };

  // 1. 显式指定，最高优先 —— 用户说了算，不被任何推测覆盖。
  push(process.env["ZCODE_DATA_BASE_DIR"]);

  // 2. 源码检出的数据目录（存在即证据）。
  for (const drive of ["C:", "D:", "E:", "F:"]) {
    push(`${drive}\\zcode-glm5.3f\\_oss_data`);
  }

  // 3. 官方版的默认落点：数据根就是家目录（其下有 `.zcode`）。
  push(homedir());
  push(process.env["APPDATA"]);
  push(process.env["LOCALAPPDATA"]);

  return out;
}

/**
 * 候选数据目录的**选择函数** —— 返回第一个「真的能被当成数据根」的候选。
 *
 * ## 为什么不能只按「目录存在」选（2026-09-27 实测踩过，两份发现文件的来源）
 *
 * 旧实现在候选表上跑 `firstExisting()` —— 只看**目录在不在**。
 * 实测后果：`homedir()` 永远存在 → 命中它 → 插件把壳启动到家目录 →
 * 壳把发现文件写到 `C:\Users\Administrator\.zcode\v2\bridge-port.json`，
 * 而 `D:\...\_oss_data` 里还留着上一个实例的旧文件 → 两份并存、一活一死。
 *
 * ## 为什么不是「谁有 bridge-port.json 谁优先」（试过，**是错的**）
 *
 * 按「有发现文件=高分」排序时**两个目录同分**，而家目录排在前面 ——
 * 因为家目录那份文件正是**故障本身的产物**。用故障产物当判据只会加固故障。
 *
 * ## 采用的判据
 *
 * `dataDirCandidates()` 已经把**检出目录排在家目录之前**（见该函数注释），
 * 这里只做一层真实性校验：
 *   - 首选候选里有 `.zcode` → 直接用它（这是正常路径，不额外付代价）
 *   - 否则退到第一个「其下有 `.zcode`」的候选（兼容全新安装的机器）
 *
 * ⚠ 不再引入打分排序 —— 打分在实测中出现过两个候选同分、
 *   而错误项因"先来"胜出的情况。**顺序显式写死，比动态打分可预测。**
 */
function pickDataBaseDir(): string | undefined {
  const candidates = dataDirCandidates();

  // 首选候选真的像数据根 → 直接用。
  const first = candidates[0];
  if (first !== undefined && hasZcodeData(first)) {
    return first;
  }

  // 否则取第一个「其下有 .zcode」的候选。
  for (const candidate of candidates) {
    if (hasZcodeData(candidate)) {
      return candidate;
    }
  }

  // 都没有：仍然接受首选候选（首次安装、还没建数据目录的情况）。
  return first;
}

/** 这个目录像不像一个 ZCode 数据根（其下有 `.zcode`）。 */
function hasZcodeData(dir: string): boolean {
  try {
    return existsSync(join(dir, ".zcode"));
  } catch {
    return false;
  }
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
  // ⚠ dataBaseDir 必须用 `pickDataBaseDir()`（带「这里有 `.zcode` 数据」校验），
  //   不是 `firstExisting(dataDirCandidates())` ——
  //   旧用法只看"目录在不在"，而 `homedir()` 永远在 → 插件把壳启动到家目录
  //   → 发现文件写到 `C:\Users\Administrator\.zcode\v2\`，
  //   而 `D:\...\_oss_data\.zcode\v2\` 里还留着上一个实例的旧文件 → 两份并存。
  const autoDataBaseDir = pickDataBaseDir();
  const dataBaseDir =
    process.env["ZCODE_DATA_BASE_DIR"]?.trim() ??
    (process.env["ZCODE_BRIDGE_BASE_URL"]?.trim() ? undefined : autoDataBaseDir);

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

/**
 * 模块级持有额度守卫（2026-09-28 新增）。
 *
 * 用途：让「登录命令」在登录完成后能**立刻补跑一次检索领取** ——
 * 用户刚授权完，正是最该看一眼有没有新额度可领的时刻，
 * 不必等 20 分钟后的定时周期。
 */
let registeredQuotaGuard: QuotaGuard | undefined;

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
  const bridgeAlreadyUp = (await resolveLiveBridgeEndpoint()) !== undefined;

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

  /**
   * 【按需拉起】确保桥可用；不可用就自己拉起来并**等它就绪**。
   *
   * ## 为什么必须有（这是设计缺陷的修复，2026-09-27）
   *
   * 早先只有「DSH 启动时拉起」+「后台保活」两条路径。**模型调用时没有任何兜底** ——
   * 壳挂掉后（崩溃、被手动关闭、启动失败），用户一发消息就直接吃
   * `MISSING_CREDENTIAL: 找不到 ZCode 桥`，得自己想办法重启。
   *
   * 这是错的：用户点"发送"时，插件应该**先把依赖拉起来**，而不是把
   * 「壳没跑」这件事当成用户的错误抛回去。
   *
   * ## 与保活的分工
   *
   *   - 保活：DSH 活着期间周期探测（10 秒一次），挂了就重启 —— 针对"事后发现"
   *   - 本函数：**请求发起前**同步确保可用 —— 针对"这一刻就要用"
   *
   * 两者互补：保活管背景自愈，本函数管前台可用性。
   *
   * ## 为什么要等（而不是拉起就返回）
   *
   * 壳冷启动约 20-40 秒。若只"发起启动"就返回，请求立刻会因桥未就绪而失败 ——
   * 那是把延迟变成了错误。这里等就绪（最多 90 秒），用户的体感是
   * 「这一轮比较慢」，而不是「报错了」。
   *
   * ## 并发去重
   *
   * DSH 会并发发请求（主回复 + 标题生成 + 压缩）。若每个请求都去拉起壳，
   * 会同时 spawn 多个实例 —— 而 ZCode 有**单实例锁**，它们会互相踢掉。
   * 所以用 `pendingEnsure` 做单例：同一时刻只有一个"确保"在跑，其余等它。
   */
  let pendingEnsure: Promise<boolean> | undefined;

  async function ensureBridgeReady(timeoutMs = 90_000): Promise<boolean> {
    // 快路径：桥已就绪，不付任何代价。
    if ((await resolveLiveBridgeEndpoint()) !== undefined) {
      return true;
    }
    if (spawnConfig === undefined) {
      // 探测不到安装位置 —— 拉起无从谈起，让调用方报明确的配置错误。
      return false;
    }
    if (pendingEnsure !== undefined) {
      // 已有一个"确保"在跑：等它，不要重复 spawn。
      return await pendingEnsure;
    }

    pendingEnsure = (async (): Promise<boolean> => {
      logger.info("[zcode-bridge] 请求前探测到壳不可用，正在拉起（最长等待 90 秒）…");
      const startedAt = Date.now();
      try {
        await spawnZCodeInstance(spawnConfig, logger);
        const elapsed = Date.now() - startedAt;
        if ((await resolveLiveBridgeEndpoint()) !== undefined) {
          logger.info(`[zcode-bridge] 壳已就绪（用时 ${Math.round(elapsed / 1000)} 秒）`);
          return true;
        }
        logger.warn(`[zcode-bridge] 壳拉起后仍不可达（用时 ${Math.round(elapsed / 1000)} 秒）`);
        return false;
      } catch (error: unknown) {
        logger.warn(`[zcode-bridge] 拉起壳失败: ${String(error)}`);
        return false;
      } finally {
        // 让超时参数真正生效：spawnZCodeInstance 自己等就绪，这里兜一个上限。
        pendingEnsure = undefined;
      }
    })();

    // 超时保护 —— 不能让一个卡住的启动把请求永久挂住。
    const timeout = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      t.unref?.();
    });
    const ready = await Promise.race([pendingEnsure, timeout]);
    if (!ready) {
      pendingEnsure = undefined;
    }
    return ready;
  }

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
    // 【按需拉起】每轮请求前确保壳可用 —— 修掉"壳挂了就报 MISSING_CREDENTIAL"
    // 这个设计缺陷：用户点发送时，插件应该先把依赖拉起来，而不是把
    // "壳没跑"当成用户的错误抛回去。
    ensureReady: () => ensureBridgeReady(),
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

  /**
   * ★ 每日额度守卫（2026-09-28 新增）。
   *
   * ## 解决什么
   *
   * 用户诉求：「时刻检索每日随机派发的大额额度，自动领取」。
   *
   * ## 为什么「检索」是必要的（实测依据）
   *
   * 服务端不下推额度。ZCode 左下角那张卡片读的是 `GET /billing/preview`，
   * 而它的内容**依赖客户端活跃信号**：
   *
   * ```
   * 补 POST /event/report {app_launch, app_daily_active} 之前：
   *   preview → {"code":0,"data":{"plans":[]}}            ← 空
   * 补之后：
   *   preview → {"plans":[{plan_id:"zcode-v3-start-plan-trust-0928",...}]}
   * ```
   *
   * **⇒「随机派发」= 服务端按活跃信号决定给不给。**
   * 所以「时刻检索」= 定期补活跃信号 + 查 preview + 有就领。
   *
   * ## 安全性（已实测）
   *
   * - **幂等**：已领时返回 `code:1003`，连调 3 次结果一致且**不消耗额度**
   * - 间隔 20 分钟（一天 72 次），远低于第三方提到的 WAF 阈值
   * - **串行执行**（递归 setTimeout），避免并发 mint 抢 captcha
   *
   * 关闭：`ZCODE_QUOTA_GUARD_DISABLED=1`
   * 调间隔：`ZCODE_QUOTA_GUARD_INTERVAL_MS=600000`
   */
  const quotaGuard = createQuotaGuard({
    log: {
      info: (message: string) => ctx.logger?.info?.(message),
      warn: (message: string) => ctx.logger?.warn?.(message),
    },
  });
  ctx.effect(() => () => {
    quotaGuard.stop();
  });
  registeredQuotaGuard = quotaGuard;

  /**
   * ★ 注册斜杠命令（2026-09-28 新增）—— 这才是「用户点一下」的正确载体。
   *
   * ## 为什么用命令而不是工具
   *
   * 命令**由用户发起**（聊天框打 `/zcode-login`），结果直接渲染、
   * **不进模型上下文**（`dsh-commands` README 原文：「不会把命令或结果
   * 变成模型消息」）。
   *
   * 这对登录尤其重要 —— 若做成工具：
   * - 模型可能「假装已登录」（它只是调了个函数，并不知道浏览器里发生了什么）
   * - 登录结果会污染对话上下文
   *
   * 而工具（`ctx.tools.register`）只在想让模型**自主**查额度时才需要，
   * 本版先不做，避免模型乱调。
   *
   * ## ⚠ 用 `ctx.get('commands')` 而不是静态 `inject`
   *
   * 本项目踩过这个坑：静态 `inject` 会让插件在**缺少该服务**的 profile 里
   * **永久 pending**（headless profile 可能没有 commands 服务）。
   * 而 `ctx.get()` 拿不到时返回 undefined（**不抛错**），运行时空值检查即可。
   *
   * 参考实现：`dsh-kvmem-image-gate/lib/index.js:96-97` 就是这个写法。
   */
  registerSlashCommands(ctx);

  ctx.logger?.info?.(`[zcode-bridge] provider "${PROVIDER}" 已注册（端口从桥发现文件读取）`);
}

/** 命令处理器返回值的形状（与 `dsh-commands` 的 `CommandResult` 对齐）。 */
type SlashCommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

/** 命令调用的上下文（只取我们需要的字段）。 */
interface SlashCommandInvocation {
  readonly rawInput?: string;
  readonly signal?: AbortSignal;
}

/** `CommandRuntime` 的最小形状（避免 import 它的类型 —— 该包可能不在所有 profile 里）。 */
interface MinimalCommandRuntime {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string };
    handler: (invocation: SlashCommandInvocation) => SlashCommandResult | Promise<SlashCommandResult>;
  }): () => void;
}

/** 把额度数字格式化成易读串。 */
function formatUnits(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "未知";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

/**
 * 查额度并渲染成人可读的多行文本。
 *
 * 抽出来是因为 `/zcode-quota` 命令与登录后的自动检索都要用。
 */
async function renderBilling(): Promise<SlashCommandResult> {
  const result = await fetchBilling();
  if (!result.ok) {
    return { kind: "error", text: `查额度失败：${result.error ?? "未知原因"}` };
  }
  const b: BillingData | undefined = result.data;
  const periodLabel =
    b?.period === "one_time"
      ? "活动赠送（会过期）"
      : b?.period === "daily"
        ? "每日刷新（订阅）"
        : b?.period ?? "未知";
  const lines = [
    `套餐：${b?.planName ?? "（无活动）"}`,
    `模型：${b?.modelName ?? "未知"}`,
    `周期：${periodLabel}`,
    `总额：${formatUnits(b?.totalUnits)}   已用：${formatUnits(b?.usedUnits)}`,
    `剩余：${formatUnits(b?.remainingUnits)}`,
    b?.expiresAtLocal !== null && b?.expiresAtLocal !== undefined
      ? `到期：${b.expiresAtLocal}`
      : "到期：未知",
  ];
  return { kind: "success", text: lines.join("\n") };
}

/**
 * 注册三个命令：登录 / 查额度 / 领额度。
 *
 * 命令名规则（`dsh-commands` 契约）：**不带斜杠、小写**，
 * 只允许字母数字 `_` `-`。用户实际输入时加 `/`。
 */
function registerSlashCommands(ctx: Context): void {
  const commands = ctx.get("commands") as MinimalCommandRuntime | undefined;
  if (commands === undefined) {
    ctx.logger?.warn?.(
      "[zcode-bridge] 当前 profile 没有 commands 服务，斜杠命令未注册（provider 功能不受影响）",
    );
    return;
  }

  /** 包装：任何异常都转成可读 error，不让 command/done 以异常结算。 */
  const guard = async (
    run: () => Promise<SlashCommandResult>,
  ): Promise<SlashCommandResult> => {
    try {
      return await run();
    } catch (error) {
      return { kind: "error", text: error instanceof Error ? error.message : String(error) };
    }
  };

  ctx.effect(() => {
    /**
     * `/zcode-login` —— 登录 ZCode。
     *
     * 语义（**重要，要在提示文案里说清**）：
     * 返回成功 **只代表授权页已弹出**，登录要等用户在浏览器里点「授权」。
     * 实例侧有 5 分钟轮询（`OAuth polling flow started`），授权完成后
     * 凭据自动写回。
     *
     * 登录后**立刻补跑一次额度检索** —— 用户刚授权完，正是最该看
     * 有没有新额度可领的时刻，不必等 20 分钟的定时周期。
     */
    const d1 = commands.register({
      name: "zcode-login",
      description: "登录 ZCode（弹出浏览器授权页；授权完成后凭据自动写回）",
      handler: async () =>
        await guard(async () => {
          /**
           * ★ 优先走「服务端中介登录」（2026-09-28）。
           *
           * 原路径经 `/api/v1/oauth/token` 换 token，而该端点自 09-28 起
           * 稳定返回 `500 / code 2007`（假 code 直测也是 500 ⇒ 端点故障）。
           *
           * 新路径 `/oauth/cli/*` 是官方 3.12.3 桌面版的默认方式：
           * 授权在服务端完成，token 由轮询直接返回。
           *
           * **⚠ 同步等待最长 5 分钟** —— 等用户在浏览器点「授权」。
           * 失败时回退到 renderer 路径（至少能弹出授权页）。
           */
          const cliResult = await requestCliLogin({ waitMs: 280_000 });
          if (cliResult.ok && typeof cliResult.data?.token === "string") {
            return {
              kind: "success",
              text: [
                "★ 登录成功（服务端中介路径）",
                "",
                `账号: ${JSON.stringify(cliResult.data.user ?? "未知")}`,
                "",
                "凭据已由服务端签发。可用 /zcode-quota 查看额度。",
              ].join("\n"),
            };
          }
          if (cliResult.ok && cliResult.data?.timeout === true) {
            return {
              kind: "error",
              text: [
                `等待授权超时（当前状态 ${cliResult.data.lastStatus ?? "pending"}）。`,
                "请在浏览器里完成登录并点「授权」，然后重新执行 /zcode-login。",
                cliResult.data.authorizeUrl !== undefined
                  ? `授权页: ${cliResult.data.authorizeUrl}`
                  : "",
              ].filter((s) => s.length > 0).join("\n"),
            };
          }
          const result = await requestLogin();
          if (!result.ok) {
            return {
              kind: "error",
              text: `两条登录路径都失败。\n服务端中介: ${cliResult.error ?? "未知"}\nrenderer: ${result.error ?? "未知"}`,
            };
          }
          /**
           * ⚠ **不要**在这里 `void runOnce()`（2026-09-28 实测踩过）。
           *
           * ## 症状
           *
           * 命令报 `UNKNOWN: This operation was aborted`，而同结构的
           * `/zcode-quota`、`/zcode-claim` 都正常。
           *
           * ## 根因
           *
           * `runOnce()` 会跑完整的检索周期（2 次 `fetchBilling` +
           * `requestClaim`，含 captcha mint，耗时 2-30 秒）。
           * 而**命令 handler 返回后，headless 模式的 DSH 进程即退出** ——
           * 那个 fire-and-forget 的 promise 被掐断，abort 冒泡成命令错误。
           *
           * ## 正确做法
           *
           * 登录后的补跑检索**由 quota-guard 自己的定时器负责**
           * （`createQuotaGuard` 已在 `apply()` 里启动，首轮延迟 2 分钟）。
           * 用户如果不想等，直接调 `/zcode-claim` 即可 —— 那是同步等待的。
           *
           * ## 教训（通用）
           *
           * **命令 handler 里不要留未 await 的后台 promise** ——
           * 调用方（尤其是短命的 headless 进程）可能在它完成前就结束，
           * 结果是「命令看起来失败了，但其实副作用可能只做了一半」。
           */
          return {
            kind: "success",
            text: [
              "已请求 ZCode 弹出授权页，请在浏览器里完成登录并点「授权」。",
              "",
              "授权完成后凭据会自动写回，无需其他操作。",
              "之后可用 /zcode-quota 查看额度、/zcode-claim 领取派发额度。",
              "",
              "（登录状态由 5 分钟轮询自动确认；本命令返回不代表已登录）",
            ].join("\n"),
          };
        }),
    });

    /** `/zcode-quota` —— 查额度。 */
    const d2 = commands.register({
      name: "zcode-quota",
      description: "查看 ZCode 免费额度（剩余量 / 到期时间 / 一次性还是每日）",
      handler: async () => await guard(renderBilling),
    });

    /**
     * `/zcode-claim` —— 领取派发额度（手动兜底）。
     *
     * 定时任务已在 `createQuotaGuard` 里自动跑；本命令用于
     * 「不想等，现在就试一次」。
     */
    const d3 = commands.register({
      name: "zcode-claim",
      description: "立刻检索并领取 ZCode 派发的额度（定时任务之外的兜底手段）",
      handler: async () =>
        await guard(async () => {
          const result = await requestClaim();
          if (!result.ok) {
            return { kind: "error", text: `领取失败：${result.error ?? "未知原因"}` };
          }
          const data: ClaimData | undefined = result.data;
          const discovered = data?.discoveredPlans ?? [];
          const newlyClaimed = (data?.results ?? []).filter(
            (r) => r.ok === true && r.alreadyClaimed !== true,
          );
          const lines = [
            discovered.length === 0
              ? "未发现可领的派发额度（服务端当前没有投放）。"
              : `发现 ${discovered.length} 个 plan：${discovered.join(", ")}`,
            newlyClaimed.length > 0
              ? `★ 新领取成功：${newlyClaimed.map((r) => r.planId ?? "?").join(", ")}`
              : "全部已领取过（幂等，无新增）。",
          ];
          // 领完补一次额度展示，让用户看到最新余额
          const after = await fetchBilling();
          if (after.ok && after.data !== undefined) {
            lines.push(
              "",
              `当前剩余：${formatUnits(after.data.remainingUnits)}`,
              `套餐：${after.data.planName ?? "无"}（${after.data.expiresAtLocal ?? "?"} 到期）`,
            );
          }
          return { kind: "success", text: lines.join("\n") };
        }),
    });

    return () => {
      d1();
      d2();
      d3();
    };
  });

  ctx.logger?.info?.(
    "[zcode-bridge] 已注册斜杠命令：/zcode-login /zcode-quota /zcode-claim",
  );
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
