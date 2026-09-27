const { createHmac, hkdfSync, randomBytes, createDecipheriv } = require("node:crypto");

const credential = "4359f34b87d246e48ba5322490f33ed0.vtUS92Ium1fCwflO";
const ENDPOINT = "https://api.z.ai/api/paas/c1f3a7e2/v2/client";
const SALT = "WD_CLIENT_SIGN_KDF_SALT";
const INFO_HANDSHAKE = "getSignKey_hmac";
const INFO_PRIV = "ed25519_priv";
const ACTION = "get_sign_key";
const APP_ID = "zcode";

const idx = credential.indexOf(".");
const apiKeyId = credential.slice(0, idx);
const apiKeySecret = credential.slice(idx + 1);

const derive = (info, secret = apiKeySecret) =>
  Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"),
    Buffer.from(SALT, "utf8"), Buffer.from(info, "utf8"), 32));

const ts = String(Date.now());
const nonce = randomBytes(16).toString("hex");

(async () => {
  // ── 步骤 1：握手拿 privateCipher ──
  const key = derive(INFO_HANDSHAKE);
  const msg = `${ACTION}\n${apiKeyId}\n${ts}\n${nonce}`;
  const sig = createHmac("sha256", key).update(msg, "utf8").digest("base64");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: credential, "x-api-key": credential },
    body: JSON.stringify({ apiKey: credential, nonce, sig, ts: Number(ts) }),
  });
  const json = await res.json();
  console.log("① 握手:", JSON.stringify(json).slice(0, 130));
  if (json.code !== 200) return;
  const privateCipher = json.data.privateCipher;
  console.log("   privateCipher 长度:", privateCipher.length);

  // ── 步骤 2：解密 privateCipher 拿 ed25519 私钥 ──
  // 闭源版 nur(e,t,n)：
  //   o = HKDF(t, "ed25519_priv")             t=apiKeySecret
  //   decrypt({additionalData: RV(e), iv: l.slice(0,12), name:"AES-GCM", tagLength:128}, u, l.slice(12))
  //   e 是 additionalData —— 从 rur 的签名看，可能是 apiKeyId
  const cipherBytes = Buffer.from(privateCipher, "base64");
  const iv = cipherBytes.subarray(0, 12);
  const tag = cipherBytes.subarray(cipherBytes.length - 16);
  const data = cipherBytes.subarray(12, cipherBytes.length - 16);

  for (const ad of [apiKeyId, credential, ""]) {
    try {
      const aesKey = derive(INFO_PRIV);
      const d = createDecipheriv("aes-256-gcm", aesKey, iv);
      d.setAAD(Buffer.from(ad, "utf8"));
      d.setAuthTag(tag);
      const out = Buffer.concat([d.update(data), d.final()]);
      const pkcs8 = out.toString("utf8");
      console.log(`② 解密成功 (additionalData="${ad}")，${pkcs8.length} 字符`);
      console.log("   前缀:", pkcs8.slice(0, 40));
      break;
    } catch (e) {
      console.log(`   解密失败 (additionalData="${ad}"): ${e.message.slice(0, 60)}`);
    }
  }
})();
