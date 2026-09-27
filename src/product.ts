/**
 * 产品常量与桥发现逻辑。
 *
 * ## 渠道形态
 *
 * 本 provider **不直连 zcode.z.ai**，而是连一个**本机的 HTTP 桥**
 * （`zcodeBridgeServer.ts`，跑在 ZCode 开源版实例内部）。
 *
 * 为什么必须这样：
 *   免费额度通道（`account:bigmodel-start-plan`）强制要求阿里云 captcha，
 *   而 captcha 只能在真实 Electron renderer 里跑（需要 DOM + CDN 脚本）。
 *   外部进程无法复用这条链 —— 直连一律 405/3012。
 *
 * 桥的发现方式：读 ZCode 实例写下的 `<dataBaseDir>/.zcode/v2/bridge-port.json`，
 * 里面有端口与访问 token。
 */

/** provider 路由名（注册进 ctx.llm 的 key，也是 DSH 设置页里的分组标识）。 */
export const PROVIDER = "zcode-bridge";

/** 选择器里的展示名。 */
export const DISPLAY_NAME = "ZCode Bridge (GLM free)";

/** 桥的默认监听地址（port 从发现文件读）。 */
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";

/**
 * 覆盖桥地址的环境变量。
 *
 * 形如 `http://127.0.0.1:58857`。设了就不读发现文件 —— 用于调试或
 * 桥跑在别的机器上（后者需要自行承担暴露风险，桥默认只绑 loopback）。
 */
export const BASE_URL_ENV = "ZCODE_BRIDGE_BASE_URL";

/** 覆盖桥 token 的环境变量（与 BASE_URL_ENV 配套；只设 base 不设 token 会 401）。 */
export const TOKEN_ENV = "ZCODE_BRIDGE_TOKEN";

/**
 * ZCode 数据根目录覆盖。
 *
 * 缺省按平台取 `~/.zcode`。桥把发现文件写在
 * `<dataBaseDir>/.zcode/v2/bridge-port.json`，其中 `dataBaseDir` 由 ZCode 实例
 * 的 `ZCODE_DATA_BASE_DIR` 环境变量决定 —— 所以自定义数据目录的实例
 * 必须在这里同样指定，否则找不到。
 */
export const DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR";

/** 桥的健康检查端点（**不需要 token**，用于快速判断实例是否在跑）。 */
export const HEALTH_PATH = "/health";

/** 桥的模型列表端点（需要 token）。 */
export const MODELS_PATH = "/v1/models";

/** 桥的对话补全端点（OpenAI 兼容，需要 token）。 */
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * 桥的发现文件相对路径（相对数据根目录）。
 *
 * 与 `zcodeBridgeServer.ts` 的写入路径必须逐字一致：
 * `<dataBaseDir>/.zcode/v2/bridge-port.json`
 */
export const BRIDGE_PORT_FILE_RELATIVE = ".zcode/v2/bridge-port.json";

/** 发现文件的 schema 版本；不匹配时视为过期。 */
export const BRIDGE_PORT_SCHEMA_VERSION = 2;

/**
 * 发现文件的结构。
 *
 * 由 `zcodeBridgeServer.ts` 写入。字段名逐字对应，改这里要同步改那边。
 */
export interface ZCodeBridgePortFile {
  readonly schemaVersion: number;
  readonly service: string;
  readonly transport: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly models: readonly string[];
  readonly defaultProviderId: string;
  readonly instanceId: string;
  readonly writtenAt: number;
}

/** 解析后的桥地址。 */
export interface ZCodeBridgeEndpoint {
  /** 形如 `http://127.0.0.1:58857`，**无尾斜杠**。 */
  readonly baseUrl: string;
  /** Bearer token。 */
  readonly token: string;
  /** 来源，供诊断输出。 */
  readonly source: "env" | "discovery-file";
  /** 发现文件里播报的模型（env 来源时为空数组）。 */
  readonly models: readonly string[];
}

/**
 * 静态模型表。
 *
 * ⚠ 只声明**真正验证过**的能力：
 *   `GLM-5.3` 与 `GLM-5.3-Flash` 都只报 `text` —— 桥的端点收
 *   `content: string`，图片链路未验证（`normalizeMessages` 会把非字符串
 *   content 丢弃）。多报 `image` 会让 DSH 把图片投影成 data URL 直发，
 *   结果被静默丢弃（用户看到"模型看不到图"），比少报更糟。
 *
 * `contextWindow` / `maxTokens` 采信桥侧实例的配置。
 */
export const MODELS = [
  { id: "GLM-5.3", name: "GLM-5.3", contextWindow: 200_000, maxTokens: 32_768 },
  { id: "GLM-5.3-Flash", name: "GLM-5.3-Flash", contextWindow: 200_000, maxTokens: 32_768 },
] as const;

/** 模型条目类型。 */
export type ZCodeBridgeModel = (typeof MODELS)[number];

/** 产品描述对象 —— 与 Jet Hub 其它 provider 的 `XxxProduct` 同构。 */
export const ZCODE_BRIDGE = {
  id: PROVIDER,
  displayName: DISPLAY_NAME,
  defaultBaseUrl: DEFAULT_BRIDGE_HOST,
  fallbackModels: MODELS,
} as const;

/** 产品类型。 */
export type ZCodeBridgeProduct = typeof ZCODE_BRIDGE;
