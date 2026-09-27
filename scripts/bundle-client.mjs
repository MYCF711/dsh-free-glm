#!/usr/bin/env node
/**
 * 把 tsc 产出的 ESM 客户端模块内联成 DSH 客户端 bundle。
 *
 * ## 为什么需要这一步
 *
 * DSH 的 web 前端**不用原生 ESM 加载插件客户端**。它要求客户端入口是一个
 * 自注册 bundle：顶层调用
 *
 *     window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => ... })
 *
 * 由 `factory` 返回模块导出。宿主加载完文件后会检查是否注册过该 id：
 *
 *     `${url}: loaded without registering "${id}" via __ModuleLoader__.load`
 *
 * 没注册 → 该 entry 拿不到 fiber → boot 报
 * `dsh-xxx: import failed (see console for the import error)`。
 *
 * tsc 直接输出的裸 ESM 不会被 loader 认领，所以必须有这一步。
 *
 * ## 为什么不用打包器
 *
 * 客户端源码没有任何外部依赖（只有同目录的相对 import），把相对 import
 * 内联、去掉 ESM 关键字即可，无需引入 rolldown/tsdown/esbuild。
 * 若将来客户端要 import 宿主包，本脚本会直接报错退出 —— 那时才需要
 * 换成真打包器，并把宿主包名前缀写进 `exports`/`dsh.client.inject`。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientDir = join(root, "lib", "client");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** 内联顺序：被依赖的排前面。 */
const MODULES = ["model-toggles.js", "index.js"];

/** 需要挂到 bundle `exports` 上的名字（cordis 插件契约：apply / inject）。 */
const EXPORT_NAMES = ["name", "inject", "apply"];

/** 去掉 sourceMappingURL、内联相对 import、剥掉 ESM 关键字。 */
function stripEsm(source, file) {
	let out = source.replace(/^[ \t]*\/\/#[ \t]*sourceMappingURL=.*$/gm, "");

	// 相对 import 的模块已在同一 bundle 内，直接删除；外部依赖无处解析，报错。
	out = out.replace(/^[ \t]*import\s[\s\S]*?from\s*["']([^"']+)["'];?[ \t]*$/gm, (_match, spec) => {
		if (spec.startsWith(".")) return "";
		throw new Error(
			`${file}: 客户端入口引用了外部模块 ${spec}。` +
				`本内联脚本不提供模块解析器，请改用真正的打包器并把宿主包写进 dsh.client.inject。`,
		);
	});

	// 本插件不使用 `export { ... }` / `export default`；出现即视为需要人工处理。
	if (/^[ \t]*export\s*\{/.test(out) || /^[ \t]*export\s+default\b/m.test(out)) {
		throw new Error(`${file}: 出现了 export {} / export default，本内联脚本不支持。`);
	}

	// `export const x` → `const x`，`export async function f` → `async function f`
	out = out.replace(
		/^([ \t]*)export\s+(?=(?:const|let|var|function|class|async[ \t]+function)\b)/gm,
		"$1",
	);

	const left = out.match(/^[ \t]*(?:import|export)\s/m);
	if (left !== null) throw new Error(`${file}: 仍有未处理的 ESM 语句：${left[0].trim()}`);

	return out.replace(/\s+$/, "");
}

const regions = [];
for (const name of MODULES) {
	const source = await readFile(join(clientDir, name), "utf8");
	regions.push(`\t\t//#region lib/client/${name}\n${stripEsm(source, name)}`);
}

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\t"use strict";
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${regions.join("\n")}
${EXPORT_NAMES.map((key) => `\t\texports.${key} = ${key};`).join("\n")}
\t\treturn module.exports;
\t}
});
`;

const target = join(root, "lib", "client.js");
await writeFile(target, bundle, "utf8");
process.stdout.write(`[bundle-client] wrote ${target} (${Buffer.byteLength(bundle)} bytes)\n`);
