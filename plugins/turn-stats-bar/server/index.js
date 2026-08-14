import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { createClient } from "./tracker.js";

const WIDGET_URI = "ui://turn-stats-bar/v1.html";
const widgetHtml = fs.readFileSync(new URL("./widget.html", import.meta.url), "utf8");
const tracker = createClient();

const server = new McpServer({
  name: "turn-stats-bar",
  version: "0.2.0",
});

registerAppResource(
  server,
  "turn-stats-bar-widget",
  WIDGET_URI,
  {},
  async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  }),
);

registerAppTool(
  server,
  "show_turn_stats_bar",
  {
    title: "Show turn stats bar",
    description:
      "在对话内显示单行实时统计信息条：模型、tps、缓存命中率、上下文用量、输入→输出 token 与花费。调用后信息条自动渲染并每 5 秒刷新；请勿在回复中展开或重复统计内容。",
    inputSchema: z.object({}),
    _meta: {
      ui: { resourceUri: WIDGET_URI },
      "openai/toolInvocation/invoking": "正在加载本轮统计…",
      "openai/toolInvocation/invoked": "统计信息条已显示。",
    },
  },
  async () => {
    // 预热 usage-tracker 服务；不返回结构化数据，避免模型把统计展开成表格，
    // widget 通过 turn_stats_poll 自行获取实时数据。
    await tracker.collectTurnStats();
    return {
      content: [{ type: "text", text: "统计信息条已显示，数据每 5 秒自动刷新。" }],
    };
  },
);

registerAppTool(
  server,
  "turn_stats_poll",
  {
    title: "Poll turn stats",
    description:
      "返回最近活跃 turn/thread 的最新统计。仅供信息条 widget 轮询调用，不需要模型主动调用。",
    inputSchema: z.object({}),
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  async () => {
    const stats = await tracker.collectTurnStats();
    return {
      content: [{ type: "text", text: "ok" }],
      structuredContent: stats,
    };
  },
);

registerAppTool(
  server,
  "rate_card_status",
  {
    title: "Rate card status",
    description:
      "查看本地费率卡状态（absent/ready/invalid）、来源与已配置模型数量。",
    inputSchema: z.object({}),
    _meta: { ui: {} },
  },
  async () => {
    const status = await tracker.trackerStatus();
    const local = tracker.readRateCard();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: local.status,
              source: local.card?.source ?? null,
              model_count: local.card
                ? Object.keys(local.card.models).length
                : null,
            },
            null,
            2,
          ),
        },
      ],
      structuredContent: {
        status: local.status,
        source: local.card?.source ?? null,
        model_count: local.card ? Object.keys(local.card.models).length : null,
        reason: local.reason ?? null,
      },
    };
  },
);

registerAppTool(
  server,
  "configure_rate_card",
  {
    title: "Configure rate card",
    description:
      "为指定模型 upsert 本地费率卡（rate-card.json）价格。价格单位：人民币/每百万 token（元）。写入前自动备份旧文件。",
    inputSchema: z
      .object({
        model: z
          .string()
          .min(1)
          .max(128)
          .describe("模型标识，必须与 usage tracker 记录完全一致，例如 gpt-5.6"),
        input_per_million: z
          .number()
          .nonnegative()
          .describe("未缓存输入价格（元/百万 token）"),
        cached_input_per_million: z
          .number()
          .nonnegative()
          .describe("缓存输入价格（元/百万 token）"),
        output_per_million: z
          .number()
          .nonnegative()
          .describe("输出价格（元/百万 token）"),
        credits_input_per_million: z
          .number()
          .nonnegative()
          .describe("未缓存输入 Credits（/百万 token）"),
        credits_cached_input_per_million: z
          .number()
          .nonnegative()
          .describe("缓存输入 Credits（/百万 token）"),
        credits_output_per_million: z
          .number()
          .nonnegative()
          .describe("输出 Credits（/百万 token）"),
        confidence: z
          .enum(["exact", "estimated", "user_override"])
          .describe("价格可信度"),
      })
      .describe("按模型 upsert 本地费率卡"),
    _meta: { ui: {} },
  },
  async (args) => {
    try {
      const result = tracker.configureRateCard(args ?? {});
      return {
        content: [
          {
            type: "text",
            text: `费率卡已更新：status=${result.status}，models=${result.model_count}`,
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
