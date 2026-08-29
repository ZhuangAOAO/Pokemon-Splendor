/* ================================================================
   图片命名检查工具
   用法：node 检查图片.js
   功能：
   1. 根据 config.js 的卡牌表，生成「图片命名对照表.txt」（80 个名字清单）
   2. 扫描 pictures/ 文件夹，报告：
      · 已正确命名 X / 80 张
      · 缺失哪些宝可梦的图片（卡牌会显示默认精灵球占位图）
      · 多余的文件（未按规则命名；「稀有/传说幻兽」的 10 张属于 v2 预留，属正常）
   命名规则：pictures/宝可梦名.jpg （名字必须与 config.js 卡牌表第一列完全一致）
   注意：卡牌表里的名字必须唯一！官方版同一只宝可梦有多张卡（费用不同），
   重复的名字要加后缀区分，例如「皮卡丘」和「皮卡丘2」。
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

require('./config.js'); // 挂到 global（config 里自动用 global 充当 window）
const TABLE = global.CARD_TABLE;

const PIC_DIR = path.join(__dirname, 'pictures');
const EXT = /\.(jpg|jpeg|png|webp|gif)$/i;
const tierName = { 1: '一阶', 2: '二阶', 3: '三阶' };

// 扫描图片（平铺在 pictures/ 根目录）
const files = fs.existsSync(PIC_DIR)
  ? fs.readdirSync(PIC_DIR).filter((f) => fs.statSync(path.join(PIC_DIR, f)).isFile() && EXT.test(f))
  : [];
const named = new Set(files.map((f) => f.replace(EXT, '')));

// 检查卡牌表里有没有重名的行（重名会导致两张卡用同一张图片）
const rows = TABLE.map((r) => ({ name: r[0], tier: r[1], vp: r[2], ok: named.has(r[0]) }));
const nameCount = {};
rows.forEach((r) => { nameCount[r.name] = (nameCount[r.name] || 0) + 1; });
const dups = Object.keys(nameCount).filter((n) => nameCount[n] > 1);

// 1. 生成对照表
let checklist = '图片命名对照表（文件名 = 宝可梦名，放在 pictures 文件夹里）\n';
checklist += '============================================================\n';
if (dups.length) {
  checklist += '⚠️ 卡牌表里有重名！同一只宝可梦出现多张卡时，请给重复的行加后缀：\n';
  dups.forEach((n) => { checklist += `   「${n}」出现 ${nameCount[n]} 次 → 改成 如「${n}」「${n}2」\n`; });
  checklist += '------------------------------------------------------------\n';
}
[1, 2, 3].forEach((t) => {
  checklist += `\n【${tierName[t]}】\n`;
  rows.filter((r) => r.tier === t).forEach((r) => {
    checklist += `  ${r.ok ? '✅' : '⬜'} ${r.name}.jpg   （${r.vp} 分）\n`;
  });
});
checklist += `\n【v2 预留】稀有 ×5、传说幻兽 ×5：按宝可梦名命名即可，未来版本使用\n`;
fs.writeFileSync(path.join(__dirname, '图片命名对照表.txt'), checklist, 'utf8');

// 2. 检查报告
const missing = rows.filter((r) => !r.ok);
const usedNames = new Set(rows.map((r) => r.name));
const extra = files.filter((f) => !usedNames.has(f.replace(EXT, '')));
if (dups.length) {
  console.log('⚠️ 卡牌表里有重名（同一名字出现多行，图片会冲突！）');
  dups.forEach((n) => console.log(`    ${n} × ${nameCount[n]} 次 → 请给重复的行加后缀，如「${n}2」`));
  console.log('');
}

console.log('==============================================');
console.log(`已正确命名：${rows.length - missing.length} / ${rows.length} 张`);
if (missing.length) {
  console.log(`\n缺失（卡牌会显示默认精灵球占位图）：${missing.length} 张`);
  console.log('  ' + missing.map((r) => r.name).join('、'));
} else {
  console.log('\n🎉 所有卡牌图片都已就位！');
}
if (extra.length) {
  console.log(`\n多余/未按规则命名的文件：${extra.length} 个（稀有/传说幻兽属 v2 预留，正常）`);
  extra.forEach((f) => console.log('  ' + f));
}
// 检查是否还有图片留在子文件夹里
const subFiles = [];
if (fs.existsSync(PIC_DIR)) {
  for (const sub of fs.readdirSync(PIC_DIR)) {
    const p = path.join(PIC_DIR, sub);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (EXT.test(f)) subFiles.push(sub + '/' + f);
      }
    }
  }
}
if (subFiles.length) {
  console.log(`\n⚠️ 还有 ${subFiles.length} 张留在子文件夹里，需移到 pictures 根目录：`);
  subFiles.slice(0, 10).forEach((f) => console.log('  ' + f));
}
console.log('==============================================');
console.log('已生成「图片命名对照表.txt」，对照它改文件名即可。');
console.log('改完刷新浏览器（Ctrl+F5）就能看到图片；联机服务器需重启。');
