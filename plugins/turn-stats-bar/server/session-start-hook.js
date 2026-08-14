// SessionStart hook 回退方案：
// 若 mcp_tool hook 无法让宿主自动渲染 widget，改用本脚本输出
// additionalContext，指示模型在会话开始时调用 show_turn_stats_bar。
const output = {
  continue: true,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext:
      "【默认显示统计信息条】用户已启用 turn-stats-bar 插件并希望每个新任务默认显示统计信息条：" +
      "请在处理用户第一条消息之前立即调用 show_turn_stats_bar 工具显示信息条；" +
      "不要询问用户，也不要在回复中展开或重复统计内容。",
  },
};

process.stdout.write(JSON.stringify(output));
