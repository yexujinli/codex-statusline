# Turn Stats Bar

在 Codex 对话内显示最近活跃对话/轮次的实时信息条：

- 缓存命中率（`cache_reuse`，fact）
- 上下文已用/上限/百分比/剩余（`input_tokens` 为 fact，窗口大小为 derived）
- 输入→输出 token、调用次数、模型、数据代次
- 本轮花费与对话累计花费（estimate，仅配置费率后显示）

## 数据来源

插件读取本机 codex-usage-tracker 内核的本地 HTTP API（默认
`http://127.0.0.1:8765`），默认每 5 秒轮询一次。服务未运行时插件会自动尝试拉起
`codex-usage-tracker service serve`。

## 使用

1. 安装插件后**新开一个 Codex 任务**（MCP 工具与 UI 资源只在新建任务中挂载）。
2. 对模型说“显示本轮对话统计”，信息条会出现在对话内。
3. 费率未配置时信息条显示“费率未配置”，点击“配置费率”可让模型引导配置。

## 配置费率

价格写入 usage-tracker 官方费率卡：

`~/.codex/codex-usage-tracker/kernel-v1/rate-card.json`

也可以通过 `configure_rate_card` 工具按模型 upsert（美元/每百万 token）：

```json
{
  "model": "gpt-5.6",
  "input_per_million": 1.25,
  "cached_input_per_million": 0.125,
  "output_per_million": 10,
  "credits_input_per_million": 1,
  "credits_cached_input_per_million": 0.1,
  "credits_output_per_million": 8,
  "confidence": "user_override"
}
```

成本按 tracker 同款公式估算：
`(uncached_input × 输入价 + cached_input × 缓存价 + output × 输出价) / 1_000_000`。

## 开发

```bash
cd server
npm install
npm test
node index.js   # MCP stdio server（供插件宿主调用）
```

`server/widget.html?demo=1` 可在浏览器中独立预览信息条效果；
`?demo=absent` 预览费率未配置状态。
