/**
 * 回归测试：用户报的两个可用性缺陷。
 *
 *   ① 容器太小，拖不进去 —— 只能插在容器上方或下方
 *   ② Tab 需要一个绑定的容器（应自动配套）
 *
 * 做法：jsdom 加载 builder.html，直接构造结构并断言。
 * ⚠ jsdom 没有布局引擎，`getBoundingClientRect` 全是 0，
 *   所以**不能**测真实几何命中 —— 这里测的是：
 *     · 自动配套面板是否创建（纯数据逻辑，可测）
 *     · 空面板是否标明所属 Tab（纯渲染逻辑，可测）
 *     · CSS 里容器最小高度是否已放大（文本断言）
 *   真实几何命中由 AutoGLM 在真实浏览器里验证。
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire("D:/zcode-glm5.3f/_jsh/");
const { JSDOM } = require("jsdom");

const FILE = "D:/zcode-glm5.3f/builder.html";
const html = await readFile(FILE, "utf8");

let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
};

// ── A. CSS 断言（纯文本，不需要浏览器）──────────────────────────
console.log("── A. 容器尺寸（修 ① 的基础）──");

/** 从 CSS 里抽某条规则的属性值。 */
const ruleOf = (selector) => {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
  );
  const m = html.match(re);
  return m ? m[1] : "";
};
const minHeightOf = (sel) => {
  const m = ruleOf(sel).match(/min-height:\s*(\d+)px/);
  return m ? Number(m[1]) : 0;
};

/**
 * ⚠ 阈值随**有意的设计决定**更新（2026-09-28 二次修正）。
 *
 * 第一版断言「≥ 48px」，因为我当时把 32 提到 56 就以为够了。
 * 用户指出本质：「容器本来就要装很多东西」——
 * 尺寸不该按「最小可用」定，而应按**内容驱动**。
 *
 * 所以现在断言 **≥ 100px**（实际 112px，约 4 个按钮高）。
 * 把阈值贴着实际值写，才能在有人把它改小时立刻报警 ——
 * 断言太松等于没断言。
 */
const rowMin = minHeightOf(".rowbox");
const colMin = minHeightOf(".colbox");
const panelMin = minHeightOf(".r-panel");

check(".rowbox 最小高度 ≥ 100px", rowMin >= 100, `实际 ${rowMin}px`);
check(".colbox 最小高度 ≥ 100px", colMin >= 100, `实际 ${colMin}px`);
check(".r-panel 最小高度 ≥ 100px", panelMin >= 100, `实际 ${panelMin}px`);

const rowPad = (ruleOf(".rowbox").match(/padding:\s*(\d+)px/) ?? [0, 0])[1];
check(".rowbox padding ≥ 10px", Number(rowPad) >= 10, `实际 ${rowPad}px`);

/* 容器必须是 `min-height` 而非固定 `height` —— 否则装不下第 4 个元素。
   这是个容易被"优化"掉的性质，值得单独钉住。 */
check("容器用 min-height（不是固定 height）",
  /min-height:\s*\d+px/.test(ruleOf(".rowbox")) && !/[^-]height:\s*\d+px/.test(ruleOf(".rowbox")),
  ruleOf(".rowbox").replace(/\s+/g, " ").trim());

/* tabpanel 必须声明为容器，否则往面板里拖东西会掉到别处 */
check("tabpanel 渲染时带 data-container",
  /class="r-panel"\s+data-container="1"/.test(html));

check(
  "存在拖拽中的容器高亮规则",
  html.includes("body.dragging .rowbox") && html.includes("body.dragging .colbox"),
);

// ── B. 命中宽容度 ──────────────────────────────────────────────
console.log("\n── B. 容器命中宽容度 ──");
const padMatch = html.match(/CONTAINER_PAD\s*=\s*(\d+)/);
check("CONTAINER_PAD 存在且 ≥ 8", padMatch !== null && Number(padMatch[1]) >= 8,
  padMatch ? `${padMatch[1]}px` : "未找到");
check("容器命中调用了带 pad 的 rectHit",
  /rectHit\(b,\s*x,\s*y,\s*CONTAINER_PAD\)/.test(html));

// ── C. 运行时：自动配套面板 ────────────────────────────────────
console.log("\n── C. Tab 自动配套面板（修 ②）──");

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
const { window } = dom;
await new Promise((r) => setTimeout(r, 300));
const { document } = window;

// 初始卡片：应有一个 tabbar + 两个 panel（bind 指向该 tabbar）
const initialTabbars = document.querySelectorAll("#root .tabbar");
const initialPanels = document.querySelectorAll("#root .r-panel");
check("初始卡片含 1 个 tabbar", initialTabbars.length === 1, `实际 ${initialTabbars.length}`);
check("初始卡片含 2 个 panel（配套）", initialPanels.length === 2, `实际 ${initialPanels.length}`);

/**
 * ⚠ 初始卡片的面板是**有内容的**（不是我用来测占位提示的空面板）。
 * 第一版断言直接检查 textContent 里有没有「模型」两字 ——
 * 结果它有内容（`剩余额度 3.0M/5.0M ...`），占位提示根本不显示，
 * 于是误判为失败。**是测试写错了，不是代码错了。**
 *
 * 要测「空面板标所属 Tab」，得**专门建一个空面板**再检查。
 */
/**
 * 要测「空面板标所属 Tab」，得**专门建一个空面板**再检查。
 *
 * ⚠ 第一版这里把 `bind` 指向了「初始卡片里那个 tabbar 的 id」，
 *   同时又用 `id:"tX"` 新建了一个 tabbar —— 但 `findEl` 是按 **id** 查找的，
 *   `bind` 指向的旧 tabbar 已被替换掉 ⇒ 查不到 ⇒ 退回通用提示。
 *
 *   **这暴露一个真实的健壮性问题**：`bind` 指向不存在的 tabbar 时，
 *   面板只说「把内容拖进来」，用户无从知道该绑到谁。
 *   已在 `renderEl` 里加了兜底提示（明确写出未绑定 + 怎么修）。
 *
 * 现在用**自洽**的结构测：新 tabbar 的 id 与面板的 bind 一致。
 */
const emptyHint = window.eval(
  [
    "(() => {",
    "  const saved = JSON.parse(JSON.stringify(els));",
    '  const myTabId = "tX";',
    "  els = [",
    '    { id: myTabId, kind: "tabbar", props: { items: ["模型","账号管理"], active: 0, bind: myTabId } },',
    '    { id: "pX", kind: "tabpanel", props: { bind: myTabId, idx: 0, children: [] } },',
    '    { id: "pY", kind: "tabpanel", props: { bind: myTabId, idx: 1, children: [] } },',
    "  ];",
    "  draw();",
    '  const texts = Array.from(document.querySelectorAll("#root .r-panel")).map(p => p.textContent.trim());',
    "  els = saved; draw();",
    "  return texts;",
    "})()",
  ].join("\n"),
);
console.log("  空面板提示: " + JSON.stringify(emptyHint));
check(
  "空面板标明所属 Tab",
  emptyHint.some((t) => t.includes("模型")) && emptyHint.some((t) => t.includes("账号管理")),
  JSON.stringify(emptyHint),
);

// ── D. 新增 tabbar 时自动生成面板 ──────────────────────────────
console.log("\n── D. 拖入 tabbar 时自动建面板 ──");

check(
  "源码实现了「拖入 tabbar 自动建面板」",
  /if \(dragKind === "tabbar"\)/.test(html) && /panel\.props\.bind = n\.id/.test(html),
);

/**
 * 行为验证：走一次真实的 drop 路径。
 *
 * ⚠ 第一次没设 `isDragging = true` —— 而 `onUp` 开头就有
 *   `if (!isDragging) { ...当作点击...; return; }`，
 *   所以它直接 return、什么结构都没改，测试看到空数组。
 *   **是测试漏了前置状态，不是自动配套没实现。**
 */
const dropResult = window.eval(`(() => {
  els.length = 0;
  tabState = {};
  dragKind = "tabbar";
  dragId = null;
  dragFromContainer = true;
  isDragging = true;          /* ← 关键：模拟"真的拖动过" */
  dropTarget = "__root__";
  dropPos = null;
  onUp({ clientX: 0, clientY: 0, target: null });
  return {
    kinds: els.map(e => e.kind),
    binds: els.filter(e => e.kind === "tabpanel").map(e => e.props.bind),
    idxs:  els.filter(e => e.kind === "tabpanel").map(e => e.props.idx),
    tabId: els.find(e => e.kind === "tabbar")?.id,
  };
})()`);

console.log("  拖入后结构: " + JSON.stringify(dropResult));
check("自动建了 2 个 panel", dropResult.kinds.filter((k) => k === "tabpanel").length === 2,
  JSON.stringify(dropResult.kinds));
check("panel 的 bind 指向该 tabbar",
  dropResult.binds.length === 2 && dropResult.binds.every((b) => b === dropResult.tabId),
  `binds=${JSON.stringify(dropResult.binds)} tabId=${dropResult.tabId}`);
check("panel 的 idx 依次为 0,1",
  JSON.stringify(dropResult.idxs) === "[0,1]", JSON.stringify(dropResult.idxs));
check("结构顺序是 tabbar 在前、面板紧随",
  dropResult.kinds[0] === "tabbar" && dropResult.kinds.slice(1).every((k) => k === "tabpanel"),
  JSON.stringify(dropResult.kinds));

// ── E. 拖拽标记 ────────────────────────────────────────────────
console.log("\n── E. 拖拽中的视觉提示 ──");
check("ensureGhost 里加了 body.dragging", /document\.body\.classList\.add\("dragging"\)/.test(html));
check("clearMarks 里移除了 body.dragging", /document\.body\.classList\.remove\("dragging"\)/.test(html));

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
process.exit(failed === 0 ? 0 : 1);
