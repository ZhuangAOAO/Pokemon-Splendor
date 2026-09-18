# 确认框逐处实测结果（8/8）

装置：`demo/confirm-sites.html?site=<key>`（同源 iframe 载真实 index.html/admin.html → stub 状态 → **点真实按钮** → 包住 `postApi`/`api` 记录"确认后实际发生了什么"）
⑥ 专用装置：`demo/confirm-tut.html`（**file:// 本地单机模式**，不连服务器、不需账号；页内已注明「测试用，可随时删」）
组件级：`demo/confirm-selftest.html` **13/13 断言全过**（危险框焦点在「取消」、Esc、点遮罩、Enter 跟随焦点）

| # | 场景 | 截图 | 状态核对结果 |
|---|---|---|---|
| 1 | 退出大厅 | `site-lobby-leave.png` | 取消 → `[]`、弹框已关 ✓；确认 → `[]`（该分支只 `location.reload()`，本就不发请求）✓ |
| 2 | 退出房间 | `site-exit-room.png` | 取消 → `[]` ✓；确认 → **帧内记录被重载清空**（`postApi(logout)`→`removeItem`→`reload`）→ 仅代码级 ⚠（客观限制，已接受） |
| 3 | 退出对局（单机分支） | `confirm-danger.png`（组件级） | http 下不可达（`ONLINE` 是 `const`，client.js:11）→ 代码级：`!S\|\|S.over` 短路 + `backToSetup()` ⚠（已接受） |
| 4 | 结束对局投票（**危险**） | `site-stop-game.png` | 取消 → `[]` ✓；确认 → **`["voteEnd"]`** ✓；主按钮深红 ✓ |
| 5 | 移出房间/踢人（**危险**） | `site-kick.png` | 取消 → `[]` ✓；确认 → **`["kick"]`** ✓；主按钮深红 ✓ |
| 6 | 结束教程 | `site-tutorial-exit.png` | **实测 ✓（file:// 本地模式）**：① 顶栏 `#tut-bar`/`#tut-exit` 真生成 ✓；② 弹框标题「结束教程」可见 ✓（普通主按钮）；③ 取消 → 弹框关、**教程顶栏仍在（教程继续）** ✓；④ 确认 → 弹框关、**回到设置页 setup ✓**（`#tut-bar` 元素仍在 DOM 但已不显示）；⑤ 截图态标题「结束教程」✓ |
| 7 | 审核用户（admin） | `site-admin-review.png` | 取消 → `[]` ✓；确认 → **`["adminReview","adminList"]`** ✓（审核 + 刷新列表）；标题「审核用户」✓ |
| 8 | 创建管理员（admin） | `site-admin-create.png` | 取消 → `[]` ✓；确认 → **`["createAdmin"]`** ✓；标题「创建管理员」✓ |

**汇总：8 处 → 7 处实测留证 + 1 处（#6）本轮已升为实测 ✓**
（#2、#3 的"仅代码级"是环境客观限制：重载清空记录 / 单机分支在 http 下不可达，均已单独说明并被接受）

## 测试痕迹清理（按批准口径）
- #6 走 **file:// 本地单机** → **没有连服务器、没有留下服务器会话** ✓
- **未创建/未改动任何账号** ✓（全程没用账号）
- 装置页均注明测试用途：`demo/confirm-tut.html`（页内注释「测试用，可随时删」）、`demo/confirm-sites.html`、`demo/confirm-selftest.html`
- 临时 Edge profile：`E:\Agent\_work\宝可梦-RL\edge-profile`（工作区临时目录，可随时删）