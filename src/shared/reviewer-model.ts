/** Reviewer model selection types, shared by authority launch config and experience archiving. */
export type ReviewerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ReviewerModelSelection { provider: string; model: string; thinking: ReviewerThinkingLevel }
