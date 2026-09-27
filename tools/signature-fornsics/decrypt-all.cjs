const { createDecipheriv, createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const secret = process.env.ZCODE_CREDENTIAL_SECRET
  || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${require("node:os").userInfo().username}`;
const key = createHash("sha256").update(secret).digest();
for (const ref of Object.keys(j)) {
  const v = j[ref];
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) {
    if (typeof v === "string" && v.length < 200) console.log(`[明文] ${ref} = ${v}`);
    continue;
  }
  const parts = v.slice(7).split(".");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
    d.setAuthTag(Buffer.from(parts[1], "base64url"));
    const out = Buffer.concat([d.update(Buffer.from(parts[2], "base64url")), d.final()]).toString("utf8");
    const shown = out.length > 120 ? out.slice(0, 120) + "…" : out;
    console.log(`[解密] ${ref}\n        = ${shown}`);
  } catch (e) {
    console.log(`[失败] ${ref}: ${e.message}`);
  }
}
