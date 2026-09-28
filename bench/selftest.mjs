/**
 * 自检：对每个任务，用「未修复的初始状态」跑 verify()。
 *
 * 期望结果：**全部 ok=false**。
 * 若某个任务在初始状态就 ok=true，说明判定器写错了，那个任务测不出任何东西。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "./runner.mjs";

let bad = 0;
for (const t of TASKS) {
  const root = await mkdtemp(join(tmpdir(), "vt-"));
  const dir = join(root, "project");
  await mkdir(dir, { recursive: true });
  for (const [rel, c] of Object.entries(t.files)) {
    const f = join(dir, rel);
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, c, "utf8");
  }
  const v = await t.verify(dir);
  const tag = v.ok ? "✗ 判定器有误（初始就通过）" : "✓ 正确判负";
  if (v.ok) bad += 1;
  console.log(`${t.id.padEnd(24)} ${tag}`);
  console.log(`  ${v.detail}`);
}
console.log(`\n${TASKS.length - bad}/${TASKS.length} 个任务判定器正确`);
process.exit(bad === 0 ? 0 : 1);
