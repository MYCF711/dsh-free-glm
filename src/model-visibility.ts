/**
 * 模型可见性（拨动开关的存储与过滤）。
 *
 * ## 为什么自己实现
 *
 * DSH 核心**没有**「逐模型开关」机制 —— 官方模型设置页只提供
 * API key / baseURL / models[] 编辑器。Jet Hub 里的开关是它自己写的。
 * 所以这里复刻同一套做法。
 *
 * ## 存储
 *
 * 存在 settings 里，形状 `{ [provider]: { [modelId]: true } }`：
 *   - **关闭**写 `true`
 *   - **打开**删键（不写 `false`）
 *
 * 为什么打开要删键：保持黑名单里只留真正被关闭的模型，
 * `disabledFor()` 的语义因此始终是「键存在且为 true 即隐藏」，
 * 配置文件也不会随开关操作无限膨胀。
 *
 * ## 实时生效的原理
 *
 * **不需要任何事件广播。** `listModels()` 每次调用都实时读进程内副本
 * （`this.cache`），而对话框的模型选择器每次打开都会重新调
 * `llm.listModels()`。所以：写副本 → 下次选择器打开即生效。
 *
 * 唯一的硬约束：`listModels()` **不能缓存**过滤结果。
 */

/** 黑名单在 settings section 里的字段名。 */
const DISABLED_MODELS_KEY = "disabledModels";

/** 空集合常量 —— 避免每次分配。 */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** settings section 的最小接口（只用到 get / replace）。 */
export interface SettingsScope {
  get(): Record<string, unknown> | undefined;
  replace(value: Record<string, unknown>): Promise<void>;
}

/** 把任意值收敛为 `{ [provider]: { [modelId]: true } }`。 */
function sanitize(raw: unknown): Record<string, Record<string, true>> {
  const out: Record<string, Record<string, true>> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const per: Record<string, true> = {};
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      // 只认显式 true。历史配置里可能残留 false，那些等价于"打开"。
      if (flag === true) {
        per[modelId] = true;
      }
    }
    if (Object.keys(per).length > 0) {
      out[provider] = per;
    }
  }
  return out;
}

export class ModelVisibility {
  private cache: Record<string, Record<string, true>> = {};
  private loaded = false;

  constructor(private readonly scope: SettingsScope | undefined) {}

  /** 首次访问时从 settings 载入（懒加载，避免插件启动阶段碰 IO）。 */
  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    if (this.scope === undefined) {
      return;
    }
    try {
      this.cache = sanitize(this.scope.get()?.[DISABLED_MODELS_KEY]);
    } catch {
      // section 还没写过 → get() 可能返回 undefined 或抛。
      // 一律按"全部模型可见"处理，而不是让插件起不来。
      this.cache = {};
    }
  }

  /**
   * 某 provider 下被关闭的模型集合。
   *
   * **适配器的 `listModels()` 每次调用都要走这里** —— 这是"实时生效"的全部秘密。
   */
  disabledFor(provider: string): ReadonlySet<string> {
    this.ensureLoaded();
    const per = this.cache[provider];
    if (per === undefined) {
      return EMPTY_SET;
    }
    const ids = Object.keys(per).filter((id) => per[id] === true);
    return ids.length > 0 ? new Set(ids) : EMPTY_SET;
  }

  /**
   * 列出某 provider 的黑名单（供 UI 渲染开关）。
   *
   * 返回**全部键**（含显式 false 的），以便 UI 区分"从未设置过"
   * 与"曾被关闭又打开"—— 两者对用户都是"开"，但保留记录便于排查。
   */
  list(provider: string): Record<string, boolean> {
    this.ensureLoaded();
    return { ...(this.cache[provider] ?? {}) };
  }

  /**
   * 打开/关闭某个模型。
   *
   * 先更新进程内副本（让下一次 `listModels()` 立刻生效），再异步落盘。
   * 落盘失败不回滚内存 —— 用户的意图应当立即生效，持久化是次要的。
   */
  async set(provider: string, modelId: string, disabled: boolean): Promise<void> {
    this.ensureLoaded();
    const next = { ...this.cache };
    const per = { ...(next[provider] ?? {}) };
    if (disabled) {
      per[modelId] = true;
    } else {
      delete per[modelId];
    }
    if (Object.keys(per).length === 0) {
      delete next[provider];
    } else {
      next[provider] = per;
    }
    this.cache = next;
    this.loaded = true;

    if (this.scope === undefined) {
      return;
    }
    // ⚠ 必须 spread 保留 section 里的其它字段 —— `replace` 是整体替换，
    //   只写 disabledModels 会把同 section 的其它配置抹掉。
    const current = this.scope.get() ?? {};
    await this.scope.replace({ ...current, [DISABLED_MODELS_KEY]: next });
  }
}
