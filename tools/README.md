# 抓包工具：提取壳内真实请求特征

`hook-session-outbound.cjs` 用于**把壳（ZCode 实例）发往 `zcode.z.ai` 的
真实请求头抓下来**。它是本项目「伪装部分提取」结论的取证工具。

## 用途

当你要回答这类问题时：

- 壳内请求到底带了哪些头？
- 上游风控（3012）到底看什么？
- 我补的头对不对、够不够？

## 用法

```powershell
# 1. 先停掉现有壳
pwsh -File D:\zcode-glm5.3f\scripts\start-headless.ps1 -Stop

# 2. 带 hook 启动（NODE_OPTIONS 会传给 electron 的子进程）
$electron = '<你的 ZCode 检出>\node_modules\electron\dist\electron.exe'
$appDir   = '<你的 ZCode 检出>\packages\desktop'
$env:NODE_OPTIONS = "--require $PWD\hook-session-outbound.cjs"
$env:ZCODE_DATA_BASE_DIR = '<你的数据目录>'
$env:ZCODE_BRIDGE = '1'
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $appDir -WindowStyle Hidden

# 3. 发一次请求触发
$f = Get-Content "$env:ZCODE_DATA_BASE_DIR\.zcode\v2\bridge-port.json" -Raw | ConvertFrom-Json
Invoke-RestMethod "http://127.0.0.1:$($f.port)/v1/chat/completions" `
  -Headers @{ Authorization = "Bearer $($f.token)" } -ContentType 'application/json' `
  -Body '{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}]}'

# 4. 看抓包结果（与脚本同目录的 _session-outbound.jsonl）
Get-Content .\_session-outbound.jsonl | ForEach-Object {
  $o = $_ | ConvertFrom-Json
  if ($o.signatureHeaders) { "$($o.url)`n  签名头: $($o.signatureHeaders -join ', ')`n  全部头: $($o.allHeaderNames -join ', ')" }
}
```

## 它抓到了什么（本项目的重要发现）

发往 `zcode-plan/anthropic/v1/messages` 的请求，头集合是：

```
anthropic-beta, anthropic-version, authorization, content-type, http-referer,
user-agent, x-aliyun-captcha-verify-param, x-aliyun-captcha-verify-region,
x-api-key, x-client-language, x-client-timezone, x-os-category, x-os-version,
x-platform, x-query-id, x-release-channel, x-request-id, x-session-id, x-title,
x-zcode-agent, x-zcode-app-version, x-zcode-session-type, x-zcode-trace-id
```

**关键结论**：

1. **没有签名头** —— 开源版的会话链路**不带** `X-Client-Sig` / `X-Client-Pow`。
   （那套 `ClientRequestSigningV4` 机制只存在于官方闭源版，且由服务端
   feature gate 控制，默认关闭。）
2. **不带 `X-Device-Mid`** —— 只有 `/billing/*` 那类管理接口才带。
   **头集合与真实请求"越像"越好，不是"越多"越好。**
3. 即使把上面 23 个头**逐字段全部复刻**到直发请求上，上游**仍然返回 3012**。
   ⇒ 3012 的判据是服务端的「会话注册状态」，不在 HTTP 头里。

## 注意

- 脚本只记录**头名**与**签名类头的值**（签名值不敏感且是排查必需品），
  **不记录** `Authorization` / `x-api-key` / captcha 的值。
- hook 卸载方式：就是不再设 `NODE_OPTIONS`，正常启动即可。
