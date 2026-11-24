# composer-stats-turn 规格说明

在 ZCode 输入框右下角状态区显示当前会话的对话轮次数，悬停显示 Round 标签与轮次数。

## 1. 用户可见行为

- 芯片：`message-square` 图标 + 数字 `N`
- 悬停：`zh-CN` 为 `轮次 · N`，其他语言为 `Round · N`
- 未授权：芯片显示 `轮次·未授权` / `Turns · no grant`，悬停说明如何重新申请
- 无任何轮次数据：不显示芯片，也不写入空值
- 语言：激活时读 `env.get().locale`，并订阅 `env.onDidChange`；以 `zh` 开头的 locale 用中文，其他一律英文

## 2. 数据来源

| 数据 | 接口 | 授权 |
| --- | --- | --- |
| 轮次与用时 | `sessions.readRows`、`sessions.onDidChangeRows` 的 `turnHeader` 行 | `sessions.read` |
| 上下文占用 | `context.get` 的 `estimatedTokens`、`model.contextWindow`；变更订阅 `context.onDidChange` | 无 |
| 界面语言 | `env.get().locale`、`env.onDidChange` | 无 |
| 当前可见会话 | `workbench.visibleSessions`、`workbench.onDidChange` | 无 |

## 3. 口径

- **轮次**：`turnHeader` 行按 `rowId` 去重后的数量，含进行中的一轮；乱序到达不影响结果。
- **当前轮**：`rowId` 最大的 `turnHeader`。
- **用时**：优先 `activeMs`；否则 `(endedAt ?? now) - startedAt`；都缺则为空。
- **上下文占比**：`estimatedTokens / contextWindow`，保留 1 位小数。
- 运行中的一轮每 5 秒重新计算一次用时（仅刷新悬停，芯片文字不变）。

## 4. 状态与降级

| 场景 | 行为 |
| --- | --- |
| 用户拒绝 `sessions.read` | 进入未授权态，芯片显示提示文案 |
| `readRows` 抛错 | 保留已有统计，标记降级；会话可见时按 4 秒起指数退避重试（上限 60 秒），重新可见时立即重试 |
| 行流断开（`onDidChangeRows` 的 onError） | 保留最后一次结果，只标记降级；会话可见时 5 秒后重订阅 |
| 收到 `reset` 事件 | 先把事件自带的行算到临时状态，非空才整体替换 |
| 收到 `stale` 事件 | 后台重读到临时状态，成功后替换；失败保留旧值 |
| 宿主重启/插件更新 | 先读本地快照（`${ZCODE_PLUGIN_DATA}/turn-state.json`）并立即写槽位，再读行覆盖；每 30 秒强制重写一次 |
| 无数据 | 不写入槽位，等待真实数据覆盖 |

## 5. 验收标准

1. 轮次计算正确：单测覆盖乱序插入、跨轮累加、同一行重复 upsert。
2. `reset` 携带的行不完整时，轮数不减少（冒烟用例 `turn(reset)`）。
3. `readRows` 失败时芯片不被清空（冒烟用例 `speed(降级)` 同款机制）。
4. 悬停文本逐字匹配：中文 `轮次 · 12`，英文 `Round · 12`；运行时切换语言后立即更新（冒烟 `turn(i18n)`）。
5. 任意输入下 `tooltip` 不超过 200 字符，且不出现被截断的半行。
6. 任何一次写入都不含空文本（不闪无）。
7. 插件重新激活且 `readRows` 失败时，芯片立即显示快照里的最后值（冒烟用例 `turn(快照)`）。
8. 首次读行失败后，会话重新可见时自动补读并显示（冒烟用例 `turn(重试)`）。

## 6. 已知边界

- 宿主只允许读取当前信任范围（`session:<id>`）的会话：`sessions.readRows` / `onDidChangeRows` 对新会话创建瞬间、刚切换的会话可能返回 `forbidden: Target is outside the trusted scope`，部分版本还会在输出校验时抛 `ZodError`。插件按可见性退避重试并重订阅，切回会话后能自愈；不能绕过宿主授权。
- 槽位 `tooltip` 是纯文本（≤200 字符），不能内联 HTML/CSS；不使用 emoji。
- 快照只保存数字；悬停文案按当前语言重建，所以切换语言不会残留旧文案。
- 芯片文字上限 40 字符；轮数极大时仍远低于该上限。
- 扩展 API 版本约束：`engines.zcode ^1.4.0`。
