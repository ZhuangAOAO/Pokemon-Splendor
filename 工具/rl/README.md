# 工具/rl · RL 实验台使用说明

> 阶段 A+B 的实验工具。**只在本地跑**（别在阿里云服务器上跑，会抢 CPU）。
> 环境要求：装有 Node 的任意终端（Git Bash / CMD / PowerShell），在**项目根目录**执行。

## 三个文件

| 文件 | 是什么 | 怎么用 |
|---|---|---|
| `harness.js` | 实验台核心库（真实游戏，不是命令） | 被 seed-demo / bandit-battle 两脚本 `require` |
| `seed-demo.js` | 阶段 A：种子 RNG + 逐步打印 | `node 工具/rl/seed-demo.js [seed] [--print]` |
| `bandit-battle.js` | 阶段 B：拿球老虎机对战 | `node 工具/rl/bandit-battle.js [局数] [人数] [目标分]` |
| `mini-config.js` + `mini-env.js` | 阶段 C：迷你游戏（2 色/市场 1 格/目标 3 分）及其加载器 | 被 qlearn.js `require` |
| `qlearn.js` | 阶段 C：表格 Q-Learning 自对弈 | `node 工具/rl/qlearn.js [训练局数] [评估间隔]` |
| `lqlearn.js` | 阶段 D：大游戏线性函数逼近 Q_θ | `node 工具/rl/lqlearn.js [训练局数] [评估间隔] [--sarsa]` |
| `ppo-mini.js` | 阶段 E：迷你游戏 PPO + 对手池 | `node 工具/rl/ppo-mini.js [训练局数] [评估间隔]` |
| `ppo-big.js` | 阶段 E：大游戏 PPO + 对手池（线性） | `node 工具/rl/ppo-big.js [训练局数] [评估间隔]` |
| `nn.js` | 手写神经网络（前向/反向/Adam，零依赖） | 被 ppo-\*-nn 两个脚本 require |
| `ppo-mini-nn.js` | 神经网络 PPO（迷你游戏） | `node 工具/rl/ppo-mini-nn.js [训练局数] [评估间隔]` |
| `ppo-big-nn.js` | 神经网络 PPO（大游戏） | `node 工具/rl/ppo-big-nn.js [训练局数] [评估间隔]` |
| `weights/` | **训练好的权重 JSON**（进版本库，游戏内推理直接用） | 目前：ppo-big-20000（60.5%）/ ppo-big-100000（51.0%） |

> ⚠️ `harness.js`（真实游戏）与 `mini-env.js`（迷你游戏）**不能在同一进程 require**——都往 window 写全局会互相覆盖。每个脚本只用其中一份。

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

## qlearn.js —— 迷你游戏 + 表格 Q-Learning（阶段 C）

```bash
node 工具/rl/qlearn.js                 # 默认 100000 局训练
node 工具/rl/qlearn.js 1000000 2000    # 100 万局，每 2000 局评估一次
```

- **迷你游戏**：2 种球、市场 1 格、目标 3 分（约 10 手一局，跑得飞快——100 万局约 40 秒）
- **状态**：我/对手的(红,蓝)球数 × 双方分数 × 市场卡成本模式（约 3.9 万可达状态）
- **训练**：自对弈（双座共享 Q 表），ε=0.1 + **乐观初始化 Q₀=0.5**（第 4 课——Q 全 0 开局会被 ε-greedy 锁死在第一个动作上，实测教训）
- **奖励**：赢 +1 / 输 −1；**卡死 = 双方 −1**（实测教训：不给卡死惩罚，Q 会学到"死守不还球 → 游戏永不结束 → 永不输"的漏洞策略——Q13 的 reward hacking 活体标本）
- **产出**：`data/qlearn-report.html`（学习曲线 / Q 表切片热图 / 最值钱局面 / 一局对局）+ `episodes/qlearn-*.summary.json`（含最终 Q 表）

**实测结果（100 万局）**：贪心 Q vs 随机 **100%**，vs 手写启发式 **77.4%**——学出来的策略第一次在胜率上明确超过了手写规则。

## lqlearn.js —— 大游戏线性函数逼近（阶段 D，⚠️ 负结果存档）

```bash
node 工具/rl/lqlearn.js 20000 2000            # Q-Learning（不稳定）
node 工具/rl/lqlearn.js 20000 2000 --sarsa    # SARSA（较稳但震荡）
```

**结论：25 维手写特征的线性 Q_θ 在大游戏上不稳定**——Q-Learning 胜率 0%↔48% 暴跳（致命三要素发散），SARSA 略稳但仍 0%↔43% 震荡，10 万局长跑不收敛。学习信号真实存在（单次评估最高 55%），但状态特征太弱（对手球/池/市场结构都没进状态）→ 值函数非线性 → bootstrapping 放大误差。

**五个实测教训**（每个都对应课程理论，这就是"边学边用"的产出）：
1. **特征共线**：`离目标分 = 1 − 我的分` 与常数、我的分完全线性相关 → 权重任意漂移互相抵消（第 07 课 §3）
2. **势函数淹没信号**：r=Δ分 时 V(s)=「还能拿多少分」，"分越高越不值钱"符号反直觉，且 Φ≈18 淹没 ±1 胜负信号 → 塑形要缩权（SHAPE_W=0.1；Ng et al. 1999 保证任何正倍数不改变最优策略）
3. **学习率太小**：α=0.01 时 θ≈0.3 微小，贪心≈随机（8%，低于均匀随机 28%）
4. **致命三要素发散**：α=0.1 时 0%↔48% 暴跳——函数逼近+自举+异策略凑齐的教科书症状（第 07 课 §6 的活体演示）
5. **SARSA 稳于 Q-learning**：去掉"异策略"后震荡减弱、终点 55%——但特征不够，仍不收敛

**出路**（按顺序）：① 特征翻倍（对手球/池/预约区/市场结构，~60 维）② DQN 补丁（目标网络+经验回放）③ 第 9~11 课 Actor-Critic/PPO——它们本来就是为了治这个病发明的。

## ppo-mini.js —— 迷你游戏 PPO + 对手池（阶段 E 第一步）

```bash
node 工具/rl/ppo-mini.js 100000 2000     # 默认 10 万局
```

- **Actor**：线性 softmax（ψ 16 维状态 + 7 动作独热）；**Critic**：线性 V_w
- **对手池**（第 11 课）：初始 {启发式, 均匀随机}，每 2000 局 θ 快照入池（上限 12+2）——不能一上来就自对弈
- **评估裁判**：固定启发式（自对弈胜率恒 50%，不能当指标）
- **实测结果（10 万局，33.6 秒）**：贪心 vs 启发式 **80.0%**——4000 局即收敛、之后 9.6 万局纹丝不动。对照：表格 Q（阶段 C）100 万局 77.4%。**PPO 用 1/25 的训练量反超，且全程零震荡**（阶段 D 的四条失败曲线从此翻篇）
- 产出：`data/ppo-mini-report.html` + `episodes/ppo-mini-*.summary.json`（含 Actor θ / Critic w / 池演变）

## 与 测试/ 目录的区别

- **工具/rl/**：RL 实验（本次新建），本地跑，不需要服务器、不需要数据库
- **测试/**：线上功能测试（test-leaderboard / test-replay 等），需要先本地起 `server.js` + `测试/凭证.json`，属于部署前的回归工具

## 常用操作速查

```bash
node 工具/rl/seed-demo.js 42 --print      # 看一局
node 工具/rl/bandit-battle.js 500 3 18    # 跑实验 + 出报告
# 改了 game-core.js 或实验参数后，重跑即可——数据可复现，旧产物会被覆盖
```
