# dsh-zcode-bridge

把 **ZCode 开源版实例内部的免费额度通道**（`account:bigmodel-start-plan` + 阿里云 captcha）
接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），
作为一个普通模型 provider 使用。

```
DSH ──▶ 本插件 ──▶ 本机 HTTP 桥 ──▶ ZCode 实例的 session 链路 ──▶ zcode.z.ai
         (provider)      (loopback)      (createTask/sendPrompt)     (免费额度)
```

## 为什么必须经过 ZCode 实例

免费额度通道**强制要求阿里云 captcha**，而 captcha 只能在真实 Electron renderer 里运行
（需要 DOM + `o.alicdn.com` 的 CDN 脚本）。且 3012 风控的判据是**调用路径** ——
只有实例内部的 session 链路（`createTask` + `sendPrompt`）能通过，裸 HTTP 调用一律 405/3012。

⇒ **使用本插件的前提：本机已安装并运行 ZCode 开源版实例，且以 `ZCODE_BRIDGE=1` 启动。**

## 使用

### 1. 启动 ZCode 壳（带桥）

```powershell
$env:ZCODE_BRIDGE = '1'
# 其余按你的 ZCode 启动方式
```

桥就绪后会把端口与 token 写到 `<dataBaseDir>/.zcode/v2/bridge-port.json`。

### 2. 安装插件

```sh
dsh plugin --profile <name> add ./dsh-zcode-bridge-0.1.2.tgz
```

或手动在 profile 的 `package.json` 里加依赖，并把它加进 `dsh.profile.bundles`。

### 3. 在模型设置页启用

设置 → 模型 → `ZCode Bridge (GLM free)`，展开后有 GLM-5.3 / GLM-5.3-Flash 的开关。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `disabledModels` | `{}` | 逐模型可见性开关。形状 `{ "zcode-bridge": { "GLM-5.3": true } }`。由设置页写入，一般不用手改。 |

> ⚠ 这个 `Config` **必须带 `.volatile()` 标记**，否则 DSH 的模型设置页
> 根本不会渲染这个 provider。原因见 `src/index.ts` 中 `Config` 的注释。

## 环境变量

| 变量 | 作用 |
|---|---|
| `ZCODE_DATA_BASE_DIR` | ZCode 数据根目录（桥发现文件所在地）。缺省按候选目录探测。 |
| `ZCODE_BRIDGE_BASE_URL` + `ZCODE_BRIDGE_TOKEN` | 显式指定桥地址，跳过发现文件。 |
| `ZCODE_BRIDGE_ELECTRON_PATH` / `ZCODE_BRIDGE_APP_DIR` | 插件自动拉起壳时用的可执行文件与 app 目录。 |
| `ZCODE_BRIDGE_AUTOSTART` | 设 `0` 关闭自启（默认开）。 |

## 已知限制

- **不支持工具调用** —— 桥的端点收 `content: string`，没有 `tools` 通道
  （`sendPrompt` 只接受 `toolDenylist`，无 allowlist）。历史工具往返会**降级为文本**传给模型，
  但模型无法真正发起工具调用。详见 `src/adapter.ts` 的 `toBridgeMessages`。
- **不上报 usage** —— 桥返回的 usage 恒为 0（它拿不到真实用量），
  上报 0 会让用量统计显示成"没消耗"，比不报更误导。
- **图片不支持** —— provider 目录只声明 `text`。

## 开发

```sh
pnpm install
pnpm run build     # tsc + 客户端 bundle
pnpm run typecheck
```

`pnpm run build` 做两件事：

1. `tsc -p tsconfig.json` —— 编译宿主侧（`lib/*.js`）
2. `node scripts/bundle-client.mjs` —— 把 `src/client/` 打包成**自注册 bundle**（`lib/client.js`）

### ⚠ 客户端必须打包（不是可选步骤）

DSH 的 web 前端**不用原生 ESM 加载插件客户端**。宿主加载完文件后会检查有没有注册过：

```js
if (this.factories.has(id)) return "registered";
failures.push(`${url}: loaded without registering "${id}" via __ModuleLoader__.load`);
```

没注册 → 该 entry 拿不到 fiber → 控制台只显示 `import failed`。

⇒ 客户端产物首行必须是 `window.__ModuleLoader__.load({ id: "...", factory: (require) => {`，
不能是裸 ESM。`scripts/bundle-client.mjs` 负责这个转换，并带自检
（出现外部 `import` 或 `export {}` 直接报错退出，不产半成品）。

## License

MIT
