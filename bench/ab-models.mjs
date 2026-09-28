#!/usr/bin/env node
/**
 * 同负载 A/B：GLM-5.3 vs GLM-5.3-Flash。
 *
 * ## 为什么需要这个（而不是拿历史日志对比）
 *
 * 项目方法论第一条：**同负载 A/B > 跨时段对比**。
 * 历史日志里的模型差异会与「当天任务难度」「并发情况」混在一起，
 * 分不清是模型档位造成的还是负载造成的。
 *
 * 这里让两个模型跑**完全相同的 prompt、相同的目录、相邻的时间**，
 * 交替执行（A B A B）以抵消漂移。
 *
 * ## 直连桥而不是走 DSH
 *
 * 走 DSH 每次要起一个完整 agent 会话（几十秒开销 + 工具回合），
 * 测出来的是「DSH 编排 + 模型」的混合。这里要单独量**模型侧**，
 * 所以直接打桥的 `/v1/chat/completions`。
 *
 * 用法：node bench/ab-models.mjs [每模型轮数]
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = "D:\\zcode-glm5.3f\\_oss_data";
const DISCOVERY = join(DATA_DIR, ".zcode", "v2", "bridge-port.json");

const ROUNDS = Number(process.argv[2] ?? 4);

/** 固定的三题 —— 与 LATENCY-FINDINGS.md 的历史基准同构，便于对照。 */
const PROMPTS = [
  "一个班有 40 人，60% 是女生，女生中 25% 戴眼镜。戴眼镜的女生有多少人？只给数字。",
  "把下面这句话改成一个字都不多不少、但语义完全相反的陈述：「这台服务器从未宕机」。",
  "用一句话解释：为什么 for (let i = 0; i <= arr.length; i++) 遍历数组是危险的？",
];

/** 判定答案对错 —— 只做**能机器判定**的客观检查。 */
function grade(promptIndex, text) {
  if (promptIndex === 0) {
    // 40 * 0.6 = 24 女生；24 * 0.25 = 6
    return /(^|\D)6(\D|$)/.test(text);
  }
  if (promptIndex === 1) {
    /**
     * 语义相反：原句「这台服务器从未宕机」= **一直正常**；
     * 反义 = **一直/始终不在正常状态**。
     *
     * ## 判定器的三次迭代（每次都因误判而修）
     *
     * ① 只认 `(一直|始终|总是)+宕机` → 把「**早已**宕机」误判为错。
     * ② 加入「早已」等持续义词 → 把「**曾经**宕机」**误判为对**。
     *
     * 关键区分：「曾经」是**过去某一点**（存在量化），
     * 「一直/始终/早已」是**持续状态**（全称量化）。
     * 只有后者才构成「从未」的反义。
     *
     * ⇒ 现在：必须出现**全称/持续**语义的词 + 宕机义，且**排除**
     *   「曾经 / 有过 / 一度」这类存在量化的表述。
     */
    const universal = /(一直|始终|总是|向来|从来|常年|持续|早已|总是|永久|永远)/.test(text);
    const existential = /(曾经|有过|一度|某次|偶尔)/.test(text);
    const down = /(宕机|故障|不可用|停机|瘫痪|挂了|不在线)/.test(text);
    const never = /从未.{0,6}(正常|可用|运行|工作)/.test(text);
    const stillOriginal = /从未\s*宕机/.test(text);
    if (stillOriginal && !universal) return false;
    return (universal && down && !existential) || never;
  }
  // 越界：i === arr.length 时 arr[i] 是 undefined
  return /(越界|超出|undefined|边界|off-by-one|数组长度)/i.test(text);
}

async function probe(port, token, model, prompt) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      stream: false,
      // 与默认模型路径一致的 system 形态（不为测速而特殊化）
      system: "You are ZCode, an interactive coding agent",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const raw = await res.text();
  const elapsedMs = Date.now() - started;

  /**
   * 桥对 `stream:false` 返回 OpenAI 形状 JSON。
   * 但上游是 Anthropic，可能带 `thinking` 块 —— 要**只取可见文本**，
   * 不能把思考链算进答案（否则判分会误判成「很长」）。
   */
  let text = "";
  try {
    const j = JSON.parse(raw);
    const choice = j?.choices?.[0];
    text = String(choice?.message?.content ?? choice?.text ?? "");
  } catch {
    text = raw;
  }
  return { ok: res.ok, status: res.status, elapsedMs, text: text.trim(), raw: raw.slice(0, 300) };
}

const disc = JSON.parse(await readFile(DISCOVERY, "utf8"));
const { port, token } = disc;
console.log(`桥端口 ${port}   每模型 ${ROUNDS} 轮 × ${PROMPTS.length} 题\n`);

const MODELS = ["GLM-5.3", "GLM-5.3-Flash"];
const rows = [];

/**
 * 交替执行：每一轮先 A 后 B。这样两个模型经历的时间窗口几乎相同，
 * 上游的瞬时负载差异对两者影响对称。
 */
for (let round = 0; round < ROUNDS; round += 1) {
  for (const model of MODELS) {
    for (let qi = 0; qi < PROMPTS.length; qi += 1) {
      const r = await probe(port, token, model, PROMPTS[qi]);
      const correct = r.ok && grade(qi, r.text);
      rows.push({ model, round, qi, ...r, correct });
      process.stdout.write(
        `  轮${round + 1} ${model.padEnd(14)} 题${qi + 1}  ` +
          `${r.ok ? "200" : r.status}  ${String(r.elapsedMs).padStart(6)}ms  ` +
          `${correct ? "✓" : "✗"}  ${r.text.slice(0, 40).replace(/\n/g, " ")}\n`,
      );
    }
  }
}

console.log("\n══════════ 汇总 ══════════");
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
};
for (const model of MODELS) {
  const mine = rows.filter((r) => r.model === model && r.ok);
  const times = mine.map((r) => r.elapsedMs);
  const correct = mine.filter((r) => r.correct).length;
  console.log(
    `${model.padEnd(14)} n=${mine.length}  中位 ${median(times)}ms  ` +
      `最快 ${Math.min(...times)}ms  正确 ${correct}/${mine.length}`,
  );
}
const bad = rows.filter((r) => !r.ok);
if (bad.length > 0) {
  console.log(`\n⚠ 失败请求 ${bad.length} 条：`);
  for (const b of bad.slice(0, 5)) console.log(`  ${b.model} ${b.status} ${b.raw.slice(0, 140)}`);
}
