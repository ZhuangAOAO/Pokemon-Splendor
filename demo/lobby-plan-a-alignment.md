# 大厅对齐差异清单（demo/lobby-plan-a.html ↔ 生产 index.html / client.js / style.css）

> 规矩：**以 `demo/lobby-plan-a.html` 为准搬结构/样式**；生产必须不同的逐条列在下面，除本清单列出的差异，其余应当一致。
> 时间：2026-09-18 21:3x ｜ 版本：v3.3.1 ｜ 未推线上

## A. 已改（对齐 demo）

| # | 项 | demo 的值 | 生产现在 |
|---|---|---|---|
| A1 | 整体骨架 | `.shell{position:fixed;inset:0;display:flex}` = `.rail` + `.stage` | 已改（原来是"标题独立条 + 宽屏顶部导航"的混合版，已废弃） |
| A2 | 标题位置 | 在竖栏 `.rail .logo` 内 | 已改回竖栏内 |
| A3 | 标题字号 | `clamp(14px,1.6vw,20px)`，`white-space:nowrap`，`letter-spacing:.5px` | 已改（原独立条版本是 clamp(26px,3vw,42px)） |
| A4 | 导航形态 | 竖栏单一导航，`gap:8px`，`.nav-btn` padding 10px 12px / 14px | 已改（原生产有顶部导航 + 竖栏两份） |
| A5 | 选中态 | `.nav-btn::before` 金色 4×16 短条 `scaleY(0→1)`，`.on{color:var(--red)}` | 已照搬 |
| A6 | 竖栏尺寸 | `width:clamp(150px,15vw,210px)`，`padding:14px 12px`，`border-right:1px solid var(--line)`，`box-shadow:var(--shadow)` | 已照搬 |
| A7 | 内容区 | `.stage{padding:16px 20px;gap:12px}`、`.topbar h2 18px`、`justify-content:space-between` | 已照搬（并清掉我此前给 `.topbar` 加的额外 padding） |
| A8 | 卡片宽度 | `.sec{width:min(640px,100%);margin-top:0}`，`.content` 居中 | 已照搬 |
| A9 | chip | `border:2px solid var(--line);border-radius:999px;padding:7px 18px;font-weight:800;13px`；`.on` 红边 + `rgba(227,53,13,.07)` 底 | 已照搬 |
| A10 | sec-desc | 13px / `margin:8px 0 14px` / line-height 1.6 | 已照搬 |
| A11 | 收纳弹层 | `.pop`（`top:56px;right:20px;width:280px`，`opacity/transform .22s`，`.open` 展开） | 已照搬 + 接生产真实入口 |
| A12 | 矮屏压缩 | `@media (max-height:480px)`（stage/rail padding 等） | 已照搬 |
| A13 | 窄屏字号 | `@media (max-width:900px)`（topbar h2 16px、utils btn 12px） | 已照搬 |
| A14 | 工具条 | 账号 / 教程 / 说明 / 音效 | 已照搬（行为见 B5） |

## B. 必须不同 + 理由（生产差异）

| # | 差异 | 理由 |
|---|---|---|
| B1 | id 命名：`#nav`→`#lobby-nav`；`#sec-title`→`#lobby-sec-title`；`sec-*`→`lobby-sec-*` | 客户端按 `lobby-sec-` 前缀拼 id 切分区（`showLobbySection`）；`#nav` 与其它屏冲突风险 |
| B2 | 大厅音效按钮 id = `#lobby-sound`（demo 用 `#btn-sound`） | `#btn-sound` 已被"对局屏"顶栏占用，重复 id 会导致绑错元素 |
| B3 | 首屏卡内多两张：`#join-card` / `#room-card` | 濠哥指定"点击进入游戏只换中间那张卡" —— 加入页已并进外壳；demo 是独立原型页没有这个交互 |
| B4 | 只有生产才有的元素：`#lobby-room-info`/`#lobby-seats`（座位+房主设置）、`#hall-*`（真实光荣榜）、`#landscape-tip`（② 不阻断横屏提示）、`#rotate-mask`（⑤ 竖屏遮罩） | 这些是 ②~⑤ 的真实功能；demo 是静态原型，无对应需求 |
| B5 | 工具条行为：账号→修改密码/退出登录；教程→现有教程流程；说明→`#modal-rules`；另加 `记录`（仅房内显示） | demo 里是原型提示弹层；生产要接真实入口，并保留原来的"房间记录" |
| B6 | 装饰球：demo 在 `.shell` 内写死 5 颗 | 生产由 `buildDeco()` 每屏随机生成（视觉语言一致，位置随机） |
| B7 | 脚注：demo「v3.2.2 · IA 原型示意 / 方案 A」→ 生产「v3.3.0 · 联机大厅」 | 版本与用途不同 |
| B8 | 首屏内容：demo「开始对局」表单（昵称/房间类型/房间号/开始） ↔ 生产「加入游戏」卡（昵称/房间类型/房间号/进入游戏 + 公开房间列表） | 生产要区分"创建/加入房间"与"房内准备"两步；字段与按钮层级与 demo 一致 |

## C. 对照证据

- 同视口并排图（上半 demo、下半生产）：`demo/shots/lobby/align-1280x720.png`、`align-844x390.png`
- 装置页：`demo/lobby-compare.html?w=1280&h=720` / `?w=844&h=390`（可自行改参数复现）
- 480 竖屏那组**不作为对照**（非方案 A 设计目标）

## D. 未决 / 需濠哥定的

1. demo 的「开始挑战 · 即将上线」是原型占位；生产该按钮是**真实建房**（`#champ-start`）→ 保留生产行为（已按此实现），若要改成占位请说
2. demo 的排行榜/对局回放/光荣榜是示意数据；生产是真实数据（排行榜走弹窗、回放走 `/replay`、光荣榜走 `hallOfFame` 接口）→ 保留真实数据

---

## E. 濠哥复核后追加（2026-09-18 21:3x，已改并重出对照图）

| # | 差异 | 处理 | 依据 |
|---|---|---|---|
| E1 | 生产竖栏首项是**空白框**（无文字） | **已改**：根因是我那条 `#screen-lobby .nav-btn{background:var(--field)}` 以 **id 特异性**压掉了 `.btn.primary` 的**红渐变**，而 `.btn.primary` 自带 `color:#fff` → 白字落在浅底上＝看起来空白。改为 **`:not(.primary)` 才铺底色**，并补 `#screen-lobby .nav-btn.primary{border-color:var(--red-deep)}` 与主按钮选中态（金边 + 面板色字，照 demo） | demo `.nav-btn.primary` / `.nav-btn.primary.on` |
| E2 | 卡片标题与顶栏标题「加入游戏」 vs demo「开始对局」 | **已改**：两态统一为「开始对局」（`index.html` 的 `<h2>` + `setLobbyMode()`） | demo `#sec-start` 标题 |
| E3 | 卡片里多一颗绿色「新手教程」按钮 | **已改**：`tutorial.js` 注入的 `.tut-btn` 在 `#screen-lobby` 内 **CSS 隐藏**（单机设置页那颗保留）；工具条「教程」为唯一入口 | 濠哥 2026-09-18 批准 |
| E4 | 卡片下方提示行数（生产 3 行 / demo 1 行） | **已改**：只留 demo 那 1 行；我自造的那行删除；`#user-links` 改 `hidden`（**元素保留**，因为 `#link-password` 有绑定，改密码入口在工具条「账号」里） | demo 卡片脚注 |

**取证方式（CDP 卡住时的备用通道，由濠哥提供）**：
`msedge --headless=new --disable-gpu --no-first-run --user-data-dir=<tmp> --window-size=1280,1150 --virtual-time-budget=9000 --screenshot=<png> "http://127.0.0.1:8099/demo/lobby-compare.html?w=1280&h=720"`
（844×390 用 `--window-size=844,760`；**窗口高度必须 ≥ 两半之和**，否则下半被裁）

**遗留小瑕疵（如实记，未改）**：844×390 下两边标题都在竖栏内贴边，生产那半末字似被裁一点点（A 的 `white-space:nowrap` + `clamp(14px,1.6vw,20px)` 在 150px 竖栏下本就吃紧）。若要去掉需把 h1 再收一档（如 `clamp(13px,1.5vw,20px)`）→ 会偏离 A 数值，**待濠哥定**。
### E5 / E6（濠哥复核后追加，已改并重出对照图）

| # | 差异 | 处理 | 依据 |
|---|---|---|---|
| E5 | 「公开房间列表」按钮：demo **蓝底**，生产白底/描边 | **已改**：`#btn-room-list` 由 `btn ghost lg` 改为 **`btn secondary lg`**（蓝渐变，照 demo） | demo `data-note="roomlist"` 用 `.btn.secondary` |
| E6 | 844×390 下生产卡片偏高，两颗按钮被压到折线下 | **已改**：在 `@media (max-height:480px)` 内**照搬 demo 的收紧规则**（`.setup-panel` padding 16/18、h2 16px、`.join-name` 8/10 + 14px、`.target-row` margin 8、`.setup-actions` margin-top 12/gap 8、`.footnote` 11px、`.sec-desc` margin 4/8）→ 两颗按钮回到首屏 | demo 的 `@media (max-height:480px)` 块 |
| E7 | 竖栏内标题末字可能被裁（我自查发现，濠哥批准） | **已改**：`#screen-lobby .rail .logo h1` 字号 `clamp(14px,1.6vw,20px)` → **`clamp(13px,1.5vw,20px)`**；濠哥口径：**消掉裁字优先于守 clamp 数值**，除这点外不再多偏 A | 濠哥 2026-09-18 21:39 批准 |
### E8：内容区构图（濠哥 2026-09-18 21:46 要求 —— **偏离 A 原稿**）

| 项 | A 原稿 | 生产现在 |
|---|---|---|
| 卡片宽度 | `min(640px,100%)` | **档2（默认）`min(720px,100%)`**；档1 `?card=center` 仍照 A 的 640 |
| 卡片内件 | 原尺寸 | 档2：h2 20px、输入框 padding 12/14 + 16px、按钮 13/24 + 16px、脚注 12px（**同步放大，不只放大外壳**） |
| 竖直构图 | `align-items:flex-start`（贴顶） | 高度 ≥481px 时内容区**上留白 `clamp(8px,10vh,88px)`** → 重心略偏上、不贴顶不吊中；≤480px 不加（保 844×390 按钮在首屏） |
| 骨架 / 导航 / 配色 / 圆角 / 动效时长 | — | **不动** ✓ |

**硬约束实测（装置自动量测，写进截图标签行）**
- 1280×720：竖向溢出 **0px → 无滚动条 ✓**（档1/档2 都是）
- 844×390：两颗按钮**都在首屏 ✓**（档1/档2 都是）
- 档2 卡宽 720px（档1 640px）

**对照图（无头 Edge，同视口，上 demo / 下生产）**
- 档2：`demo/shots/lobby/e8-1280-lg.png`、`e8-844-lg.png`
- 档1：`demo/shots/lobby/e8-1280-center.png`、`e8-844-center.png`
- 复现：`demo/lobby-compare.html?w=1280&h=720&card=lg`（或 `&card=center`）

**说明**：A 的 640 是"参考不是圣旨"（濠哥口径）—— 本项按濠哥要求偏离，其他项不再多偏。