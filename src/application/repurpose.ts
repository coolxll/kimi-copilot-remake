/**
 * Generic Repurpose entry point. Target-specific prompting and sanitizing
 * currently live in the implementation module while more publishing targets
 * are added incrementally.
 */
export {
  appendMissingImageLinks,
  buildRepurposePrompt,
  generateRepurpose,
  MD2CARD_EDITOR_URL,
  REPURPOSE_TARGETS,
  sanitizeXiaohongshuMarkdown,
  XIAOHONGSHU_REPURPOSE_PROMPT,
} from "./xiaohongshu";
export type { RepurposeFormat, RepurposeProgress, RepurposeRenderer, RepurposeResult, RepurposeTarget } from "./xiaohongshu";
