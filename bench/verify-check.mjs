/**
 * 判定器回归测试：喂入**模型真实产出**与**故意写坏的反例**，检查判定是否正确。
 *
 * 这个文件的存在本身就是一条教训的记录：`multi-step-refactor` 的判定器
 * 被模型**两次**绕过 —— 两次都是模型做对、判定器判错。每次都是因为
 * 判定依赖了「模型自主选择的标识符名字」。
 *
 * 所以这里固定两份真实产出的样本，任何判定器改动都必须先过这一关。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "./runner.mjs";

const task = TASKS.find((t) => t.id === "multi-step-refactor");

/** 样本 1：模型第一次产出 —— 别名 `greetShared`。 */
const SAMPLE_ALIAS_SHARED = {
  "lib/greet.mjs": `export function greet(name) {\n  return "hi from " + name;\n}\n`,
  "lib/a.mjs": `import { greet as greetShared } from "./greet.mjs";\n\nexport const NAME = "a";\nexport function greet() { return greetShared(NAME); }\n`,
  "lib/b.mjs": `import { greet as greetShared } from "./greet.mjs";\n\nexport const NAME = "b";\nexport function greet() { return greetShared(NAME); }\n`,
  "lib/c.mjs": `import { greet as greetShared } from "./greet.mjs";\n\nexport const NAME = "c";\nexport function greet() { return greetShared(NAME); }\n`,
  "index.mjs": `import { greet as ga } from "./lib/a.mjs";\nimport { greet as gb } from "./lib/b.mjs";\nconsole.log(ga(), gb());\n`,
};

/** 样本 2：模型第二次产出 —— 别名 `_greet` + `export { greet }`。 */
const SAMPLE_ALIAS_UNDERSCORE = {
  "lib/greet.mjs": `export function greet(name) { return "hi from " + name; }\n`,
  "lib/a.mjs": `export const NAME = "a";\nexport { greet };\nimport { greet as _greet } from "./greet.mjs";\nfunction greet() { return _greet(NAME); }\n`,
  "lib/b.mjs": `export const NAME = "b";\nexport { greet };\nimport { greet as _greet } from "./greet.mjs";\nfunction greet() { return _greet(NAME); }\n`,
  "lib/c.mjs": `export const NAME = "c";\nexport { greet };\nimport { greet as _greet } from "./greet.mjs";\nfunction greet() { return _greet(NAME); }\n`,
  "index.mjs": `import { greet as ga } from "./lib/a.mjs";\nimport { greet as gb } from "./lib/b.mjs";\nconsole.log(ga(), gb());\n`,
};

/** 反例 1：完全没去重（三份重复实现）。必须判负。 */
const BAD_NOT_DEDUPED = {
  "lib/greet.mjs": `export function greet(name) { return "hi from " + name; }\n`,
  "lib/a.mjs": `export const NAME = "a";\nexport function greet() { return "hi from " + NAME; }\n`,
  "lib/b.mjs": `export const NAME = "b";\nexport function greet() { return "hi from " + NAME; }\n`,
  "lib/c.mjs": `export const NAME = "c";\nexport function greet() { return "hi from " + NAME; }\n`,
  "index.mjs": `import { greet as ga } from "./lib/a.mjs";\nimport { greet as gb } from "./lib/b.mjs";\nconsole.log(ga(), gb());\n`,
};

/** 反例 2：建了 greet.mjs 也导入了，但 a/b/c 仍各拼自己的字符串。必须判负。 */
const BAD_STILL_CONCAT = {
  "lib/greet.mjs": `export function greet(name) { return "hi from " + name; }\n`,
  "lib/a.mjs": `import { greet as g } from "./greet.mjs";\nexport const NAME = "a";\nexport function greet() { return "hi from " + NAME; }\n`,
  "lib/b.mjs": `import { greet as g } from "./greet.mjs";\nexport const NAME = "b";\nexport function greet() { return "hi from " + NAME; }\n`,
  "lib/c.mjs": `import { greet as g } from "./greet.mjs";\nexport const NAME = "c";\nexport function greet() { return "hi from " + NAME; }\n`,
  "index.mjs": `import { greet as ga } from "./lib/a.mjs";\nimport { greet as gb } from "./lib/b.mjs";\nconsole.log(ga(), gb());\n`,
};

async function withFiles(files) {
  const root = await mkdtemp(join(tmpdir(), "vfy-"));
  const dir = join(root, "project");
  await mkdir(dir, { recursive: true });
  for (const [rel, c] of Object.entries(files)) {
    const f = join(dir, rel);
    await mkdir(join(f, ".."), { recursive: true });
    await writeFile(f, c, "utf8");
  }
  return dir;
}

const CASES = [
  ["模型产出#1（别名 greetShared）", SAMPLE_ALIAS_SHARED, true],
  ["模型产出#2（别名 _greet）", SAMPLE_ALIAS_UNDERSCORE, true],
  ["反例#1（完全没去重）", BAD_NOT_DEDUPED, false],
  ["反例#2（导入了但仍各拼字符串）", BAD_STILL_CONCAT, false],
];

let failed = 0;
for (const [label, files, expect] of CASES) {
  const dir = await withFiles(files);
  const v = await task.verify(dir);
  const pass = v.ok === expect;
  if (!pass) failed += 1;
  console.log(`${pass ? "✓" : "✗"} ${label.padEnd(30)} 判定=${v.ok}  期望=${expect}`);
  console.log(`    ${v.detail}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
