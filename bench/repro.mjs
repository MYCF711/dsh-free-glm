/**
 * 复现 multi-step-refactor 的现场，检查模型产出到底长什么样。
 *
 * 用途：区分「模型没做对」与「判定器误报」。
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dsh = join(
  process.env.APPDATA ?? "",
  "in.dsh-plug.dsh-launcher/versions/0.1.7-rc.2/node_modules/.bin/dsh.CMD",
);

const FILES = {
  "lib/a.mjs": `export const NAME = "a";\nexport function greet() { return "hi from " + NAME; }\n`,
  "lib/b.mjs": `export const NAME = "b";\nexport function greet() { return "hi from " + NAME; }\n`,
  "lib/c.mjs": `export const NAME = "c";\nexport function greet() { return "hi from " + NAME; }\n`,
  "index.mjs": `import { greet as ga } from "./lib/a.mjs";\nimport { greet as gb } from "./lib/b.mjs";\nconsole.log(ga(), gb());\n`,
};

const PROMPT =
  "把 lib/ 下三个文件里重复的 greet 实现抽到一个新文件 lib/greet.mjs（导出 greet(name) 返回 'hi from ' + name），" +
  "让 a/b/c 都改为导入它并用自己的 NAME 调用。" +
  "最后 index.mjs 要能打印 'hi from a hi from b'，用 node index.mjs 验证。";

const root = await mkdtemp(join(tmpdir(), "zcbench-repro-"));
const dir = join(root, "project");
await mkdir(dir, { recursive: true });
for (const [rel, c] of Object.entries(FILES)) {
  const f = join(dir, rel);
  await mkdir(join(f, ".."), { recursive: true });
  await writeFile(f, c, "utf8");
}
console.log(`项目目录: ${dir}`);
console.log("（保留不删，供人工查看）\n");

const started = Date.now();
await new Promise((resolve) => {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `chcp 65001>nul && ${dsh} headless -`], {
    cwd: dir,
    windowsHide: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.on("close", resolve);
  child.stdin.end(`${PROMPT}\n`, "utf8");
});
console.log(`\n耗时 ${Date.now() - started}ms\n`);

console.log("══════ 产出文件 ══════");
for (const rel of ["lib/greet.mjs", "lib/a.mjs", "lib/b.mjs", "lib/c.mjs", "index.mjs"]) {
  const c = await readFile(join(dir, rel), "utf8").catch(() => "<不存在>");
  console.log(`\n───── ${rel} ─────`);
  console.log(c);
}
