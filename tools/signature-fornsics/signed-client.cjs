/**
 * 完整签名客户端 —— 复刻闭源版 `ClientRequestSigningV4`，用于直连上游实验。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 规格来源（全部从 E:\zcoed\ZCode\resources\glm\zcode.cjs 提取）
 * ════════════════════════════════════════════════════════════════════════
 *
 * 常量（偏移 848658）：
 *   action   = "get_sign_key"
 *   endpoint = /api/paas/c1f3a7e2/v2/client      ★ 在 api.z.ai，不在 zcode.z.ai
 *   appId    = "zcode"
 *   nonceLen = 16 字节
 *   powBits  = 8
 *
 * HKDF（偏移 845331，函数 `iur`）：
 *   deriveBits({ name:"HKDF", hash:"SHA-256",
 *                salt: "WD_CLIENT_SIGN_KDF_SALT",
 *                info: <参数> }, importKey("raw", secret, "HKDF"), 256)
 *   info 取值："getSignKey_hmac"（握手签名） / "ed25519_priv"（解私钥）
 *
 * 握手（偏移 855175 / 846053）：
 *   key = HKDF(secret, "getSignKey_hmac")
 *   sig = base64( HMAC-SHA256(key, `get_sign_key\n${apiKeyId}\n${ts}\n${nonce}`) )
 *        ★ 分隔符是**换行**，不是空格（实测：空格得 4011，换行得 200）
 *   body = { apiKey: credential, nonce, sig, ts: Number(ts) }
 *   → { code:200, data:{ privateCipher } }
 *
 * 解私钥（偏移 846053，函数 `nur`）：
 *   aesKey = HKDF(secret, "ed25519_priv")
 *   priv   = AES-GCM-decrypt(privateCipher,
 *              iv = bytes[0..12], tag = bytes[len-16..], data = bytes[12..len-16],
 *              additionalData = apiKeyId)
 *   → base64 → PKCS8 DER → Ed25519 key
 *
 * 业务请求签名（偏移 853402，方法 `sendSigned`）：
 *   msg = `${apiKeyId} ${ts} ${clientVersion} ${sessionId} ${nonce}`   ← 空格分隔
 *   X-Client-Sig = base64( Ed25519.sign(priv, msg) )
 *   X-Client-Ts  = ts
 *   X-Client-Version = clientVersion
 *   X-Session-Id = sessionId
 *   X-Client-Nonce = nonce（16B hex）
 *   X-App-Id = "zcode"
 *   X-Client-Pow = PoW 结果
 *
 * PoW（偏移 846053，函数 `our`）：
 *   seed = hex(SHA256(`${apiKeyId} ${appId} ${sessionId} ${ts}`)).slice(0,32)
 *   for i: candidate = randomHex(12) + i.toString(16).padStart(8, "0")
 *          if SHA256(`${seed}\n${candidate}`) 前 8 bit 为 0 → candidate 即 PoW
 *
 * ════════════════════════════════════════════════════════════════════════
 * ⚠ 已知限制
 * ════════════════════════════════════════════════════════════════════════
 *
 * 闭源版 `cRs()`（签名启用判定）对 **start-plan 显式返回 false**：
 *   if (access.type === "zhipu-account" && (access.mode === "start-plan" || ...)) return false;
 *
 * 所以本脚本是**实验性的** —— 验证服务端是否真的不期待签名，
 * 而不是复刻一个已被官方排除的流程。
 */
const {
  createHmac,
  hkdfSync,
  randomBytes,
  createDecipheriv,
  createPrivateKey,
  sign,
  createHash,
} = require("node:crypto");

const CREDENTIAL = process.argv[2];
const SESSION_ID = process.argv[3] || randomBytes(16).toString("hex");
const CLIENT_VERSION = process.argv[4] || "3.14.3";

if (!CREDENTIAL || !CREDENTIAL.includes(".")) {
  console.error("用法: node signed-client.cjs <apiKeyId>.<apiKeySecret> [sessionId] [clientVersion]");
  process.exit(2);
}

const ENDPOINT_ORIGIN = "https://api.z.ai";
const ACTION = "get_sign_key";
const APP_ID = "zcode";
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const INFO_HANDSHAKE = "getSignKey_hmac";
const INFO_PRIV = "ed25519_priv";
const NONCE_LEN = 16;
const POW_BITS = 8;

const dotIdx = CREDENTIAL.indexOf(".");
const apiKeyId = CREDENTIAL.slice(0, dotIdx);
const apiKeySecret = CREDENTIAL.slice(dotIdx + 1);

/** 复刻 iur(secret, info)。 */
function deriveBytes(info, secret = apiKeySecret) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(KDF_SALT, "utf8"),
      Buffer.from(info, "utf8"),
      32,
    ),
  );
}

/** 步骤 1：握手，拿 privateCipher。 */
async function handshake() {
  const ts = String(Date.now());
  const nonce = randomBytes(NONCE_LEN).toString("hex");
  const key = deriveBytes(INFO_HANDSHAKE);
  // ★ 换行分隔（实测：空格 → 4011，换行 → 200）
  const message = `${ACTION}\n${apiKeyId}\n${ts}\n${nonce}`;
  const sig = createHmac("sha256", key).update(message, "utf8").digest("base64");

  const res = await fetch(`${ENDPOINT_ORIGIN}/api/paas/c1f3a7e2/v2/client`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: CREDENTIAL, "x-api-key": CREDENTIAL },
    body: JSON.stringify({ apiKey: CREDENTIAL, nonce, sig, ts: Number(ts) }),
  });
  const json = await res.json();
  if (json.code !== 200) {
    throw new Error(`握手失败: ${JSON.stringify(json)}`);
  }
  return json.data.privateCipher;
}

/** 步骤 2：解出 Ed25519 私钥。 */
function decryptPrivateKey(privateCipher) {
  const raw = Buffer.from(privateCipher, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(12, raw.length - 16);
  const aesKey = deriveBytes(INFO_PRIV);
  const d = createDecipheriv("aes-256-gcm", aesKey, iv);
  d.setAAD(Buffer.from(apiKeyId, "utf8"));
  d.setAuthTag(tag);
  const pkcs8B64 = Buffer.concat([d.update(data), d.final()]).toString("utf8");
  return createPrivateKey({ key: Buffer.from(pkcs8B64, "base64"), format: "der", type: "pkcs8" });
}

/** 步骤 3：PoW。 */
function computePow(ts) {
  const seed = createHash("sha256")
    .update(`${apiKeyId} ${APP_ID} ${SESSION_ID} ${ts}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const prefix = randomBytes(12).toString("hex");
  const need = 1 << POW_BITS;
  for (let i = 0; i <= 4_294_967; i += 1) {
    const candidate = prefix + i.toString(16).padStart(8, "0");
    const h = createHash("sha256").update(`${seed}\n${candidate}`, "utf8").digest();
    // 前 POW_BITS 位为 0：取首字节，判断高位
    if ((h[0] >> (8 - POW_BITS)) === 0) {
      return candidate;
    }
  }
  throw new Error("PoW 未找到解");
}

/** 步骤 4：签名业务消息并生成全部签名头。 */
function buildSignedHeaders(privateKey) {
  const ts = String(Date.now());
  const nonce = randomBytes(NONCE_LEN).toString("hex");
  const msg = `${apiKeyId} ${ts} ${CLIENT_VERSION} ${SESSION_ID} ${nonce}`;
  const sigB64 = sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64");
  const pow = computePow(ts);
  return {
    "X-Client-Ts": ts,
    "X-Client-Version": CLIENT_VERSION,
    "X-Client-Sig": sigB64,
    "X-Session-Id": SESSION_ID,
    "X-Client-Nonce": nonce,
    "X-App-Id": APP_ID,
    "X-Client-Pow": pow,
  };
}

(async () => {
  console.log("apiKeyId    :", apiKeyId);
  console.log("sessionId   :", SESSION_ID);
  console.log("version     :", CLIENT_VERSION);
  console.log("");

  const cipher = await handshake();
  console.log("① 握手成功，privateCipher 长度", cipher.length);

  const privateKey = decryptPrivateKey(cipher);
  console.log("② 私钥解密成功，类型", privateKey.asymmetricKeyType);

  const headers = buildSignedHeaders(privateKey);
  console.log("③ 签名头已生成:");
  for (const [k, v] of Object.entries(headers)) {
    console.log(`   ${k} = ${String(v).slice(0, 50)}${String(v).length > 50 ? "…" : ""}`);
  }

  // 输出为 JSON，供上层脚本消费
  console.log("");
  console.log("HEADERS_JSON=" + JSON.stringify(headers));
})().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
