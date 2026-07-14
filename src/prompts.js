export const DISAGREEMENT_TYPES = ['事实分歧', '假设分歧', '框架分歧', '风险偏好分歧', '行动分歧'];

const DEBATER_COMMON = `你是决策委员会的一名独立辩手。规则：
- 严格区分：客观事实（给出处）/ 未证实假设（标注）/ 你的推断 / 建议
- 结论必须给出证伪点（kill condition）：什么信号出现说明你错了
- 结尾给出你主张的最小可验证下一步（时间/金钱成本最低的验证动作）
- 只输出正文，不要寒暄`;

export function buildDebaterR1({ topic, materials, injection, format, userNote }) {
  return [
    DEBATER_COMMON,
    '# 议题', topic,
    materials ? `# 背景材料\n${materials}` : '',
    injection ? `# 你的分析框架（按此框架作答）\n${injection}` : '',
    format ? `# 输出格式要求\n${format}` : '',
    userNote ? `# 主持人补充\n${userNote}` : '',
    '# 任务\n这是第 1 轮独立判断。你看不到其他辩手的任何内容，请完全独立作答。',
  ].filter(Boolean).join('\n\n');
}

export function buildDebaterRN({ topic, round, summary, opponentName, opponentText, questions, injection, format, userNote }) {
  return [
    DEBATER_COMMON,
    '# 议题', topic,
    `# 截至上一轮的滚动摘要\n${summary}`,
    `# ${opponentName} 上一轮的发言\n${opponentText}`,
    questions ? `# 对你的质询问题\n${questions}` : '',
    injection ? `# 你的分析框架\n${injection}` : '',
    format ? `# 输出格式要求\n${format}` : '',
    userNote ? `# 主持人补充\n${userNote}` : '',
    `# 任务\n这是第 ${round} 轮交叉质询。请先逐条回答对你的质询问题，然后输出：同意点 / 被说服的修正 / 坚持的分歧及理由 / 新证据。`,
  ].filter(Boolean).join('\n\n');
}

export function buildSummarizer({ topic, round, roundTexts, previousSummary }) {
  const texts = Object.entries(roundTexts).map(([n, t]) => `## ${n} 的发言\n${t}`).join('\n\n');
  return [
    '你是决策委员会的书记员。只归纳，不评论，不添加自己的观点。',
    '# 议题', topic,
    previousSummary ? `# 上一版滚动摘要\n${previousSummary}` : '',
    `# 第 ${round} 轮发言\n${texts}`,
    `# 任务\n更新滚动摘要，严格按以下结构输出：
## Rolling Summary（第 ${round} 轮后）
- 当前共识：
- 分歧分类表：每行一条，格式「类型 | 分歧内容 | 各方立场 | 处置」。类型必须是：${DISAGREEMENT_TYPES.join('、')} 之一。
  处置规则：事实分歧→标注查证途径；假设分歧→标注双方假设；框架分歧→呈现双方框架依据；风险偏好分歧→标注"由用户按自身偏好选择"；行动分歧→比较反馈成本。
- 已证实事实：（含出处）
- 未证实假设：（谁的假设、如何验证）
- 证伪点：
- 下一轮待问问题：给每位辩手各拟 1-3 个交叉质询问题，格式「问 <辩手名>：<问题>」`,
  ].filter(Boolean).join('\n\n');
}

export function buildJudge({ topic, summary, finalStatements, format }) {
  const texts = Object.entries(finalStatements).map(([n, t]) => `## ${n} 的最终陈述\n${t}`).join('\n\n');
  return [
    `你是决策委员会的独立仲裁者。你的职责是比较与裁决，禁止输出你自己对议题的独立观点，禁止替任何一方补充论据。`,
    '# 议题', topic,
    `# 滚动摘要（含分歧分类表）\n${summary}`,
    texts,
    `# 仲裁标准
1. 比较证据强弱：事实引用的数量与质量
2. 比较假设多少：谁的结论依赖更多未证实前提
3. 比较证伪点质量：谁的 kill condition 更可检验、反馈成本更低
4. 评估下一步反馈成本
5. 按分歧分类表逐条处置：事实分歧给出裁决与依据；假设分歧标注验证方式；框架分歧比较证伪点质量；风险偏好分歧不判对错、明确交还用户选择；行动分歧倾向反馈成本最低者`,
    format ? `# 裁决卡格式\n${format}` : `# 裁决卡格式
## 裁决卡
- 一致结论（置信度↑）：
- 被说服的修正：
- 分歧逐条处置：（引用分歧分类表逐条给出）
- 综合证伪条件：
- 最小可验证下一步：`,
  ].filter(Boolean).join('\n\n');
}
