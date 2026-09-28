/**
 * 验证「切换 Tab 时下面的内容跟着换」。
 *
 * 做法：用 jsdom 加载 builder.html，构造
 *     tabbar(bind=t1) + tabpanel(bind=t1,idx=0) + tabpanel(bind=t1,idx=1)
 * 然后模拟点击第二个 tab，检查两个面板的显隐是否互换。
 *
 * 这是针对用户报的 bug 的直接回归测试。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// jsdom 装在 _jsh/ 下（不在本目录）—— 用 createRequire 指过去
const require = createRequire("D:/zcode-glm5.3f/_jsh/");
const { JSDOM } = require("jsdom");

const html = await readFile("D:/zcode-glm5.3f/builder.html", "utf8");

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

await new Promise((r) => setTimeout(r, 300));

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
};

// ── 1. 面板能拖进画布并放进容器 ──────────────────────────────────
// 直接构造数据：通过页面的内部函数把元素塞进 els
const win = window;
check("页面暴露了 els 数组", Array.isArray(win.els) || typeof win.draw === "function");

console.log("\n── 构造 tabbar + 两个 tabpanel ──");

/**
 * 直接调用页面内部函数构造结构。
 * 若这些符号没暴露在 window 上（因为 script 是顶层 let/const），
 * 就退回「模拟拖拽」的方式 —— 但更可靠的是用页面的 addEl / els。
 */
const api = {
  els: win.els,
  draw: win.draw,
  renderEl: win.renderEl,
};

if (!api.els) {
  console.log("⚠ 内部符号未暴露到 window（script 用 let/const 在模块作用域）");
  console.log("  改用：直接执行页面脚本上下文里的代码来构造");
}

// ── 2. 用 DOM 层面直接验证联动逻辑 ──────────────────────────────
// 找到左侧组件面板里的 tabpanel 项并双击加入画布
const paletteTabbar = $('.li[data-k="tabbar"]');
const palettePanel = $('.li[data-k="tabpanel"]');
check("左侧有 Tab 项", paletteTabbar !== null);
check("左侧有 Tab 内容面板项", palettePanel !== null);

console.log("\n── 直接在页面上下文里构造结构 ──");

/**
 * 拖拽模拟在 jsdom 里不可靠 —— **jsdom 没有真实布局引擎**，
 * 所有 `getBoundingClientRect()` 都返回 0，而 builder 的落点判定
 * 依赖真实矩形（`rectHit`）。所以「拖入 0 个」不是 bug，是测试环境限制。
 *
 * 改为**在页面脚本的作用域里直接调用内部函数**。
 * 页面用的是顶层 `let/const`（模块作用域，不挂在 window 上），
 * 所以用 `window.eval` 在同作用域里执行 —— jsdom 的 eval 能看到
 * 顶层 let/const 声明。
 */
const setup = () => {
  const w = window;
  // 清空画布
  if (typeof w.els !== "undefined") w.els.length = 0;
  // 造 tabbar + 两个 panel
  const tb = { id: "eTB", kind: "tabbar", props: { items: ["模型", "账号管理"], active: 0, bind: "t1" } };
  const p0 = { id: "eP0", kind: "tabpanel", props: { bind: "t1", idx: 0, children: [] } };
  const p1 = { id: "eP1", kind: "tabpanel", props: { bind: "t1", idx: 1, children: [] } };
  w.els.push(tb, p0, p1);
  w.draw();
};

// 先探测内部符号能不能通过 eval 访问
const probe = window.eval("typeof els + '|' + typeof draw + '|' + typeof tabState");
console.log(`  内部符号可见性: ${probe}`);

const symbolsOk = probe.startsWith("object|function");
check("能通过 eval 访问页面内部符号", symbolsOk, probe);

if (symbolsOk) {
  window.eval(`
    els.length = 0;
    els.push({ id:"eTB", kind:"tabbar", props:{ items:["模型","账号管理"], active:0, bind:"t1" } });
    els.push({ id:"eP0", kind:"tabpanel", props:{ bind:"t1", idx:0, children:[] } });
    els.push({ id:"eP1", kind:"tabpanel", props:{ bind:"t1", idx:1, children:[] } });
    draw();
  `);
  await new Promise((r) => setTimeout(r, 120));
}

let tabbars = $$('#root .tabbar');
let panels = $$('#root .r-panel');
check("画布上有 1 个 tabbar", tabbars.length === 1, `实际 ${tabbars.length}`);
check("画布上有 2 个 tabpanel", panels.length === 2, `实际 ${panels.length}`);

if (panels.length === 2) {
  console.log("\n── 初始显隐（应只有 idx=0 可见）──");

  /**
   * ⚠ 不要用 `panels.indexOf(visible0[0])` 做后续比较。
   *
   * 第一版这么写了，结果打印出 `#-1` —— 因为 `draw()` 会**重建 DOM**，
   * 之前抓到的 `panels` 节点已经不在文档里了，`indexOf` 自然找不到。
   *
   * 改为每次重新查询，并用 **DOM 顺序下标 + 组件 id** 两个维度判断。
   * 组件 id 是稳定的（`data-eid`），不受重建影响。
   */
  const visibleNow = () => {
    const list = $$('#root .r-panel');
    return list.filter((p) => !p.style.display || p.style.display !== "none");
  };
  const idOf = (node) => (node ? node.dataset.eid : "<无>");

  const v0 = visibleNow();
  check("初始只有 1 个面板可见", v0.length === 1, `实际 ${v0.length}`);
  const firstVisibleId = idOf(v0[0]);
  console.log(`    初始可见面板 = ${firstVisibleId}`);

  console.log("\n── 点击第二个 Tab ──");
  let tabs = $$('#root .tabbar span[data-tab]');
  check("tabbar 有 2 个 tab 项", tabs.length === 2, `实际 ${tabs.length}`);
  if (tabs.length === 2) {
    tabs[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));

    const v1 = visibleNow();
    check("点击后仍只有 1 个面板可见", v1.length === 1, `实际 ${v1.length}`);
    check("切换后可见的是另一个面板", idOf(v1[0]) !== firstVisibleId,
      `${firstVisibleId} → ${idOf(v1[0])}`);

    const onTab = $$('#root .tabbar span.on')[0];
    check("下划线落在第二个 tab 上", onTab && onTab.dataset.idx === "1",
      onTab ? `idx=${onTab.dataset.idx}` : "无 .on");

    console.log("\n── 再点回第一个 Tab ──");
    tabs = $$('#root .tabbar span[data-tab]');   // 重新查询（DOM 已重建）
    tabs[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));

    const v2 = visibleNow();
    check("点回后可见面板换回原来那个", idOf(v2[0]) === firstVisibleId,
      `期望 ${firstVisibleId}，实际 ${idOf(v2[0])}`);
    const onTab2 = $$('#root .tabbar span.on')[0];
    check("下划线回到第一个 tab", onTab2 && onTab2.dataset.idx === "0",
      onTab2 ? `idx=${onTab2.dataset.idx}` : "无 .on");
  }
}

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
process.exit(failed === 0 ? 0 : 1);
