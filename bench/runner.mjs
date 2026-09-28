#!/usr/bin/env node
/**
 * 基准测试：一个自包含的小项目，用同一套任务分别跑 DSH 与原生 ZCode。
 *
 * ## 为什么用一个真正的项目而不是几个问答
 *
 * 问答只能测「知识」，测不出**能力**。能力差异体现在：
 *   · 多步工具调用能不能串起来
 *   · 出错后能不能自己修
 *   · 一次做对还是要来回好几轮
 *
 * 所以这里放一个有**客观对错**、有**多步依赖**的小项目。
 *
 * ## 判定方式
 *
 * 每个任务都有 `verify()` —— 机器判定，不靠人看。
 * 同时记录 `elapsedMs`（完成速度）与 `turns`（完成程度：几轮做对）。
 *
 * 用法：
 *   node bench/runner.mjs --via dsh      # 走 DSH（含反代桥）
 *   node bench/runner.mjs --via bridge   # 直连桥（基准下限）
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ────────────────────────────────────────────────────────────────────────────
// 任务定义
// ────────────────────────────────────────────────────────────────────────────

/**
 * 每个任务形如：
 *   files     —— 初始文件（相对路径 → 内容）
 *   prompt    —— 给模型的任务描述
 *   verify    —— async (dir) => {ok:boolean, detail:string}
 *
 * ⚠ verify 必须**只依赖文件系统结果**，不看模型说了什么。
 *   这样「说得漂亮但没做对」不会被算成成功。
 */
export const TASKS = [
  {
    id: "bugfix-off-by-one",
    files: {
      /**
       * ⚠ 起始状态必须是**真的错**。
       *
       * 第一版写成 `for (let i = 1; i <= n; i++)` —— 那其实是正确的
       * （1+2+3+4+5 = 15），自检直接判「初始就通过」，任务测不出任何东西。
       * 现在用 `< n` 制造真实的 off-by-one：少加最后一项，输出 10。
       */
      "sum.mjs": `export function sumTo(n) {
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}
`,
      "expect.mjs": `import { sumTo } from "./sum.mjs";
console.log(sumTo(5));
`,
    },
    prompt:
      "项目里有一个 bug：expect.mjs 应该输出 15 但输出的不是 15。" +
      "修好 sum.mjs，然后用 node expect.mjs 验证输出确实是 15。",
    verify: async (dir) => {
      const { stdout } = await execFileAsync(process.execPath, ["expect.mjs"], { cwd: dir });
      const got = stdout.trim();
      return { ok: got === "15", detail: `expect.mjs 输出 "${got}"（期望 "15"）` };
    },
  },
  {
    id: "multi-step-refactor",
    files: {
      "lib/a.mjs": `export const NAME = "a";\nexport function greet() { return "hi from " + NAME; }\n`,
      "lib/b.mjs": `export const NAME = "b";\nexport function greet() { return "hi from " + NAME; }\n`,
      "lib/c.mjs": `export const NAME = "c";\nexport function greet() { return "hi from " + NAME; }\n`,
      "index.mjs": `import { greet as ga } from "./lib/a.mjs";
import { greet as gb } from "./lib/b.mjs";
console.log(ga(), gb());
`,
    },
    prompt:
      "把 lib/ 下三个文件里重复的 greet 实现抽到一个新文件 lib/greet.mjs（导出 greet(name) 返回 'hi from ' + name），" +
      "让 a/b/c 都改为导入它并用自己的 NAME 调用。" +
      "最后 index.mjs 要能打印 'hi from a hi from b'，用 node index.mjs 验证。",
    verify: async (dir) => {
      const greetSrc = await readFile(join(dir, "lib/greet.mjs"), "utf8").catch(() => null);
      if (greetSrc === null) return { ok: false, detail: "lib/greet.mjs 不存在" };

      /**
       * ⚠ 判定「是否去重」不能只看「还有没有 function greet」。
       *
       * ## 第一版判定器的误报（实测抓到的）
       *
       * 原判定用 `/function greet\(/` 匹配，若命中就判「未去重」。
       * 但 GLM-5.3 实际产出的**正确**做法是：
       *
       * ```js
       * import { greet as greetShared } from "./greet.mjs";
       * export const NAME = "a";
       * export function greet() { return greetShared(NAME); }
       * ```
       *
       * 它保留了 `greet()` 作为**对外包装** —— 这样 `index.mjs` 的
       * `import { greet as ga } from "./lib/a.mjs"` 接口不变，
       * 是**更稳妥**的重构（不破坏调用方）。
       *
       * ⇒ 判定器把「正确的包装」误判成「未去重」，冤枉了模型。
       *
       * ## 现在的判据（看实质，不看形式）
       *
       * 去重的本质是「**不再各自实现逻辑**，而是复用共享实现」。所以检查：
       *   ① 有没有从 ./greet.mjs 导入
       *   ② 有没有**调用**那个导入
       *   ③ 有没有**自己拼字符串**（`"hi from"` 之类的重复逻辑残留）
       *
       * 三条都对 = 真的去重了，不管它是否保留了同名包装函数。
       */
      /**
       * ⚠ 判定「是否去重」不能只看「还有没有 function greet」。
       *
       * ## 两次误报（都是实测抓到的，两次都是模型对、判定器错）
       *
       * **第一版**：用 `/function greet\(/` 匹配，命中就判「未去重」。
       * 但模型保留了 `greet()` 作对外包装 —— 这是**正确**的工程做法
       * （`index.mjs` 的导入接口不变）。误报。
       *
       * **第二版**：改为「必须调用导入的那个东西」，正则是
       * `/\bgreetShared\s*\(|\bgreet\s*\(/`。
       * 结果模型这次用了 `_greet` 作别名：
       *
       * ```js
       * import { greet as _greet } from "./greet.mjs";
       * function greet() { return _greet(NAME); }
       * ```
       *
       * 别名不在白名单里 ⇒ **再次误报**。
       *
       * **教训**：判定器**不能依赖模型自主选择的标识符名字**。
       * 名字是模型的自由，不是规格的一部分。
       *
       * ## 第三版（现在）：只看两件与命名无关的事实
       *
       *   ① 有没有从 `./greet.mjs` 导入 —— 要求源码里出现该模块路径
       *   ② 有没有**自己拼字符串** —— `"hi from"` 出现在 a/b/c 里
       *      就说明逻辑没抽走（真去重的话，拼字符串只应存在于 greet.mjs）
       *
       * 这两条都不看标识符名字，因此不会因别名而误报。
       * 「有没有真的调用」由**运行时行为**兜底 —— 最后那段
       * `node index.mjs` 必须输出正确结果，没调用就不可能对。
       */
      for (const f of ["a", "b", "c"]) {
        const src = await readFile(join(dir, `lib/${f}.mjs`), "utf8");
        if (!/from\s+["']\.\/greet\.mjs["']/.test(src)) {
          return { ok: false, detail: `lib/${f}.mjs 没有导入 ./greet.mjs` };
        }
        if (/["'`]hi from/.test(src)) {
          return {
            ok: false,
            detail: `lib/${f}.mjs 仍自己拼接 "hi from" 字符串（逻辑未抽走）`,
          };
        }
      }

      const { stdout } = await execFileAsync(process.execPath, ["index.mjs"], { cwd: dir });
      const got = stdout.trim();
      return {
        ok: got === "hi from a hi from b",
        detail: `index.mjs 输出 "${got}"（期望 "hi from a hi from b"）`,
      };
    },
  },
  {
    id: "debug-crash",
    files: {
      "app.mjs": `import { readFileSync } from "node:fs";

const configPath = new URL("./config.json", import.meta.url);
const config = JSON.parse(readFileSync(configPath, "utf8"));
console.log("port=" + config.port);
`,
    },
    prompt:
      "运行 node app.mjs 会报错。找出真正的原因并修好，让它打印出配置文件里的端口号。" +
      "注意：不要删掉读取配置这一步，配置本身要保留成文件。",
    verify: async (dir) => {
      const { stdout, stderr } = await execFileAsync(process.execPath, ["app.mjs"], { cwd: dir }).catch(
        (e) => ({ stdout: e.stdout ?? "", stderr: String(e.stderr ?? e.message) }),
      );
      const out = (stdout ?? "").trim();
      if (stderr && !out) return { ok: false, detail: `仍然报错：${String(stderr).slice(0, 200)}` };
      const m = out.match(/^port=(\d+)$/);
      if (!m) return { ok: false, detail: `输出 "${out}" 不符合 port=<数字>` };
      // 配置必须仍以文件形式存在
      const cfg = await readFile(join(dir, "config.json"), "utf8").catch(() => null);
      if (cfg === null) return { ok: false, detail: "config.json 被删掉了（要求保留成文件）" };
      let parsed;
      try {
        parsed = JSON.parse(cfg);
      } catch {
        return { ok: false, detail: "config.json 不是合法 JSON" };
      }
      return {
        ok: String(parsed.port) === m[1],
        detail: `打印 port=${m[1]}，config.json 里 port=${parsed.port}`,
      };
    },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// 驱动器
// ────────────────────────────────────────────────────────────────────────────

/** 造一个干净的项目目录，写入初始文件。 */
async function prepareTask(task) {
  const root = await mkdtemp(join(tmpdir(), `zcbench-${task.id}-`));
  const dir = join(root, "project");
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(task.files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { root, dir };
}

/**
 * 走 DSH 跑一个任务。
 *
 * 用 `dsh headless` —— 它会真正跑 agent 循环（含工具调用），
 * 是「DSH 里的能力」最直接的度量。
 *
 * ## Windows 特有的四个坑（全部实测踩过）
 *
 * ① **`spawn EINVAL`** —— `dsh` 是 `.CMD` 批处理包装器。
 *    Node 24 起 `execFile` 直接执行 `.CMD` 会报 EINVAL
 *    ⇒ 必须 `shell: true`。
 *
 * ② `--cwd` **不存在** —— 只有 `--json` / `--session-id` / `-h`。
 *    工作目录靠 `execFile` 的 `cwd` 选项传。
 *
 * ③ **中文任务描述会被 shell 编码毁掉**
 *    （实测现象：`multi-step-refactor` 只跑 69ms 就失败，
 *      输出里中文全是 `??????`，而英文任务正常）。
 *    根因：任务文本经 `cmd.exe` 传递时，活动代码页（GBK/936）
 *    与 UTF-8 不一致，中文被替换成 `?`，模型收到的是乱码指令。
 *
 *    ⇒ **改成 stdin 传递**。`dsh headless` 支持 `-` 表示「从 stdin 读」。
 *      这样完全绕开命令行编码，走管道（UTF-8 原生）。
 *
 * ④ `shell: true` 会触发 DEP0190 警告（参数未转义）。
 *    改用 stdin 后不再需要 shell —— 但也就不需要担心转义了。
 */
async function runViaDsh(task, dir) {
  const dsh = join(
    process.env.APPDATA ?? "",
    "in.dsh-plug.dsh-launcher/versions/0.1.7-rc.2/node_modules/.bin/dsh.CMD",
  );
  const started = Date.now();

  /**
   * 用 `cmd.exe /d /s /c` 显式启动 `.CMD`，并把编码切到 UTF-8
   * （`chcp 65001`），再把任务文本**从 stdin 喂进去**。
   *
   * 三个措施的用途各不相同：
   *   · `cmd.exe /c`     —— 解决 ①（能执行 .cmd）
   *   · `chcp 65001`     —— 解决 ③ 的输出侧乱码
   *   · stdin 传任务      —— 解决 ③ 的输入侧乱码（关键）
   *
   * ⚠ `dsh` 路径**不能加引号**：`cmd /s /c` 对引号的处理有反直觉的
   *   规则（`/s` 会剥掉首尾引号），实测加引号后报
   *   「'\"...dsh.CMD\"' 不是内部或外部命令」。该路径无空格，直接放。
   */
  const res = await new Promise((resolve) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `chcp 65001>nul && ${dsh} headless -`], {
      cwd: dir,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => resolve({ stdout, stderr: stderr + String(e.message) }));
    child.on("close", () => resolve({ stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill();
      stderr += "\n[bench] timeout after 600s";
    }, 600_000);
    child.on("close", () => clearTimeout(timer));
    // 用 UTF-8 写任务文本，末尾补换行让 `-` 的读取能结束
    child.stdin.end(`${task.prompt}\n`, "utf8");
  });

  return {
    elapsedMs: Date.now() - started,
    output: `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim(),
  };
}

/** 主流程。 */
async function main() {
  const args = process.argv.slice(2);
  const via = args.includes("--via") ? args[args.indexOf("--via") + 1] : "dsh";
  const only = args.includes("--task") ? args[args.indexOf("--task") + 1] : undefined;

  const tasks = only ? TASKS.filter((t) => t.id === only) : TASKS;
  const results = [];

  for (const task of tasks) {
    const { root, dir } = await prepareTask(task);
    process.stderr.write(`\n▶ ${task.id}（via ${via}）\n`);
    let run;
    try {
      run = via === "dsh" ? await runViaDsh(task, dir) : { elapsedMs: 0, output: "" };
    } catch (e) {
      run = { elapsedMs: 0, output: `driver error: ${e.message}` };
    }
    let verdict;
    try {
      verdict = await task.verify(dir);
    } catch (e) {
      verdict = { ok: false, detail: `verify threw: ${e.message}` };
    }
    results.push({
      id: task.id,
      via,
      ok: verdict.ok,
      detail: verdict.detail,
      elapsedMs: run.elapsedMs,
      outputTail: run.output.slice(-400),
    });
    process.stderr.write(`  ${verdict.ok ? "✓" : "✗"} ${verdict.detail}  (${run.elapsedMs}ms)\n`);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * 结果落盘 —— 用 `--out <path>` 指定。
   *
   * ⚠ 不要用 PowerShell 的 `Tee-Object` 重定向：它会把 **stderr 也混进
   * 文件**（实测：进度行 `▶ ...` 和 JSON 交错，导致 JSON 解析失败）。
   * 由 runner 自己写文件，保证内容纯净。
   */
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1] !== undefined) {
    await writeFile(args[outIdx + 1], JSON.stringify({ via, results }, null, 2), "utf8");
  }

  console.log(JSON.stringify({ via, results }, null, 2));
  const passed = results.filter((r) => r.ok).length;
  process.stderr.write(`\n合计 ${passed}/${results.length} 通过\n`);
  process.exit(passed === results.length ? 0 : 1);
}

/**
 * ⚠ 只有**被直接执行**时才跑主流程。
 *
 * 第一版无条件调用 `main()`，结果 `selftest.mjs` 一 `import` 它，
 * 就顺带把整个基准跑了一遍（现象：自检输出里混进了 runner 的进度行）。
 * 用 `import.meta.url` 与 `process.argv[1]` 比对来区分两种入口。
 */
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
