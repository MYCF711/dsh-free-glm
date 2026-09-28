/**
 * 真实浏览器验证：**能不能真的把组件拖进容器**（用户最初报的 bug）。
 *
 * ## 为什么单靠前面的测试不够
 *
 * `verify-real-geometry.mjs` 量的是「容器够不够大」，
 * 但**没验证拖放交互本身**。用户的原话是
 * 「按钮拖不进去，只能插入在容器的上方或者下方」——
 * 这是个**端到端**问题，必须真的模拟一次拖拽才算验证。
 *
 * ## 做法
 *
 * 用 CDP 的 `Input.dispatchMouseEvent` 发真实鼠标事件：
 *   1. 在左栏某个组件上按下（PointerEvent，因为 builder 用 pointerdown）
 *   2. 移动若干步（超过 4px 阈值）
 *   3. 落到**容器正中**
 *   4. 检查该组件是否进了容器的 children
 *
 * ⚠ CDP 的 `dispatchMouseEvent` 发的是 **mouse** 事件，
 *   而 builder 监听 `pointerdown`。Chromium 会为鼠标事件合成
 *   pointer 事件，所以能触发 —— 但这是**实测要确认的点**，
 *   不能想当然。
 *
 * 用法：node bench/verify-real-drag.mjs [cdp端口]
 */

const PORT = process.argv[2] ?? "9466";
const CDP = `http://127.0.0.1:${PORT}`;
const URL = "http://127.0.0.1:8899/builder.html?v=realdrag";

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const q = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const ev = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, timeout: 60_000,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
  return r.result?.value;
};

await cdp.send("Page.navigate", { url: URL });
await new Promise((r) => setTimeout(r, 3500));

let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
};

/**
 * 发一次「按下 → 移动 → 抬起」的真实鼠标拖拽。
 *
 * ⚠ 必须**分多步移动**：builder 有 4px 阈值（未超过就当点击）。
 *   一次跳到位在某些实现里可能被识别为"没移动"。
 */
async function dragTo(from, to) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1, buttons: 1,
  });
  await new Promise((r) => setTimeout(r, 60));
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "left", buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 250));
}

// ── 准备：一个干净的 col 容器 ─────────────────────────────────
console.log("── 准备：只放一个空 col 容器 ──");
await ev(`(() => {
  els.length = 0;
  els.push({ id: "cTarget", kind: "col", props: { gap: 6, children: [] } });
  draw();
})()`);
await new Promise((r) => setTimeout(r, 300));

const setup = await ev(`(() => {
  const box = document.querySelector('.colbox').getBoundingClientRect();
  const li = document.querySelector('.li[data-k="btn"]');
  const lr = li.getBoundingClientRect();
  return {
    containerCenter: { x: Math.round(box.left + box.width/2), y: Math.round(box.top + box.height/2) },
    paletteBtn: { x: Math.round(lr.left + lr.width/2), y: Math.round(lr.top + lr.height/2) },
    childCount: document.querySelectorAll('.colbox > .el').length,
  };
})()`);
console.log("  " + JSON.stringify(setup));
check("初始容器为空", setup.childCount === 0, `${setup.childCount}`);

// ── 拖拽 ──────────────────────────────────────────────────────
console.log("\n── 从左栏拖「按钮」到容器正中 ──");
console.log(`  ${JSON.stringify(setup.paletteBtn)} → ${JSON.stringify(setup.containerCenter)}`);
await dragTo(setup.paletteBtn, setup.containerCenter);

const after = await ev(`(() => {
  const col = document.querySelector('.colbox');
  const kids = col ? col.querySelectorAll(':scope > .el') : [];
  return {
    childCount: kids.length,
    childKinds: Array.from(kids).map(k => k.querySelector('.r-b') ? 'btn' : 'other'),
    // 顶层是否有游离的按钮（若有说明落到了根上，而不是容器里）
    topLevelBtn: document.querySelectorAll('#root > .el > .r-b').length,
    elsKinds: els.map(e => e.kind),
    containerChildren: (els.find(e => e.kind === 'col')?.props?.children ?? []).length,
  };
})()`);
console.log("  " + JSON.stringify(after));

check("组件落进了容器（DOM 层面）", after.childCount === 1, `容器内 ${after.childCount} 个子元素`);
check("组件落进了容器（数据层面）", after.containerChildren === 1, `children=${after.containerChildren}`);
check("没有掉到根上", after.topLevelBtn === 0, `根级按钮 ${after.topLevelBtn} 个`);

// ── 再拖一个，验证能装多个 ────────────────────────────────────
console.log("\n── 再拖一个（验证能装多个）──");
await dragTo(setup.paletteBtn, setup.containerCenter);
const after2 = await ev(`(() => {
  const col = document.querySelector('.colbox');
  const r = col.getBoundingClientRect();
  return {
    childCount: col.querySelectorAll(':scope > .el').length,
    height: Math.round(r.height),
    children: (els.find(e => e.kind === 'col')?.props?.children ?? []).length,
  };
})()`);
console.log("  " + JSON.stringify(after2));
check("容器里有 2 个组件", after2.childCount === 2, `${after2.childCount}`);

/**
 * ⚠ 不要断言「2 个元素时容器变高」（2026-09-28 实测纠正）。
 *
 * 第一版这么断言，结果失败 —— 但**不是 bug**：
 *   按钮约 30px 高、gap 6px，2 个元素只需
 *   `30*2 + 6 + padding 28 ≈ 94px`，**放得进 112px**，
 *   所以高度本就不该变。
 *
 * 要验证「随内容增长」，得塞到**超过 112px** 才看得出。
 * 这里改成塞 8 个 —— 8*30 + 7*6 + 28 ≈ 310px，必然超出。
 *
 * （前面 `verify-real-geometry.mjs` 的 1b 已用 6 个验证过 112 → 261px，
 *   这里作为端到端链路的补充再确认一次。）
 */
console.log("\n── 塞到超出默认高度，验证会增长 ──");
const grown = await ev(`(() => {
  const kids = [];
  for (let i = 1; i <= 8; i++) kids.push({ id: "grow"+i, kind: "btn", props: { text: "按钮"+i, variant: "default" } });
  const col = els.find(e => e.kind === 'col');
  col.props.children = kids;
  draw();
  const r = document.querySelector('.colbox').getBoundingClientRect();
  const last = document.querySelectorAll('.colbox > .el');
  return {
    height: Math.round(r.height),
    rendered: last.length,
    // 最后一个元素是否还在容器矩形内（没被裁掉）
    lastBottomInside: last.length > 0
      ? Math.round(last[last.length-1].getBoundingClientRect().bottom) <= Math.round(r.bottom) + 1
      : false,
  };
})()`);
console.log("  " + JSON.stringify(grown));
check("8 个元素时容器变大（超 112px）", grown.height > 112, `${grown.height}px`);
check("8 个元素全部渲染", grown.rendered === 8, `${grown.rendered}`);
check("最后一个元素没被裁出容器", grown.lastBottomInside === true);

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
