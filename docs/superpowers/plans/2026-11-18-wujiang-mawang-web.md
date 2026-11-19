# 吴江麻王浏览器首版实施计划

> **For agentic workers:** Use the implementation and verification workflows to complete each task.

**目标**　用手机或电脑浏览器进入四人好友房，完成吴江麻将对局、结算和续局。

**架构**　`src/shared` 定义协议及纯规则，`src/server` 推进牌局并通过 Colyseus 发送按席位过滤的快照，`src/web` 处理房间页面及 Phaser 牌桌。

**技术栈**　TypeScript、Phaser、Vite、Node.js、Colyseus。

**设计**　[浏览器首版设计](../specs/2026-11-18-wujiang-mawang-web-design.md)。

## 规则

四人、136 张无花牌、两台起胡、自摸或抢补杠。金张按中发白，自风按座位。普通明杠 1 台、暗杠 2 台，自风或金张明杠 2 台、暗杠 3 台。风牌或金张财神、豹子均使当局翻倍，同时触发则当局及之后两局翻倍。

## 实施与验证

- [x] 在 `src/shared/protocol.ts` 定义牌、席位、操作和玩家快照。用 `tests/scoring.test.ts` 固定胡牌边界、特殊杠和倍率，实现 `src/shared/scoring.ts`。
- [x] 在 `tests/round.test.ts` 写固定牌墙用例，覆盖发牌、可选动作、抢杠、不可重复出牌、耗尽牌墙及玩家视图隔离，实现 `src/shared/round.ts`。
- [x] 在 `src/server` 实现 Colyseus 房间、席位权限、房主开局和准备续局、短时重连和超时。用本地四客户端验证开局到续局，并重连恢复原座位。
- [x] 在 `src/web` 实现卡通桌面、触控与鼠标操作、开局和结算界面。在浏览器验证横屏、竖屏提示、邀请码和续局。
- [x] 运行类型检查、单元测试、联机测试及生产构建。启动首版供本机与局域网试玩。
