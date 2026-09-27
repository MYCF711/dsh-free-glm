// 解析器单元验证：正例必须命中，反例（普通回复）必须不命中。
import { parseToolCalls, stripToolFences, renderToolInstructions } from "../lib/tool-bridge.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      实际: ${JSON.stringify(actual)}\n      期望: ${JSON.stringify(expected)}`); }
}

console.log("── 正例：必须命中 ──");
check("标准围栏", parseToolCalls('```json\n{"tool":"list_dir","arguments":{"path":"D:\\\\x"}}\n```'),
  [{ name: "list_dir", arguments: '{"path":"D:\\\\x"}' }]);

check("带自然语言前缀", parseToolCalls('我来看一下目录。\n\n```json\n{"tool":"list_dir","arguments":{"path":"."}}\n```'),
  [{ name: "list_dir", arguments: '{"path":"."}' }]);

check("两个围栏 = 两个调用", parseToolCalls('```json\n{"tool":"a","arguments":{}}\n```\n```json\n{"tool":"b","arguments":{"x":1}}\n```'),
  [{ name: "a", arguments: "{}" }, { name: "b", arguments: '{"x":1}' }]);

check("兼容 name 字段", parseToolCalls('```json\n{"name":"read_file","arguments":{"p":"x"}}\n```'),
  [{ name: "read_file", arguments: '{"p":"x"}' }]);

check("无参数省略 arguments", parseToolCalls('```json\n{"tool":"get_time"}\n```'),
  [{ name: "get_time", arguments: "{}" }]);

check("大写 JSON 标记", parseToolCalls('```JSON\n{"tool":"t","arguments":{}}\n```'),
  [{ name: "t", arguments: "{}" }]);

check("无语言标记的围栏", parseToolCalls('```\n{"tool":"t","arguments":{}}\n```'),
  [{ name: "t", arguments: "{}" }]);

console.log("── 反例：绝不能命中 ──");
check("纯自然语言", parseToolCalls("好的，我来帮你查看这个文件。"), []);
check("普通 json 围栏无 tool 字段", parseToolCalls('```json\n{"path":"D:\\\\x","size":10}\n```'), []);
check("json 围栏是数组", parseToolCalls('```json\n[{"tool":"t"}]\n```'), []);
check("json 语法错误", parseToolCalls('```json\n{"tool": broken}\n```'), []);
check("代码围栏是别的语言", parseToolCalls('```python\nprint("hi")\n```'), []);
check("tool 是空串", parseToolCalls('```json\n{"tool":"  ","arguments":{}}\n```'), []);

console.log("── stripToolFences：摘掉协议噪音、保留人话 ──");
check("摘围栏留人话", stripToolFences('我来看一下。\n\n```json\n{"tool":"a","arguments":{}}\n```'), "我来看一下。");
check("纯围栏 → 空串", stripToolFences('```json\n{"tool":"a","arguments":{}}\n```'), "");
check("非工具围栏必须保留", stripToolFences('示例：\n```json\n{"path":"x"}\n```'), '示例：\n```json\n{"path":"x"}\n```');
check("无围栏原样返回", stripToolFences("就是一句普通回复"), "就是一句普通回复");

console.log("── renderToolInstructions ──");
check("无工具 → 空串", renderToolInstructions([]), "");
const rendered = renderToolInstructions([
  { name: "read_file", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
]);
const hasName = rendered.includes("read_file");
const hasDesc = rendered.includes("读取文件");
const hasSchema = rendered.includes('"path"');
const hasProtocol = rendered.includes('{"tool":"<工具名>"');
check("含工具名/描述/schema/协议", [hasName, hasDesc, hasSchema, hasProtocol], [true, true, true, true]);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
