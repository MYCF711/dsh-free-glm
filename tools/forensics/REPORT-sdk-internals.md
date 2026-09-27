# SDK 本体深度逆向报告（补充）

**日期**：2026-09-27
**范围**：`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js` 本体的**内部结构**逆向
**约束**：全程只读；`E:\zcoed\ZCode` 未改动；产物落 `D:\zcode-glm5.3f\_reverse\`
**与 `REPORT.md` 的关系**：那份是 asar 提取报告（定位 ZCode 侧调用代码）。
**本文件是 SDK 本体报告**，两者互不重复，结论互相印证。

---

## 0. 结论

**不能在纯 Node 环境里产出「上游认可」的 captchaVerifyParam。**

三处硬依赖，且**只有一处可伪造**（见 §3）。Jet Hub 的 3012 被拒是路本身走不通，不是实现缺陷。

---

## 1. 本体事实（实测）

| 项 | 值 | 判据 |
|---|---|---|
| 大小 | **224,977 字节** / 222,296 字符 | `Get-Item` |
| 行数 | **1 行** | 完全 minify |
| 打包器 | webpack（含 core-js benchmark polyfill） | 模块头 `1252:function(){}` |
| 自报版本 | `VERSION:"1.3.4"`，`API_VERSION:"SUCCESS"+"15"` | 字符串表还原 |
| 混淆 | **两张字符串表** + 自定义 base64→percent 解码 + **控制流平坦化** | 见 §1.1 |

### 1.1 混淆结构（已完整破解）

```js
// 表 1 — Gt()，基址 314，288 条
function rt(t,e){ ... var i = r[e -= 314]; ... }

// 表 2 — je()，基址 498
function Ne(t,e){ ... var i = r[e -= 498]; ... }

// 解码器（表内字符串是自定义 base64，解码后再 percent-decode）
rt.ykcPvi = function(t){
  var e,r,n="",i="",o=0,c=0;
  while(r = t.charAt(c++)){
    ~(r = "abc...XYZ0123456789+/=".indexOf(r)) && (e = o%4 ? 64*e+r : r, o++%4)
      ? n += String.fromCharCode(255 & e >> (-2*o & 6)) : 0;
    r = "abc...XYZ0123456789+/=".indexOf(r);
  }
  for(var u=0;u<n.length;u++) i += "%" + ("00"+n.charCodeAt(u).toString(16)).slice(-2);
  return decodeURIComponent(i);
}
```

**已还原**：`_strtable_dump.txt`（288 条全量）、`AliyunCaptcha.destr.js`（表引用已内联）、
`AliyunCaptcha.flat.js`（相邻字符串常量已拼接）。

**控制流平坦化**示例（`Pe` 资源加载器）：

```js
Zt = Yt[Gt(x)][Gt(w)]("|"), Jt = 0;;
for(;;){ switch(Zt[Jt++]){ case "0": ... case "7": ... } break }
```

单个 `|` 分隔字符串重排全部语句顺序——静态阅读必须**手工还原执行序**，这是本 SDK 最主要的反分析手段。

---

## 2. 二次加载的资源（URL 模式）

| 资源 | 构造 | 关键点 |
|---|---|---|
| 动态 `captcha.js` | `u.CaptchaJsPath` | **服务端 INIT 响应下发** |
| 动态 `captcha.css` | `u.CaptchaCssPath` | 同上 |
| 设备指纹运行时 | `dynamicJsPath(version)` → `window.FEILIN.initFeiLin()` | 见 §3.2 |

加载代码（`In` → `Pr` 链路，原文）：

```js
var p = Date.now();
Le("js",  i, o, u.CaptchaJsPath,  null, function(t){ ... }, 5000),   // 5s 超时
Le("css", i, o, u.CaptchaCssPath, null, function(t){ ... }, 3000)    // 3s 超时
```

失败分支的报错文案（可用于线上诊断抓取）：

```
"动态JS加载失败"   → DYNAMICJS_FAIL
"设备指纹初始化/动态JS加载失败" → DEVICE_INIT_FAIL
```

CDN 主机（表内片段，**故意拆碎**）：

```
cdnServers    = ["Log32023-03-", "010831052023-03-"]
cdnDevServers = ["643f9139INIT"]
```

**探测**（带 `Referer: https://o.alicdn.com/` + 真实 UA + `Origin`）：

```
.../aliyunCaptcha/1.3.4/captcha.js    → 404
.../aliyunCaptcha/AliyunCaptcha.css   → 404
.../aliyunCaptcha/device.js           → 404
.../aliyunCaptcha/dynamic/1.3.4/...   → 404
```

⇒ **动态资源 URL 不可离线推导**，只由服务端下发。这是**第一处硬依赖**。

---

## 3. 三处硬依赖（核心）

### 3.1 `startTracelessVerification` 不在本体（0 次出现）

全文搜索计数（独立复核，与前序报告一致）：

| 关键词 | 次数 |
|---|---|
| `startTracelessVerification` | **0** |
| `traceless`（小写） | 0 |
| `TRACELESS`（大写常量） | 1（`CaptchaType` 判定用） |

本体里只有类型分支：

```js
var f = u.CaptchaType, l = !("TRACELESS"===f || "SLIDING"===f || "CHECK_BOX"===f);
l && B().all([He(u.PuzzleImage), He(u.Image)]).then(...)   // 只有非无感类型才预载图片
```

`window.AliyunCaptcha.prototype` 只在本体里被**赋值**（`.constructor` / `.format`），
真正的 `startTracelessVerification` **由动态 JS 运行期挂上**：

```js
function a(){
  var e = window.AliyunCaptcha.prototype;
  e.config = r; e.deviceConfig = ne;
  n && "function" === typeof n && n(u);       // ← 项目侧 getInstance 回调
  t(u);
  var i = new window.AliyunCaptcha;           // ← 构造函数此时才存在
  r.getInstance && r.getInstance(i)
}
```

### 3.2 `window.FEILIN` —— DeviceToken 的唯一来源

```js
Le("js", p, v, s(h.version), null, function (t, e) {
  if (t) { Br._extend({feilinLoad:!1}); r(kr.ACTION_STATE.FAIL, {DeviceToken:""}); pe("networkError") }
  else   { f.push("23-" + (Date.now()-l)); window.FEILIN && window.FEILIN.initFeiLin(Br, r) }
}, 5e3)
```

`FEILIN`（飞林）是阿里**独立的设备指纹采集运行时**，由动态 JS 装载。
本体只在 `deviceCallback` 里**接收结果**，不参与计算：

```js
deviceCallback: function (t, e) {
  "success" === t ? re._extend({ DeviceToken: e.DeviceToken })
                  : re._extend({ err:{ code: DEVICE_INIT_FAIL, msg: "设备指纹初始化/动态JS加载失败" } })
}
```

### 3.3 字体探测依赖真实布局引擎（**唯一可伪造的一处**）

本体里唯一的采集器 `fontsNum`（`Be()` 函数）：

```js
function Be(){ try{ return Ee(function(t,e){                 // Ee = 隐藏 iframe + onload 等待
    var r = e.document, n = r.body; n.style.fontSize = "48px";
    var i = r.createElement("div");
    i.style.setProperty("visibility","hidden","important");
    var a = function(t){                                     // 造探针 span
      var e = r.createElement("span"), n = e.style;
      n.position="absolute"; n.top="0"; n.left="0"; n.fontFamily=t;
      e.textContent = "mmMwWLliI0O&1"; i.appendChild(e); return e;
    };
    var s = ["monospace","sans-serif","serif"].map(a);       // 基线 3 种
    // 对 ~200 个候选字体，逐个测量同一文本的 offsetWidth / offsetHeight
    for (var l=0;l<De.length;l++){ o[De[l]] = s[l].offsetWidth; c[De[l]] = s[l].offsetHeight }
    var p = Ie.filter(function(t){
      return e = f[t], De.some(function(t,r){ return e[r].offsetWidth!==o[t] || e[r].offsetHeight!==c[t] })
    });
    return window._FN = p.length, p                            // 命中数量挂到 window._FN
  }) } catch(t){ return [] } }
```

**字体列表实测规模**：

- 基线：`["monospace","sans-serif","serif"]`
- 候选：**约 200 个**，含 `Arial` `Calibri` `Consolas` `Microsoft YaHei` `SimSun` `PingFang` `Meiryo` `Malgun Gothic` `Ubuntu` `Verdana` `Wingdings` …

**对 jsdom / happy-dom 的致命性**：

| 环境 | `span.offsetWidth` | `window._FN` |
|---|---|---|
| 真实浏览器 | 真实像素，因字体而异 | **100~200 的稳定整数** |
| jsdom / happy-dom | **恒为 0**（无布局引擎） | **恒为 0** |

`_FN = 0` 意味着「系统里一个字体都没有」——这是一个**只可能来自无头环境的值**。
它可被硬编码伪造，但伪造的前提是**知道真值**，而真值依赖宿主系统。

本体额外要求：`Ee()` 建立 iframe 并轮询 `contentWindow.document.readyState === "complete"`。

---

## 4. 本体**没有**用到的东西（澄清常见猜测）

全文关键词计数（这是**实测**，不是推测）：

| 关键词 | 次数 |
|---|---|
| `getContext` | **0** |
| `WebGL` | **0** |
| `AudioContext` | **0** |
| `canvas` | **0** |
| `screen` | **0** |
| `navigator` | **1**（仅 `navigator.userAgent`，且来自 core-js 特性检测） |
| `document.createElement` | 1（`document.createElement("style")` 注入图标字体） |

⇒ **「canvas 指纹 / WebGL / 音频指纹」这些常见猜测在本体里全部不成立。**
真正的多维采集在 `FEILIN` 运行时内（动态 JS，404 不可得）。

---

## 5. 网络层分析

### 5.1 请求实现：裸 XHR

```js
function Xr(url, cfg){
  return new Promise(function(resolve, reject){
    var o = new XMLHttpRequest;
    o.open(cfg.method, url, true);
    cfg.headers && Object.keys(cfg.headers).forEach(k => o.setRequestHeader(k, cfg.headers[k]));
    o.withCredentials = cfg.withCredentials;        // ← 需真实 Cookie 容器
    cfg.timeout > 0 && (o.timeout = cfg.timeout);
    o.responseType = cfg.responseType || "text";
    o.onload = function(){
      if (o.status >= 200 && o.status < 300) resolve(o.response);
      else if (403 === o.status) {                  // ← 特殊处理限流
        var e = o.getResponseHeader("x-auth-msg");
        e ? resolve({Code:"403", LimitedFlowToken:e, LimitedFlow:true, err:"LimitedFlow"}) : reject(...)
      } else reject(new Error(o.responseText))
    };
    o.ontimeout = () => reject(new Error("timeout"));
    o.onerror   = () => reject(new Error("network error"));
    o.send(cfg.body);
  })
}
```

**无 fetch、无 FormData。** body 是手工拼接的 urlencoded：

```js
function Qr(t){ var e=""; for(var r in t) ""!==e&&(e+="&"), e += encodeURIComponent(r)+"="+encodeURIComponent(t[r]); return e }
```

### 5.2 请求签名（**静态可解**——唯一对离线友好的一环）

```js
c.AaduaneId = o.KEY_ID;
c.SignatureMethod = "HMAC-SHA1";
c.SignatureVersion = "1.0";
c.Format = "JSON";
c.Timestamp = he();                                  // getTimestampUTC()
c.Version   = pt;                                    // "1.3.405"
c.Action    = e;
c.SignatureNonce = de();                             // UUID
c.Signature = Cr(c, o.KEY_SECRET);                   // ← HMAC-SHA1
```

密钥常量从字符串表拼装（`Er.KEY_ID` / `Er.KEY_SECRET`），**可静态还原**。
这是整个链路里**唯一**能离线复刻的部分。

### 5.3 设备指纹端点清单（本体硬编码，9 个）

```js
f && (v = s,                                        // isDev
  "cn" === p
    ? (h = "sh3c47a8ddhs03057ef9e8a295bc895c",      // dev appKey
       d = "1.0" === o
         ? ["https://pre-device.captcha-open.aliyuncs.com"]
         : ["https://cloudauth-device-pre.aliyuncs.com",
            "https://pre-cn-shanghai.device.saf.aliyuncs.com"])
    : "cn" !== p && (d = ["https://pre-ap-southeast-1.device.saf.aliyuncs.com"],
                     "1.0" === o && d.push("https://cloudauth-device-pre.ap-southeast-1.aliyuncs.com")))
```

| 域名 | 区域 | 场景 |
|---|---|---|
| `cloudauth-device-pre.aliyuncs.com` | cn | dev 主 |
| `pre-cn-shanghai.device.saf.aliyuncs.com` | cn | dev fallback |
| `pre-ap-southeast-1.device.saf.aliyuncs.com` | intl | dev |
| `cloudauth-device-pre.ap-southeast-1.aliyuncs.com` | intl | dev |
| `pre-device.captcha-open.aliyuncs.com` | cn | verifyType 1.0 |

（生产侧 4 个：`cloudauth-device-dualstack.{cn-shanghai,ap-southeast-1}`、
`{cn-shanghai,ap-southeast-1}.device.saf`、`ap-southeast-1-ga.device.saf` 等，表内拼装）

### 5.4 端点探测（**关键负结果**）

```
POST https://pre-cn-shanghai.device.saf.aliyuncs.com   body=""          → 200, len=7, "success"
POST 同上                                             body="{}"        → 200, len=7, "success"
POST 同上                                             body=<完整Action参数> → 200, len=7, "success"
POST https://pre-device.captcha-open.aliyuncs.com     body=""          → 200, len=7, "success"
POST <任意子路径> /InitCaptcha /api /device /captcha   → 4xx
```

响应头含完整 CORS：`Access-Control-Allow-Origin` / `-Methods` / `-Credentials` / `-Headers` / `-Max-Age`。

**判读**：根路径是 **CDN/WAF 兜底层**——**任意 body（含空）返回一模一样的 7 字节**。
区分度为 0，**不是业务接口**。业务真实路径不在根上，且**未出现在客户端代码中**
（客户端只用 `initPath: "/"` 拼主机）。

⇒ **不存在「纯 HTTP 直连拿 deviceToken」的接口。**

---

## 6. Node 沙箱实证

用 `node:vm` + 手写最小 DOM 加载完整本体：

```
[OK] 求值成功
window.initAliyunCaptcha      = undefined
window.AliyunCaptcha          = undefined
window.__ALIYUN_CAPTCHA_UTILS = isEmptyObj, mergeObjs, isNumber, isString, isBoolean,
                                isObject, isFunction, makeURL, throwError,
                                getTimestampUTC, UUID, consoleError
```

**本体能加载**（`typeof document` 守卫 + `AliyunCaptchaConfig` 未设，跳过动态加载），
但 `AliyunCaptcha` / `initAliyunCaptcha` **永远是 undefined** —— 印证 §3.1。

用本体自带的 `makeURL` 验证端点拼接（`makeURL(协议, 主机, 路径, 查询)`）：

```
makeURL('https://', 'https://cloudauth-device-pre.aliyuncs.com', '/', {})
  → https://cloudauth-device-pre.aliyuncs.com/        ✅
```

**路径构造函数忠实重放**（`captchaJsPath` 的控制流平坦化已解开）：

```js
// p[l(n)] = l(i)+l(o)+l(c)+l(u)  ← 注意：这是赋值给局部 p，不是 URL 拼接
// return p[527]( p[578]( p[535], t ), p[459] )
//   = (527 + (578 + (535 + version))) + 459
// 还原后：'ABg=' + ('taPHkC+T' + ('tK5X1r3E' + version)) + 'device.c'
```

关键发现：`captchaJsPath` 的返回值**不是可直接用的 URL**——
它是由被拆碎的片段拼成的**相对路径**，需与主机、`initPath` 组合，且**片段本身是混淆产物**。

---

## 7. happy-dom / jsdom 可行性判定

| 要求 | 能否满足 | 说明 |
|---|---|---|
| 加载本体 | ✅ | `node:vm` 实测成功 |
| `window.initAliyunCaptcha` | ❌ | 动态 JS 才定义 |
| `window.AliyunCaptcha` 构造 | ❌ | 同上 |
| `startTracelessVerification` | ❌ | 同上（§3.1） |
| `FEILIN` 运行时 | ❌ | 动态 JS 才装载（§3.2） |
| `DeviceToken` | ❌ | 只有 FEILIN 能产 |
| 字体特征 `_FN` | ⚠️ 可硬编码 | 但需知真值（§3.3） |
| iframe `contentWindow` | ⚠️ 部分 | jsdom 存在但零布局 |
| 动态资源 URL | ❌ | 服务端下发（§2） |

**特征退化对照**：

| 特征 | 真实浏览器 | jsdom/happy-dom |
|---|---|---|
| `window._FN` | 100~200 | **0** |
| `offsetWidth/Height` | 真实像素 | **0** |
| Canvas / WebGL / Audio | 有 | **本体不用**（§4） |
| `navigator` 家族 | 完整 | 本体仅 1 次引用 |

**硬依赖 3 处，仅第 3 处可伪造。第 1、2 处无法伪造**——
它们是**另一次网络往返的下游产物**；不跑那一次，就拿不到 DeviceToken。

---

## 8. 更简单的路？

### 8.1 官方服务端 API —— 存在，但不解决本问题

阿里云提供 `VerifyIntelligentCaptcha`（验证码 2.0 服务端校验）：

- **输入**：前端产出的 `captchaVerifyParam` + `SceneId`
- **输出**：`VerifyResult`(bool) + `VerifyCode`

它是**校验**接口，不是**签发**接口。服务端没有「凭空签发合法 param」的能力——
否则验证码机制本身失效。**此路不通。**

### 8.2 第三方纯 HTTP 方案 —— 未找到

`web_search` 三组查询（「AliyunCaptcha 无感验证 逆向」/「cloudauth-device deviceToken 接口」/
「VerifyIntelligentCaptcha 服务端 API」）**全部返回无关结果**（阿里官网、招聘页、HxD 编辑器）。
公开逆向材料极少。

可能原因：版本较新（1.3.4）+ 三层保护（控制流平坦化 / 双字符串表 / 服务端下发动态 URL）。

### 8.3 Jet Hub 的 3012 —— 与本报告一致

Jet Hub 用 `solver.js` + happy-dom（64 KB）造出了**结构正确**的产物，但被 3012 拒绝。

结合本报告，这完全可解释：

- 他们能造出 `base64({certifyId, sceneId, isSign})` 的形状
- 但 `DeviceToken` / `securityToken` 是**编造或缺失**的
- 服务端校验时无法与其指纹库匹配 → 判异常 → **3012**

**补充前序结论**：3012 不仅跟随「新鲜材料」移动（变量交换实验已证），
而且**「新鲜材料」本身必须是真品**。绕过浏览器只会产生赝品。

---

## 9. 与工作区既有结论的衔接

`AGENTS.md` 已有定论：

> **3012 不可绕过** —— 变量交换实验证明它跟随「新鲜材料」移动。
> 唯一可行路径是走**壳内会话链路**。

本报告提供了**第二条独立证据链**（从 SDK 内部结构出发）：

```
「新鲜材料」的上游 = DeviceToken
DeviceToken 的上游 = window.FEILIN.initFeiLin()
FEILIN 的上游     = 服务端下发的动态 JS
动态 JS 的上游    = 真实浏览器环境（+ CryptoKey/布局引擎）
```

⇒ **结论一致：不要尝试无浏览器复刻，继续走壳内会话链路。**

---

## 10. 未确定项（诚实标注）

| 项 | 状态 | 原因 |
|---|---|---|
| `dynamicJsPath` 真实主机 | **未确定** | 片段拆散 + 需运行时 |
| FEILIN 内部协议 | **未获取** | 动态 JS 404 |
| `startTracelessVerification` 实现 | **未获取** | 在动态 JS 里 |
| 生产 CDN 主机全名 | **未确定** | 同上 |
| 生产 appKey | 部分 | 表内有片段，未完整拼接 |
| CORS 头具体值 | 部分 | `-Credentials` 被 DSH 输出脱敏 |

**这些不是调查疏漏，是设计使然**——该 SDK 刻意让静态分析无法得到完整图景。

---

## 11. 产物清单

```
D:\zcode-glm5.3f\_reverse\
  ── 本体与还原 ──
  AliyunCaptcha.js              原始（224,977 B）
  AliyunCaptcha.destr.js        表引用已内联
  AliyunCaptcha.flat.js         字符串常量已拼接
  _strtable_dump.txt            完整字符串表 288 条
  ── 还原脚本 ──
  _dec.js  _destr.js  _flat.js  _replay.js  _urls.js  _tbl2.js  _pe.js  _dump.js  _dump2.js
  ── 沙箱实证 ──
  _probe.js  _probe2.js  _probe3.js  _probe4.js
  _probe_out.json  _calls.json
```

**复现**：

```powershell
node D:\zcode-glm5.3f\_reverse\_probe4.js     # 沙箱加载本体 + 端点常量
node D:\zcode-glm5.3f\_reverse\_replay.js     # 路径构造函数忠实重放
node D:\zcode-glm5.3f\_reverse\_urls.js       # 端点 URL 拼装
```

**来源**：
[AliyunCaptcha.js](https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js)
