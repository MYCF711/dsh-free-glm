/**
 * 桥发现 —— 解析出可用的 `{ baseUrl, token }`。
 *
 * 两级来源（与 Jet Hub 其它 provider 的 `resolveBaseUrl` 同风格）：
 *   1. 环境变量 `ZCODE_BRIDGE_BASE_URL` + `ZCODE_BRIDGE_TOKEN`（显式覆盖）
 *   2. 发现文件 `<dataBaseDir>/.zcode/v2/bridge-port.json`（读端口 + token）
 *
 * ⚠ 这里**不缓存**。桥每次启动端口都会变（`port: 0` 随机分配），
 * 而插件在 DSH 进程里常驻 —— 缓存会让 ZCode 重启后插件一直打旧端口。
 * 发现文件读取是极廉价的操作（一个几 KB 的 JSON），每次请求读一次可接受；
 * 真正的开销在桥那边的模型调用（数秒级）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  BASE_URL_ENV,
  BRIDGE_PORT_FILE_RELATIVE,
  BRIDGE_PORT_SCHEMA_VERSION,
  DATA_BASE_DIR_ENV,
  TOKEN_ENV,
  type ZCodeBridgeEndpoint,
  type ZCodeBridgePortFile,
} from "./product.js";

/**
 * ZCode 数据根目录的已知候选位置。
 *
 * ## 为什么需要候选表（实测踩过的坑）
 *
 * 单靠 `ZCODE_DATA_BASE_DIR` 环境变量是**不可靠**的：
 *
 * DSH 由 `dsh-launcher.exe` 这个**长驻进程**拉起，而 Windows 进程的环境块
 * 在进程创建时就固定了。launcher 可能是几天前启动的 —— 它继承的是
 * **当时**的环境变量。我们后来用 `SetEnvironmentVariable(..., 'User')`
 * 写入的新值，launcher 看不到，于是它拉起的 DSH 也看不到。
 *
 * 实测后果：桥明明健康地跑着（`/health` 返回 ok），插件却去 `homedir()`
 * 底下找发现文件、找不到，报 `MISSING_CREDENTIAL`
 * 「找不到 ZCode 桥……缺省 dataBaseDir 为家目录」。
 *
 * ⇒ 环境变量只作为**首选**，缺失时按候选表探测，取第一个**真的存在
 *   发现文件**的目录。这样不依赖任何进程的环境块是否新鲜。
 */
const DATA_DIR_CANDIDATES = [
  "D:\\zcode-glm5.3f\\_oss_data",
] as const;

/**
 * 解析 ZCode 数据根目录。
 *
 * 解析顺序：
 *   1. 显式 `ZCODE_DATA_BASE_DIR` 环境变量
 *   2. 已知候选目录中**发现文件真的存在**的那个（最可靠：直接看结果）
 *   3. `homedir()`（ZCode 的默认数据根，其下有 `.zcode`）
 *
 * 注意：这里返回的是**数据根**（其下有 `.zcode` 子目录），不是 `.zcode` 本身。
 */
export function resolveDataBaseDir(): string {
  const fromEnv = process.env[DATA_BASE_DIR_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  // 候选表里挑第一个真的有发现文件的 —— 比"猜一个路径"可靠得多。
  for (const candidate of DATA_DIR_CANDIDATES) {
    try {
      if (existsSync(join(candidate, BRIDGE_PORT_FILE_RELATIVE))) {
        return candidate;
      }
    } catch {
      // 权限/路径异常一律视为该候选不可用，继续试下一个。
    }
  }

  return homedir();
}

/**
 * 发现文件的绝对路径。
 *
 * 取**第一个真的存在发现文件**的候选目录；都不存在时退回首选目录的路径
 * （语义上表示"桥没有把文件写在那里"）。
 *
 * 这里不能简单地用 `resolveDataBaseDir()` —— 那个函数只做环境变量与候选
 * 推断，不保证文件真的在。写路径的调用方（保活）需要知道**实际的文件位置**。
 */
export function resolveBridgePortFilePath(): string {
  const dirs = candidateDataDirs();
  for (const dir of dirs) {
    const path = join(dir, BRIDGE_PORT_FILE_RELATIVE);
    try {
      if (existsSync(path)) {
        return path;
      }
    } catch {
      // 继续试下一个。
    }
  }
  return join(dirs[0] ?? homedir(), BRIDGE_PORT_FILE_RELATIVE);
}

/** 去掉尾部斜杠（`http://x:1/` → `http://x:1`）。 */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * 读发现文件。
 *
 * 任何异常（不存在、JSON 坏、schema 版本不符、字段缺失）一律返回 undefined ——
 * 调用方据此报"桥未运行"，**不要**让它把异常抛到请求路径上（那会变成
 * 难以理解的 provider 报错）。
 */
export function readBridgePortFile(
  filePath = resolveBridgePortFilePath(),
): ZCodeBridgePortFile | undefined {
  try {
    if (!existsSync(filePath)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ZCodeBridgePortFile>;
    if (
      parsed.schemaVersion !== BRIDGE_PORT_SCHEMA_VERSION ||
      typeof parsed.port !== "number" ||
      !Number.isFinite(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0
    ) {
      return undefined;
    }
    return {
      schemaVersion: parsed.schemaVersion,
      service: typeof parsed.service === "string" ? parsed.service : "",
      transport: typeof parsed.transport === "string" ? parsed.transport : "",
      host:
        typeof parsed.host === "string" && parsed.host.length > 0 ? parsed.host : "127.0.0.1",
      port: parsed.port,
      token: parsed.token,
      models: Array.isArray(parsed.models) ? parsed.models.filter((m) => typeof m === "string") : [],
      defaultProviderId: typeof parsed.defaultProviderId === "string" ? parsed.defaultProviderId : "",
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
      writtenAt: typeof parsed.writtenAt === "number" ? parsed.writtenAt : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * 解析出可用的桥端点。
 *
 * ## 查找顺序（多候选，不依赖单一环境变量的新鲜度）
 *
 *   1. `ZCODE_BRIDGE_BASE_URL` + `ZCODE_BRIDGE_TOKEN`（显式覆盖，最高优先）
 *   2. `resolveDataBaseDir()` 给出的目录（环境变量 → 有文件的候选 → homedir）
 *   3. 其余候选目录 —— **只要任何一个目录里有发现文件，就用它**
 *
 * 第 3 条是应对「launcher 环境块过期」的兜底：环境变量可能指错地方，
 * 但发现文件是**实际存在的事实**，以它为准。
 *
 * 返回 undefined 表示**桥不可用**（ZCode 实例没在跑，或没开 `ZCODE_BRIDGE=1`）。
 * 调用方必须区分"桥不可用"（隐藏 provider）与"请求失败"（报错）。
 */
export function resolveBridgeEndpoint(): ZCodeBridgeEndpoint | undefined {
  const envBase = process.env[BASE_URL_ENV]?.trim();
  const envToken = process.env[TOKEN_ENV]?.trim();
  if (envBase !== undefined && envBase.length > 0) {
    // 显式指定地址时必须同时给 token —— 桥对 /v1/* 强制 Bearer 校验，
    // 缺 token 会稳定 401。这里宁可返回 undefined 让 provider 隐藏，
    // 也不要让用户看到一串 401。
    if (envToken === undefined || envToken.length === 0) {
      return undefined;
    }
    return {
      baseUrl: stripTrailingSlash(envBase),
      token: envToken,
      source: "env",
      models: [],
    };
  }

  // 逐个候选目录试；已经按优先级排好序（首选目录在最前，不重复）。
  for (const dir of candidateDataDirs()) {
    const file = readBridgePortFile(join(dir, BRIDGE_PORT_FILE_RELATIVE));
    if (file === undefined) {
      continue;
    }
    return {
      baseUrl: `http://${file.host}:${file.port}`,
      token: file.token,
      source: "discovery-file",
      models: file.models,
    };
  }

  return undefined;
}

/**
 * 候选数据目录，按优先级去重排序。
 *
 * 首选 `resolveDataBaseDir()` 的结果，其后是已知候选表 —— 这样
 * 即使首选目录里没有发现文件，也不会漏掉实际存在的那个。
 */
function candidateDataDirs(): string[] {
  const ordered: string[] = [];
  const push = (dir: string | undefined): void => {
    if (dir === undefined || dir.length === 0) {
      return;
    }
    const normalized = dir.replace(/[\\/]+$/, "");
    if (!ordered.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
      ordered.push(normalized);
    }
  };

  push(resolveDataBaseDir());
  for (const candidate of DATA_DIR_CANDIDATES) {
    push(candidate);
  }
  push(homedir());

  return ordered;
}

/**
 * 探测桥是否真的活着（HTTP `/health`，**不需要 token**）。
 *
 * 光有发现文件不够 —— 实例可能已经崩了但文件还在。这个探测很轻
 * （本地 loopback，毫秒级），用于 `listModels` 的门控：桥不在就让
 * provider 整个隐藏，而不是给用户一个点不动的分组。
 */
export async function probeBridge(
  endpoint: ZCodeBridgeEndpoint,
  timeoutMs = 2_000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint.baseUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
