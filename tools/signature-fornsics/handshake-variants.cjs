const { createHmac, hkdfSync, randomBytes } = require("node:crypto");

const credential = "4359f34b87d246e48ba5322490f33ed0.vtUS92Ium1fCwflO";
const ENDPOINT = "https://api.z.ai/api/paas/c1f3a7e2/v2/client";
const SALT = "WD_CLIENT_SIGN_KDF_SALT";
const INFO = "getSignKey_hmac";
const ACTION = "get_sign_key";

const derive = (secret, info) =>
  Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(SALT, "utf8"), Buffer.from(info, "utf8"), 32));

// 切分方式候选
const idx = credential.indexOf(".");
const id1 = credential.slice(0, idx);
const sec1 = credential.slice(idx + 1);
const id2 = credential.split(".")[0];
const sec2 = credential.split(".").slice(1).join(".");

const ts = String(Date.now());
const nonce = randomBytes(16).toString("hex");

const variants = [
  { n: "空格分隔 + base64", msg: `${ACTION} ${id1} ${ts} ${nonce}`, enc: "base64", secret: sec1 },
  { n: "空格分隔 + hex",    msg: `${ACTION} ${id1} ${ts} ${nonce}`, enc: "hex",    secret: sec1 },
  { n: "冒号分隔 + base64", msg: `${ACTION}:${id1}:${ts}:${nonce}`, enc: "base64", secret: sec1 },
  { n: "换行分隔 + base64", msg: `${ACTION}\n${id1}\n${ts}\n${nonce}`, enc: "base64", secret: sec1 },
  { n: "无 action + base64", msg: `${id1} ${ts} ${nonce}`, enc: "base64", secret: sec1 },
  { n: "全 credential 当 secret + base64", msg: `${ACTION} ${id1} ${ts} ${nonce}`, enc: "base64", secret: credential },
  { n: "secret 含点 + base64", msg: `${ACTION} ${id2} ${ts} ${nonce}`, enc: "base64", secret: sec2 },
];

(async () => {
  for (const v of variants) {
    const key = derive(v.secret, INFO);
    const sig = createHmac("sha256", key).update(v.msg, "utf8").digest(v.enc);
    const body = JSON.stringify({ apiKey: credential, nonce, sig, ts: Number(ts) });
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: credential, "x-api-key": credential },
        body,
      });
      const text = await res.text();
      const code = (text.match(/"code":(\d+)/) || [])[1] || "?";
      console.log(`[${v.n}]  code=${code}  ${text.slice(0, 110)}`);
    } catch (e) {
      console.log(`[${v.n}]  异常: ${e.message}`);
    }
  }
})();
