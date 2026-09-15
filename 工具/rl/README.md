# 工具/rl · RL 实验台使用说明

> 阶段 A+B 的实验工具。**只在本地跑**（别在阿里云服务器上跑，会抢 CPU）。
> 环境要求：装有 Node 的任意终端（Git Bash / CMD / PowerShell），在**项目根目录**执行。

## 三个文件

| 文件 | 是什么 | 怎么用 |
|---|---|---|
| `harness.js` | 实验台核心库（不是命令） | 被下面两个脚本 `require`，一般不直接运行 |
| `seed-demo.js` | 阶段 A：种子 RNG + 逐步打印 | `node 工具/rl/seed-demo.js [seed] [--print]` |
| `bandit-battle.js` | 阶段 B：拿球老虎机对战 | `node 工具/rl/bandit-battle.js [局数] [人数] [目标分]` |

## seed-demo.js —— 验证/调试一局游戏

```bash
node 工具/rl/seed-demo.js 42            # 同 seed 跑两局，验证逐字节一致（实验台地基自检）
node 工具/rl/seed-demo.js 42 --print    # 再加逐步打印一局（每手：座位/动作/分数/球数）
node 工具/rl/seed-demo.js 7 --print     # 换个 seed 看另一局
```

输出示例：

```
✓ 一致：seed=42 两局行动序列与终局状态逐字节相同（75 手）
  终局名次：1.A(19分) 2.B(18分) 3.C(8分)

===== 逐手打印（seed=42）=====
第  1手 | 座位1(B) | 预约 市场2阶#1              | 分 0 球 1
第 10手 | 座位1(B) | 拿取 2×超级球               | 分 0 球 4
```

**用途**：调参时锁定一局反复看；怀疑游戏有 bug 时用它复现同一局。

## bandit-battle.js —— 跑对照实验 + 出报告

```bash
node 工具/rl/bandit-battle.js                 # 默认 500 局 / 3 人 / 目标 18 分
node 工具/rl/bandit-battle.js 2000 3 18       # 更大样本
node 工具/rl/bandit-battle.js 500 4 15        # 4 人局、目标 15 分
```

**它做什么**：座位 A 换用被测"拿球策略"（其余座位走原困难 AI），5 个变体各跑 N 局（共 5N 局），变体共用同一 seed 序列保证公平。跑完自动：

1. 控制台打印胜率表 + 各变体学到的 top-5 臂
2. 生成 `工具/rl/data/report.html`（自动尝试在浏览器打开；打不开就双击）：
   - ① 胜率对比条形图 ② 学习曲线（累计胜率） ③ 各臂 Q 值条形图 ④ 运行参数
3. 对局数据落盘（见下）

**想改实验参数**：打开 `bandit-battle.js`，改 `variants` 表（ε、Q₀、加删变体）和 `BASE_SEED`。

## 数据产物（工具/rl/data/，已 gitignore）

| 路径 | 内容 |
|---|---|
| `report.html` | 最新一次实验的可视化报告 |
| `episodes/*.jsonl` | **每局一行**的完整对局数据（回放表格式 + `seed`/`winner`/每步 `r` 奖励）——以后做离线学习（MC/行为克隆）直接读它 |
| `episodes/*.summary.json` | 每变体的汇总：胜率、Q 表、N 表、运行参数 |

JSONL 每行结构：

```json
{ "seed": 20260915, "finished": true, "turns": 80, "winner": "B",
  "actions": [ {"k":"take2","p":{"color":"blue"},"seat":0,"t":3,"r":1}, ... ],
  "initial": {...开局快照...}, "final": {...终局快照...}, "leak": null }
```

- `actions` 里 `r` 只出现在被老虎机替换的 take2/take3 上（拿球这一手的即时奖励 = 最小缺口推进量）
- `leak` 非空 = 该局守恒校验失败（正常应为 null）
- 中间状态不用存：`initial` + `actions` 确定性重演即可重建（和线上回放播放器同一个原理）

## 与 测试/ 目录的区别

- **工具/rl/**：RL 实验（本次新建），本地跑，不需要服务器、不需要数据库
- **测试/**：线上功能测试（test-leaderboard / test-replay 等），需要先本地起 `server.js` + `测试/凭证.json`，属于部署前的回归工具

## 常用操作速查

```bash
node 工具/rl/seed-demo.js 42 --print      # 看一局
node 工具/rl/bandit-battle.js 500 3 18    # 跑实验 + 出报告
# 改了 game-core.js 或实验参数后，重跑即可——数据可复现，旧产物会被覆盖
```
