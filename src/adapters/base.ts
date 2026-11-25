import type { ProviderConfig } from "../types.js";

/**
 * Resolves an API key from inline config or environment variable.
 */
export function resolveApiKey(config: ProviderConfig, defaultEnvVar?: string): string {
  if (config.apiKey && config.apiKey.trim()) {
    return config.apiKey.trim();
  }
  const envName = config.apiKeyEnv || defaultEnvVar;
  if (envName && process.env[envName]) {
    return process.env[envName]!.trim();
  }
  return "";
}

/**
 * Performs a JSON POST request using Node's native fetch with structured error reporting.
 */
export async function postJson<TResponse>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<TResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Provider HTTP ${res.status} (${url}): ${text.slice(0, 500)}`);
  }

  return JSON.parse(text) as TResponse;
}
