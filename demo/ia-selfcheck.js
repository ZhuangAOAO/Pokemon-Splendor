// 大厅 IA 原型自检脚本（node demo/ia-selfcheck.js）
// 只读检查，不修改任何文件：标签配对 / 括号平衡 / 关键约束抽查
const fs = require("fs");
const path = require("path");
const files = ["lobby-plan-a.html", "lobby-plan-b.html", "lobby-plan-c.html"];
let allOK = true;

for (const name of files) {
  const f = path.join(__dirname, name);
  const s = fs.readFileSync(f, "utf8");
  const out = [];
  // 1) 标签配对：开标签计数必须等于闭合标签计数（"<tag\b" 不会匹配 "</tag>"）
  for (const tag of ["section", "div", "button", "script", "style", "aside", "main", "header", "nav", "span", "form"]) {
    const open = (s.match(new RegExp("<" + tag + "\\b", "g")) || []).length;
    const close = (s.match(new RegExp("</" + tag + ">", "g")) || []).length;
    if (open !== close) allOK = false;
    out.push(tag + ":" + open + "/" + close + (open === close ? " OK" : " FAIL"));
  }
  // 2) 括号平衡
  const braces = (s.match(/\{/g) || []).length === (s.match(/\}/g) || []).length;
  const parens = (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;
  if (!braces || !parens) allOK = false;
  // 3) 关键约束抽查
  const hasReducedMotion = s.includes("prefers-reduced-motion");
  const hasNavArray = s.includes("const NAV");
  const hasExtComment = s.includes("第 6");
  if (!hasReducedMotion || !hasNavArray || !hasExtComment) allOK = false;
  console.log(f);
  console.log("  " + out.join("  "));
  console.log("  braces:" + (braces ? "OK" : "FAIL") + "  parens:" + (parens ? "OK" : "FAIL")
    + "  prefers-reduced-motion:" + (hasReducedMotion ? "OK" : "FAIL")
    + "  const-NAV:" + (hasNavArray ? "OK" : "FAIL") + "  第6项扩展注释:" + (hasExtComment ? "OK" : "FAIL"));
}
console.log(allOK ? "ALL PASS" : "HAS FAILURE");
process.exit(allOK ? 0 : 1);
