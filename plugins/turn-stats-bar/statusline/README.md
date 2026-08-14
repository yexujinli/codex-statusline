# turn-stats-bar 状态栏（CDP 注入版）

这是 MCP 对话内组件失败后的替代路线：通过 Chrome DevTools 协议直接往 Codex
桌面窗口注入一条**输入框上方的单行中文状态栏**，数据按“当前对话”读本地
rollout 文件，不会出现空白块，也不会串到别的对话。

## 使用

1. 关闭 Codex 后，右键以 PowerShell 运行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\Users\11217\plugins\turn-stats-bar\statusline\launch-codex-debug.ps1"
   ```

   脚本会：关闭 Codex → 以 `--remote-debugging-port=9224` 重启 → 后台启动
   `injector.mjs`。

2. 已配置**开机自动**：登录 Windows 时静默运行
   `C:\Users\11217\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\codex-statusline.vbs`，
   自动带调试口启动 Codex 并拉起注入器，无需手动操作。脚本是幂等的：
   若 Codex 已经在带调试口运行，则只重启注入器，不会重复重启 Codex。

3. 取消开机自动：删除 Startup 文件夹里的 `codex-statusline.vbs` 即可。

## 卸载

- 停止注入器：结束命令行包含 `statusline\injector.mjs` 的 node 进程；
- 注入的状态栏会在 Codex 下次重启后消失；
- 如需彻底移除，也可卸载 `turn-stats-bar` 插件。

## 说明

- 状态栏显示：模型 · ≈tps · 缓存命中 · 上下文 · 输入→输出 · 本轮花费 · 本线程花费；
- 数据源：`~/.codex/sessions` 与 `archived_sessions` 下按当前对话 id 匹配的
  rollout 文件（`token_count` 事件），费率来自
  `~/.codex/codex-usage-tracker/kernel-v1/rate-card.json`；
- tps 为页面内文本增量估算（中文约 0.6 token/字），生成中显示、空闲保留最后值；
- 读不到数据时状态栏保持显示“—”占位，不会消失。
