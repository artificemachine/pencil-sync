import type { Settings } from "../types.js";
import type { AIRunner } from "./runner.interface.js";

export async function createRunner(settings: Settings): Promise<AIRunner> {
  // settings.provider takes precedence over the legacy settings.aiProvider field
  const effectiveProvider = settings.provider ?? settings.aiProvider;
  const { apiKey, apiBaseUrl, model } = settings;

  if (!effectiveProvider || effectiveProvider === "claude-cli") {
    throw new Error(
      "settings.aiProvider is required for direct AI runner mode. " +
        "Set aiProvider to 'anthropic', 'openai-compatible', or 'google'.",
    );
  }
  if (!apiKey) {
    throw new Error(`settings.apiKey is required when provider is '${effectiveProvider}'.`);
  }

  if (effectiveProvider === "anthropic") {
    const { AnthropicRunner } = await import("./anthropic.js");
    return new AnthropicRunner(apiKey, model);
  }

  if (effectiveProvider === "openai-compatible") {
    const { OpenAICompatRunner } = await import("./openai-compat.js");
    return new OpenAICompatRunner({ apiKey, baseURL: apiBaseUrl, defaultModel: model });
  }

  if (effectiveProvider === "google") {
    try {
      const { GoogleRunner } = await import("./google.js");
      return new GoogleRunner(apiKey, model ?? "gemini-1.5-pro");
    } catch {
      throw new Error(
        "Google runner requires @google/generative-ai — run: npm install @google/generative-ai",
      );
    }
  }

  throw new Error(
    `Unknown provider: '${String(effectiveProvider)}'. Must be 'anthropic', 'openai-compatible', or 'google'.`,
  );
}
