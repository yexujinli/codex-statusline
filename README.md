# Codex Statusline

在 Codex 桌面版输入框上方显示一条**单行中文实时状态栏**：模型、生成速度（tps）、缓存命中率、上下文用量、Token 与费用。数据按当前对话严格隔离，绝不串号。

```
deepseek-v4-flash · ≈6 tps · 缓存 100% · 上下文 570k/996k 57% · 570k→523 · 本轮 ¥0.01 · 线程 ¥2.75
```

## 功能

- **CDP 注入状态栏**：真实 DOM 注入，位置固定在输入框上方，单行完整显示不截断
- **对话隔离**：侧边栏选中线程 + 输入框 React fiber 双来源交叉校验，连续两轮确认后才切换；读不到数据显示 `—`，绝不显示别的对话的数据
- **实时指标**：tps 估算（文本增量）、缓存命中率、上下文用量、本轮/线程 Token 与费用
- **费率卡**：按模型配置人民币单价（`~/.codex/codex-usage-tracker/kernel-v1/rate-card.json`）
- **开机自启**：登录后自动带调试端口启动 Codex 并拉起注入器（可选）

## 目录结构

```text
codex-statusline/
├── .agents/plugins/marketplace.json   # Codex 插件市场清单
├── plugins/turn-stats-bar/            # Codex 插件（MCP widget，可选）
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── server/                        # MCP 服务 + widget
│   └── statusline/                    # CDP 注入器 + 启动脚本（主功能）
├── install.ps1                        # 一键安装
└── README.md
```

## 安装

> 仅支持 **Windows**（依赖 PowerShell、MSIX 包与 COM 激活）。

### 1. 克隆仓库

```powershell
git clone https://github.com/yexujinli/codex-statusline.git
cd codex-statusline
```

### 2. 一键安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会：安装 `server/` 依赖 → 把 `.mcp.json` 修正为本机绝对路径 → 注册本地插件市场 →
创建每 5 分钟的计划任务（守护自愈）→ 添加开机自启 → 创建桌面快捷方式。

### 3. 启动状态栏（首次需重启 Codex 一次）

```powershell
powershell -ExecutionPolicy Bypass -File .\plugins\turn-stats-bar\statusline\launch-codex-debug.ps1
```

脚本是幂等的：若 Codex 已带调试端口（9224）运行，则只重启注入器，不会重启 Codex。

### 4. 作为 Codex 插件安装（可选，仅 MCP widget）

```powershell
codex plugin marketplace add yexujinli/codex-statusline
codex plugin add turn-stats-bar@codex-statusline
```

状态栏主功能不依赖该插件，插件只提供对话内的 MCP widget。注意：插件里的 `.mcp.json`
使用相对路径，若直接通过 marketplace 安装，MCP widget 可能无法启动；需要 widget 时请使用
本地 clone + `install.ps1` 流程（会自动修正路径），或者手动把 `.mcp.json` 改成绝对路径。

## 开机自启

把启动脚本的快捷方式放入 Windows 启动文件夹：

```text
C:\Users\<你>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\
```

取消自启：删除该启动项即可。

## 字段说明

| 字段 | 含义 |
| --- | --- |
| `模型` | 当前模型名（默认 `deepseek-v4-flash`，可用环境变量 `TURN_STATS_MODEL` 覆盖） |
| `≈N tps` | 生成速度估算（输出文本增量），空闲时冻结最后值 |
| `缓存 X%` | 最近一次请求的缓存命中率 |
| `上下文 a/b c%` | 当前对话已用 / 窗口上限 / 占用百分比 |
| `a→b` | 最近一次请求的输入 → 输出 token |
| `本轮 ¥X` | 最近一次请求的费用 |
| `线程 ¥X` | 当前对话累计费用 |

## 配置

### 费率卡

费率卡路径：`~/.codex/codex-usage-tracker/kernel-v1/rate-card.json`

```json
{
  "schema": "codex-usage-tracker.kernel-rate-card.v1",
  "source": { "name": "DeepSeek API Docs", "url": "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" },
  "models": {
    "deepseek-v4-flash": {
      "input_per_million": 1,
      "cached_input_per_million": 0.02,
      "output_per_million": 2,
      "credits_input_per_million": 1,
      "credits_cached_input_per_million": 0.02,
      "credits_output_per_million": 2,
      "confidence": "exact"
    }
  }
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TURN_STATS_CDP_PORT` | `9224` | Codex 调试端口 |
| `TURN_STATS_MODEL` | `deepseek-v4-flash` | 状态栏显示的模型名 |
| `CODEX_HOME` | `~/.codex` | Codex 配置目录 |

## 卸载

1. 删除启动文件夹中的自启项；
2. 结束命令行含 `statusline\injector.mjs` 的 node 进程；
3. 重启 Codex 后注入的状态栏消失；
4. 如需移除插件：`codex plugin remove turn-stats-bar@codex-statusline`，并删除已添加的 marketplace。

## 故障排查

### Codex 更新后状态栏消失

Codex 自动更新会直接重启应用，重启后的 Codex **不带调试端口**，状态栏因此消失。修复：

```powershell
powershell -ExecutionPolicy Bypass -File .\plugins\turn-stats-bar\statusline\launch-codex-debug.ps1
```

脚本是幂等的：检测到 Codex 未带调试端口时会自动重启一次并拉起注入器；已带端口时只重启注入器。
也可直接双击桌面快捷方式 `fix-codex-statusline.cmd`。

启动方式说明：Windows 上 Codex 是 MSIX 打包应用，普通图标启动会**剥掉所有命令行参数**
（`shell:AppsFolder` 限制）。启动脚本改用微软官方接口
`IApplicationActivationManager::ActivateApplication` 带参数激活应用
（`--remote-debugging-port=9224 --remote-allow-origins=*`），参数不会再丢失。

### 手动重启 / 更新后自动修复（守护进程）

启动脚本会自动拉起后台守护进程 `statusline/watchdog.ps1`：每 15 秒检查一次，
发现 Codex 在运行但没有调试端口（手动重启、自动更新等场景）时，会在约 30 秒后
自动重启一次带调试端口的 Codex 并恢复状态栏。守护进程带 60 秒冷却，不会反复重启。

## License

[MIT](LICENSE)
