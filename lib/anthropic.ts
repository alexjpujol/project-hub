import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const MODEL = "claude-opus-5-5";

/** Projects up to this size are answered with every document in context (Path A). */
export const FULL_CONTEXT_TOKEN_LIMIT = 120_000;

/**
 * Re-runs a request the model declines on Anthropic's recommended fallback
 * model, so a safety-classifier false positive doesn't become an error.
 */
export const FALLBACK_PARAMS: Pick<MessageCreateParamsBase, "betas" | "fallbacks"> = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let client: Anthropic | undefined;

export function anthropic() {
  client ??= new Anthropic();
  return client;
}
