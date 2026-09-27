# ZCode captcha 逆向调查报告

**日期**：2026-09-27
**调查者**：逆向工程子代理
**约束遵守**：全程只读 `E:\zcoed\ZCode`（仅 FileStream / openSync 读），未写入任何文件；产物全部落在 `D:\zcode-glm5.3f\_reverse\`。

---

## 0. 对前一子代理结论的修正（重要）

| 项 | 前一个子代理的说法 | 实测结果 |
|---|---|---|
| captcha 段偏移 | 「317,226,309 – 317,240,000，13.7 KB」 | **绝对偏移 317,226,309 落在 `folder-zed.svg` 里，是错的**。真实位置见 §1 |
| 段的宿主文件 | 未指明 | **`out/renderer/assets/styles-DEELZGp2.js`**（唯一命中） |
| 段长 | 13.7 KB | **20,425 字节**（byte 4,261,166 – 4,281,591） |
| 9 个 `cloudauth-device-*` 域名 | 暗示是设备指纹采集目标 | 域名清单**属实**，但它们**不是项目代码发起的**，见 §4 |

前一子代理的 `317,226,309` 之所以接近真值，是因为它可能在做**字符索引 ↔ 字节索引**混用。本文件的字符长度是 5,983,713，字节长度 6,097,444 —— 两者差 113,731，正好把偏移推到相邻区间。

---

## 1. 定位与提取（已交付）

### 1.1 asar 结构实测

```
[0..3]   4,0,0,0                     ← 4 字节 pickle（无实际内容）
[4..7]   232,40,108,0 = 7,088,360    ← headerSize (uint32 LE)
[8 .. ]  JSON 头 7,088,360 字节
数据区起点 dataOffset = 8 + 7,088,360 = 7,088,368
文件总大小 326,915,059
```

**关键**：JSON 头**不是**从第 8 字节开始 —— 前面还有 4 字节 pickle 尾巴，所以 `text.indexOf('{"files"')` 才能正确解析。直接 `JSON.parse(header)` 会报 `0xEF` / 无效起始值。

文件总数 **27,068**。**79 个重名 `index.js` 确认存在**，必须用 offset 定位，本报告全程如此。

### 1.2 captcha 段准确边界

宿主文件条目（asar 索引原文）：

```json
{"path":"out/renderer/assets/styles-DEELZGp2.js","offset":305881182,"size":6097444,"unpacked":false}
```

绝对偏移 = `7088368 + 305881182` = **312,969,550**。
段内 needle 全部落在 byte 4,261,183 – 4,277,539（该文件内偏移），即绝对 317,230,733 – 317,247,089 —— **这解释了前一子代理的 317,2xx 数字来源**（它拿到的是绝对坐标量级，但起点取错了宿主）。

**段边界（该文件内字节偏移）**：

| 边界 | 偏移 | 原文首字符 |
|---|---|---|
| **起点** | **4,261,166** | `var ztn=...`（`v` 处；前一个字符是 4,261,165 的 `}`） |
| **终点（不含）** | **4,281,591** | `";function Inn("` —— `Inn` 是下一个不相关函数 |

**段长 = 20,425 字节**，已原样导出到：

```
D:\zcode-glm5.3f\_reverse\captcha-section.js
```

导出验证（首尾原文）：

- 头：``var ztn=`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`,W4=1e4,Btn=2e3,Vtn=8e3,Htn=12e4,G4=class `` …
- 尾：… `let r=lnn({providerId:e.providerId,captchaVerifyParam:n,captchaRegion:t.region});return Dnn(e.providerId),{captchaVerifyParam:n,headers:r}}var m3=new Map`

边界判据（`verify.mjs` 实测）：段内 **48 个顶层 `function` + 33 个顶层 `var/let/const`**，全部连续；前后邻居分别是 `U4`（4,260,959，仍在段外）与 `Inn`（4,281,591，段外）。

**导出完整性校验**（`verify.mjs`，可复跑）：

```
asar 宿主体内偏移 : 4261166 .. 4281591 (len 20425)
asar 绝对偏移     : 317230716 .. 317251141
fresh 长度 20425 / saved 长度 20425 / 逐字节一致: true
前 40 字节（段外）: "dEventListener(`abort`,a,{once:!0})}):e}"
段首 40 字节      : "var ztn=`https://o.alicdn.com/captcha-fr"
段尾 40 字节      : "aVerifyParam:n,headers:r}}var m3=new Map"
后 40 字节（段外）: ";function Inn(e){return[e.workspace.work"
含 "import " : false   含 "require(" : false   含 ESM from 语法 : false
sha256           : 018612b9aebc33f071f519a5943293705e445f1374b50b3743db90d241441778
```

**勘误**：上文 §1.2 里「绝对 317,230,733」是**首个 needle** 的绝对位置；段的**真实绝对起止**是 **317,230,716 .. 317,251,141**。

### 1.3 段内函数清单（64 个顶层声明，全部为 ESM 模块级 `function`/`var`）

**核心链路**：

| minify 名 | 作用 | 段内偏移 |
|---|---|---|
| `ztn` | AliyunCaptcha.js CDN URL 常量 | 0 |
| `W4`=1e4 / `Btn`=2e3 / `Vtn`=8e3 / `Htn`=12e4 | 各种超时常量 | 0 |
| `G4` | `CaptchaInteractiveRequiredError` 类 | ~100 |
| `Rtn` | **诊断器工厂**（产出 `{id,event,stage,callback,snapshot,end}`）→ 注意在段**外** 4,260,222 | — |
| `U4` | `signal` 可中断的 Promise 包装 → 段**外** 4,260,959 | — |
| `nnn` | **SDK 初始化**（`window.initAliyunCaptcha`） | 427,1828 |
| `enn` | **加载 CDN script** 标签 | 427,0358 |
| `onn` | **控制器**（无感/交互主流程） | 427,4336 |
| `rnn` / `inn` | 实例等待 / 触发延迟 | 427,3608 / 427,4019 |
| `ann` | **prewarm** | 427,4156 |
| `tnn` | SDK fail 分支处理 | 427,1006 |
| `c3` / `s3` / `o3` | 拒绝/清理/ARMS 事件 | 427,0962 起 |
| `bnn` | **启用判定** `access.type==='zhipu-account' && access.mode==='start-plan'` | 427,8815 |
| `Fnn` | **产出材料**（对外主入口） | 428,1084 |
| `lnn` | **组头** `{[snn]:param, [cnn]:region}` | 427,7570 |
| `snn` / `cnn` | `X-Aliyun-Captcha-Verify-Param` / `-Region` | 427,7493 |
| `unn` / `dnn` / `pnn` / `mnn` | ARMS 埋点（`aliyun_captcha_verification` / `captcha`） | 427,7669 起 |
| `jnn` / `Mnn` | **队列串行化** / 无感验证入口 | 427,9903 / 428,0137 |
| `Nnn` / `Pnn` | prewarm 触发 / certifyId 重复检测 | 428,0698 / 428,0784 |
| `f3` / `p3` / `Onn` / `knn` / `Ann` | 配置获取(60s 缓存) / 配置校验 / 组装 / 语言探测 | 427,9174 起 |
| `Enn` / `Dnn` / `Snn` / `Cnn` / `wnn` | 材料缓存 / Map / Promise 队列尾 | — |
| `Xtn` | React 组件（3 个隐藏 DOM 节点） | 426,3683 |
| `Ytn` / `Q4` / `$4` | DOM id 常量 | 426,3576 / 426,3585 / 426,3621 |
| `a3` | 内嵌 base64 PNG（captchaLogoImg 默认值） | 426,4095 |

**重要**：段内 **没有 `import` / `require`**。它是 Rollup 产出的 ESM 模块体被拼进大 bundle，无模块边界标记。

---

## 2. 完整依赖树

### 2.1 浏览器专有（硬依赖）

| 符号 | 次数 | 出现点 |
|---|---|---|
| `window` | 14 | `window.initAliyunCaptcha`、`window.AliyunCaptchaConfig`、`window.clearTimeout`、`window.setTimeout` |
| `document` | 12 | `document.createElement('script')`、`document.head.appendChild`、`document.querySelector('script[src=...]')` |
| `localStorage` | 3 | `Ann()` 读 `zcode-locale-preference` |
| `navigator` | 2 | `knn()` —— `navigator.language.toLowerCase().startsWith('zh')` |
| `HTMLElement` / `HTMLButtonElement` | 各 2 | `$tn()` 的按钮元素类型检查 |
| `URL` | 1 | `new URL('data:image/png;base64,...')`（SDK 配置里的 logo） |

**环境守卫（原文）**：

```js
async function onn(e,t={}){if(typeof window>`u`||typeof document>`u`)throw Error(`Captcha requires browser environment.`); ...
async function ann(e){if(typeof window>`u`||typeof document>`u`)return; ...
```

### 2.2 项目内部（段外，需继续追）

| 符号 | 定义位置（同文件字节偏移） | 说明 |
|---|---|---|
| `U4` | **4,260,959**（紧邻段前） | `signal` 可中断 Promise 包装，30 行，**无浏览器依赖，可直接搬** |
| `Rtn` | **4,260,222**（紧邻段前） | 诊断器工厂，依赖 `globalThis.crypto.randomUUID` + `J.lifecycle.info` |
| `J` | logger 门面 | **需继续追**（bundle 全局） |
| `$` | byte 94,327 | React JSX runtime（`jsxs` / `jsx`），**仅 `Xtn` 组件用** |
| `yo` | 未定位到顶层声明 | `vnn()` 用，疑似 `custom:` / `ghost:` provider key 解析 |
| `M4` | byte 4,230,502 | `ynn()` 用，解析 `ghost:` / `custom:` supplier key |

**关键**：captcha 段的核心产出路径（`Fnn` → `Mnn` → `onn` → `nnn`）**不用 React**。`$` 只出现在 `Xtn`（那个隐藏 DOM 的 React 组件）里。**去掉 `Xtn` 不影响材料产出**。

### 2.3 npm 包

**无。** 段内不直接 import 任何 npm 包。依赖的 `J`（logger）是项目内部设施。

---

## 3. 「无感验证」最小依赖闭包 —— 核心问题

### 3.1 `instance` 从哪来（原文，byte 4,272,044 附近）

```js
i({SceneId:e.sceneId,mode:e.mode??`popup`,language:e.language,captchaLogoImg:e.captchaLogoImg??a3,
   showErrorTip:!1,element:`#${Q4}`,button:o,
   getInstance:e=>{ ...
     J.info(`[captcha] aliyun sdk instance ready`,{
       configKey:r,
       hasShow:typeof e.show==`function`,
       hasStartTracelessVerification:typeof e.startTracelessVerification==`function`}),
     s(e)      // ← 兑现 instancePromise
   },
   success:..., fail:..., onError:...})
```

`i` = `window.initAliyunCaptcha`（`nnn` 里 `let i=window.initAliyunCaptcha`，非 function 就抛 `Captcha SDK is unavailable.`）。

`instance` 由 **CDN 上的 AliyunCaptcha.js 回调给出**，不是项目代码构造的。

### 3.2 `startTracelessVerification` 的真实来源 —— **决定性发现**

我把 SDK 本体拉下来了：

```
GET https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
→ 200, 224,977 bytes, 222,296 chars
已存 D:\zcode-glm5.3f\_reverse\AliyunCaptcha.remote.js
```

对这份 **224KB 的 SDK 本体**做关键词计数：

| 关键词 | 出现次数 |
|---|---|
| `startTracelessVerification` | **0** |
| `traceless`（小写） | **0** |
| `Traceless`（仅出现在大写常量 `TRACELESS`） | 3 |
| `WebGL` | 0 |
| `canvas` | 0 |
| `navigator` | 1 |

**结论**：`startTracelessVerification` **不在 SDK 本体里**。

那它在哪？在 **SDK 二次远程加载的「动态 JS」** 里。证据链（SDK 本体 byte 218,620 附近原文）：

```js
var p=Date.now();
Le("js",i,o,u.CaptchaJsPath,null,function(t){ ... 
    t?(xe("js",{t:e,s:!1,msg:Tn.DYNAMICJS_FAIL,...}),Kr(),fn.call(r,{code:Tn.DYNAMICJS_FAIL,msg:"动态JS加载失败"}), ...)
    :(r._extend({dynamicJSLoaded:!0}), ... )},5e3),
Le("css",i,o,u.CaptchaCssPath,null,function(t){t&&pe("networkError")},3e3)
```

以及 `Bn`（`initAliyunCaptcha` 内核）里的关键分支：

```js
function a(){var e=window.AliyunCaptcha.prototype; e.config=r; e.deviceConfig=ne;
            n&&"function"==typeof n&&n(u);           // ← 调用项目侧的 getInstance 回调
            t(u); var i=new window.AliyunCaptcha; r.getInstance&&r.getInstance(i)}
```

`CaptchaJsPath` 来自**服务端 init 响应的字段**（`CaptionJsPath` 的命名变体），即：

```
服务端 init API  →  返回 CaptchaJsPath  →  二次加载动态 JS  →  该 JS 才给原型挂 startTracelessVerification
```

而 `window.AliyunCaptcha.prototype` 的**唯一 `prototype.xxx=` 赋值**在 SDK 本体里只有 `.constructor`（@79,270）和 `.format`（@147,185）—— **没有 `startTracelessVerification`**。这印证了它是动态 JS 在运行时挂上去的。

### 3.3 能否在纯 Node 里构造 `instance`？

**不能。** 最小闭包至少需要：

1. `window.initAliyunCaptcha`（SDK 本体已加载后才有）
2. SDK 本体加载时立刻触碰 `document`（原文第一行）：
   ```js
   !function(){var t={1252:function(){!function(){if("undefined"!=typeof document)try{
       var t='@font-face {font-family: "aliyun-captcha-iconfont";src: url("data:application/font-woff2;base64,...'
   ```
   这个 `typeof document` 守卫可以让它在 Node 里"不炸"，但**只能不炸，不能工作**。
3. `document.head.appendChild` 加载动态 JS（`Le("js",...)` 走的是 DOM script 注入）
4. 动态 JS 的 URL 由**服务端 init 响应**给出，客户端预置不了

**shim 清单（即使全部 shim 也过不了第 4 条）**：`window` / `document`（含 createElement/head/querySelector） / `navigator.language` / `localStorage` / `HTMLElement` / `HTMLButtonElement` / 按钮元素的真实 `click()` 行为。

---

## 4. 设备指纹网络请求的真实归属 —— **推翻「项目代码发请求」的假设**

### 4.1 9 个域名清单（原文，`out/main/index.js` byte 1954）

```js
cI=new Set(["cloudauth-device-pre.aliyuncs.com",
            "cloudauth-device-pre.ap-southeast-1.aliyuncs.com",
            "cloudauth-device-dualstack.cn-shanghai.aliyuncs.com",
            "cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com",
            "cn-shanghai.device.saf.aliyuncs.com",
            "ap-southeast-1.device.saf.aliyuncs.com",
            "ap-southeast-1-ga.device.saf.aliyuncs.com",
            "pre-cn-shanghai.device.saf.aliyuncs.com",
            "pre-ap-southeast-1.device.saf.aliyuncs.com"])
```

### 4.2 它们的用途：**只是日志分类器**

`out/main/index.js` 里这 9 个域名的**全部 4 次出现**都在同一个函数里：

```js
function mf(e,t){                       // installCaptchaNetworkDiagnostics
  var r=new Map, o=s(i=>{ ... "prune" });
  e.onBeforeRequest(Ic,(i,a)=>{ a({}); var c=pf(i.url); if(!c)return;
      t.info("[captcha-network]",{event:"resource.start",networkRequestId:i.id,webContentsId:i.webContentsId,...c}) });
  var n=s(i=>{ ... t.info("[captcha-network]",{event:i.error?"resource.failed":"resource.completed",...}) },"finish");
  e.onCompleted(Ic,n); e.onErrorOccurred(Ic,n)
}
s(mf,"installCaptchaNetworkDiagnostics");
```

`pf(e)` 只做一件事：**把 URL 归类成枚举**。

```js
if(cI.has(r))return{kind:"device_api",host:r,path:"/"};
if(/^(?:[a-z0-9-]+\.)?captcha-(?:pro-)?open(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(r))
    return{kind:r.startsWith("upload.")?"sdk_log":"init_api", ...};
if(/^static-captcha(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(r))return{kind:"image",...};
if(["o.alicdn.com","g.alicdn.com","x.alicdn.com"].includes(r)&&t.pathname.startsWith("/captcha-frontend/"))
    return{kind:o, ...};   // sdk_script / dynamic_js / dynamic_css / device_script
```

**⇒ 这些请求由 SDK 在 renderer 里发起，主进程只是用 `onBeforeRequest`/`onCompleted` 打标签。项目代码从不主动请求这些域名。**

### 4.3 设备指纹的真实产生路径（SDK 本体 byte 192,605 与 221,523 原文）

```
init API 响应
  → m.DeviceConfig
  → Br._extend({DeviceConfig: m.DeviceConfig})
  → rn(m.DeviceConfig, y, u, "captcha")        // rn = 设备指纹上报
  → deviceCallback(t, e)                       // t === "success" 时 e.DeviceToken
  → re._extend({DeviceToken: e.DeviceToken})
  → 后续请求携带 DeviceToken
```

`deviceConfig` 的内容（SDK 本体 byte 221,523 原文）：

```js
y={deviceConfig:{sceneId:c, appName:Ft.appName[o], appKey:h, endpoints:d, dev:f},
   deviceCallback:function(t,e){
     "success"===t ? re._extend({DeviceToken:e.DeviceToken})
                   : re._extend({err:{code:Tn.DEVICE_INIT_FAIL,msg:"设备指纹初始化/动态JS加载失败"}})}}
```

其中 `h = Ft.appKey[o][p]`，dev 分支的硬编码值原文可见：`"sh3c47a8ddhs03057ef9e8a295bc895c"`（**注意：这是 `isDev` 分支的 appKey，生产 key 在 `Ft.appKey` 表里，SDK 已被混淆，本次未解出**）。

`endpoints` 由 `be(r.secEndpointType, o, p)` 产出，或 dev 时硬编码那 9 个域名之一组。

### 4.4 能否在 Node 里直接复刻这些请求？

**不能。** 三条硬阻塞：

1. **`DeviceToken` 由 SDK 内部生成**，生成时依赖浏览器环境指纹（`fn.call(r,{code,msg})` 的 fallback 路径说明它需要真实 DOM）。SDK 本体里 `canvas`=0 / `WebGL`=0，说明采集逻辑**同样在动态 JS 里**，不在已下载的 224KB 内。
2. **`appKey` 表已被混淆**（`Ft.appKey[o][p]`），且 init API 返回的 `DeviceConfig` 决定端点 —— 客户端无法独立构造。
3. **`isFromTraceless` 分支**（SDK byte 192,599 / 192,936 / 201,457）表明：当 `isFromTraceless` 为真时 `e.DeviceData = g`（设备数据）这一行**被跳过**：
   ```js
   r.isFromTraceless||void 0!==Br.DeviceConfig||(e.DeviceData=g)
   ```
   无感路径下 `isFromTraceless:true`，设备数据靠 `DeviceConfig` 回填，而不是本地采集 —— 这条路径**更不可能脱离浏览器复刻**。

---

## 5. 可行性判定

### 5.1 结论

**不能提取出一个纯 Node 可跑的 captcha 产出器。** 不是"工作量大"，而是**有一条硬阻塞**。

### 5.2 最关键的那一条阻塞（具体到代码行）

**阻塞点 = 真实产出的 captcha param 由 `window.initAliyunCaptcha` 的 `success` 回调给出，而该回调必须由运行时的动态 JS 触发；动态 JS 的 URL 来自服务端 init 响应，且它才负责把 `startTracelessVerification` 挂到 `window.AliyunCaptcha.prototype` 上。**

三处代码证据：

**① 材料出口在 SDK 回调里**（captcha 段 byte 4,272,044 附近原文）：

```js
success:e=>{if(t.callback(`success`,u(),t3?.diagnostics.id),!u())return;
   o3(`sdk.success`,{paramLength:e.length}),J.info(`[captcha] aliyun sdk success`,{paramLength:e.length});
   let n=n3;n3=null,n&&n.resolve(e)          // ← e 就是最终的 captchaVerifyParam
}
```

`e` 是 SDK 传进来的字符串，Vue 侧**只是接收**，不生成。

**② `startTracelessVerification` 只调用、不定义**（captcha 段 `onn` 原文）：

```js
if(!i&&typeof e.startTracelessVerification==`function`){
  J.info(`[captcha] aliyun start traceless verification`,{attemptKind:f}),
  e.startTracelessVerification(),           // ← e 是 getInstance 给的，方法由 SDK 挂载
  r&&(u=window.setTimeout(()=>{ ... d(new G4(`Traceless captcha did not respond after ${Vtn}ms.`))},Vtn));
  return}
```

注意 `typeof ... == 'function'` 这个**存在性检查** —— 项目代码自己也知道它**可能不存在**，因为它取决于 SDK 运行时状态。

**③ SDK 本体里根本没有这个符号**：224,977 字节的 `AliyunCaptcha.js` 里 `startTracelessVerification` 计数 **0**，`traceless`（小写）计数 **0**；`window.AliyunCaptcha.prototype` 上只有 `.constructor` 和 `.format` 两处赋值。

**⇒ 要产出材料，必须有：(a) 真实 DOM（供动态 JS 注入与指纹采集）+ (b) SDK 与该场景 sceneId 匹配的服务端 init 响应（给出 CaptchaJsPath）。两者都在浏览器/上游侧，Node 里无法伪造。**

### 5.3 如果强行要在 Node 里做，需要 shim 的清单与工作量

**shim 清单（按必要性排序）**：

| # | 需 shim | 用途 | 工作量 |
|---|---|---|---|
| 1 | `window` + `window.initAliyunCaptcha` 挂载点 | SDK 入口 | 0.5 天（能挂，但不能工作） |
| 2 | `document.createElement/head.appendChild/querySelector` | `enn()` 注入 script；SDK 内部加载动态 JS/CSS | 1 天 |
| 3 | `HTMLElement` / `HTMLButtonElement` + 真实 `click()` | `$tn()` 找按钮、`p.buttonElement.click()` | 1 天 |
| 4 | `navigator.language` / `localStorage` | `knn()` / `Ann()` | 0.2 天 |
| 5 | `URL` + base64 PNG 解码 | `a3` logo | 0.2 天 |
| 6 | **真实布局引擎 + 指纹可采集的 DOM** | 动态 JS 依赖 | **不可估** |
| 7 | **服务端 init 响应（CaptchaJsPath）** | 拿动态 JS | **不可伪造** |
| 8 | **`appKey` 表 / `Ft.appName`** | 设备指纹上报 | **被混淆，未解出** |

**总计**：前 5 项约 3 天可完成，但**完成之后仍会在第 7 项失败** —— 这是阻塞的本质：它不是一个"缺 shim"的问题，而是一个"缺服务端协作者"的问题。

### 5.4 唯一可行的替代路径（已由前序工作验证）

调用链必须留在真实 renderer 里。前序工作已实测打通（见 `AGENTS.md` 的 captcha mint 章节）：

- renderer 侧的 captcha 事件面**确实在正常产出真实材料**（旁路观察者每次都能拿到 280 字符 param + region）
- mint 的正确做法是**让桥与会话链路共用同一个 `workspacePath`**，把材料从 renderer 透传出来，而不是在 Node 里重造

**captcha 段里那个 `lnn`（组头）是纯函数，可以单独搬走**：

```js
function lnn(e){let t=e.captchaRegion?.trim();
  return{[snn]:e.captchaVerifyParam,...t?{[cnn]:t}:{}}}
```

只要拿到 `captchaVerifyParam` + `region`，组头这一步在 Node 里零成本。

---

## 6. 产物清单

| 文件 | 内容 | 大小 |
|---|---|---|
| `captcha-section.js` | **captcha 段原文**（byte 4,261,166–4,281,591） | 20,425 B |
| `captcha-section.pretty.js` | 轻度格式化版（80 行） | — |
| `captcha-section.nostr.js` | 字符串剥离版（供静态分析） | 12,173 B |
| `AliyunCaptcha.remote.js` | **CDN 上的 SDK 本体**（远程拉取） | 224,977 B |
| `out-main-index.js` | 主进程 bundle（含 `installCaptchaNetworkDiagnostics`） | 735,396 B |
| `renderer-assets-styles-DEELZGp2.js` | captcha 段宿主文件 | 6,097,444 B |
| `asar-header.json` | asar JSON 头（7,088,360 B） | — |
| `needle-positions.json` | 各关键词字节位置 | — |
| `lib/asar.mjs` | 只读 asar 访问层（分块读，不整份入内存） | — |
| `step1..step18-*.mjs` | 全部调查脚本（可复跑） | — |

**未解出项（明说未做到）**：
1. `Ft.appKey` 生产环境密钥表 —— SDK 已混淆，未还原
2. 动态 JS 的实际内容 —— 需先从服务端 init API 拿到 `CaptchaJsPath` 才能下载
3. `yo` 符号的顶层声明位置 —— 静态扫描未命中（可能在其他 chunk）

---

## 7. 一句话回答核心问题

**不能。** captcha 段（20,425 B，位于 `out/renderer/assets/styles-DEELZGp2.js` 的 byte 4,261,166–4,281,591）在 Node 里**可以加载、可以解析、`lnn` 可以单独用**，但它本身只是一个**SDK 驱动器**：真正的 captcha param 由 CDN 上的 `AliyunCaptcha.js`（224,977 B）二次加载的动态 JS 通过 `success` 回调交付，而那个动态 JS 的 URL 由**服务端 init 响应**给出。**缺的是服务端协作者，不是 shim。**
