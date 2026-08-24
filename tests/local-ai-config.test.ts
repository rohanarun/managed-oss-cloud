import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRuntimeEnvironment } from "../src/server/config";

const compose = readFileSync("deploy/google-cloud/docker-compose.yml", "utf8");
const environmentExample = readFileSync(".env.example", "utf8");
const operationsGuide = readFileSync("docs/local-ai.md", "utf8");

function serviceBlock(name: string) {
  const match = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9-]+:\\n|$)`));
  if (!match) throw new Error(`Missing Compose service ${name}.`);
  return match[0];
}

describe("optional local AI runtime", () => {
  it("pins Ollama and keeps its API private with persistent models and a health check", () => {
    const ollama = serviceBlock("ollama");
    const pinnedImage = "ollama/ollama:0.32.5@sha256:4dea9fb511947e24a84237bb636b0203abcb2ff0d3fbc7b4ff865deb91362131";
    expect((compose.match(new RegExp(pinnedImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [])).toHaveLength(2);
    expect(ollama).toContain('profiles: ["local-ai"]');
    expect(ollama).toContain("/opt/managed-oss/apps/ollama:/root/.ollama");
    expect(ollama).toContain("OLLAMA_HOST: 0.0.0.0:11434");
    expect(ollama).toContain("OLLAMA_CONTEXT_LENGTH: ${LOCAL_AI_CONTEXT_LENGTH:-8192}");
    expect(ollama).toContain("healthcheck:");
    expect(ollama).toContain("ollama list");
    expect(ollama).not.toContain("ports:");
    expect(compose).not.toContain('11434:11434');
  });

  it("pulls and verifies Qwen once before starting the internally wired worker", () => {
    const initializer = serviceBlock("ollama-model-init");
    const worker = serviceBlock("local-ai-worker");
    expect(initializer).toContain('restart: "no"');
    expect(initializer).toContain("condition: service_healthy");
    expect(initializer).toContain('ollama pull "$${OLLAMA_MODEL}"');
    expect(initializer).toContain("359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7");
    expect(initializer).toContain("Model digest mismatch");
    expect(worker).toContain('profiles: ["local-ai"]');
    expect(worker).toContain("condition: service_completed_successfully");
    expect(worker).toContain("AI_MODE: openai-compatible");
    expect(worker).toContain("AI_BASE_URL: http://ollama:11434/v1");
    expect(worker).toContain("AI_MODEL: ${LOCAL_AI_MODEL:-qwen3:4b}");
    expect(serviceBlock("ai-worker")).toContain('profiles: ["ai"]');
  });

  it("accepts local and hosted OpenAI-compatible endpoints and rejects unsafe configuration", () => {
    expect(parseRuntimeEnvironment({ AI_MODE: "openai-compatible", AI_BASE_URL: "http://ollama:11434/v1", AI_MODEL: "qwen3:4b" })).toMatchObject({ AI_MODE: "openai-compatible", AI_MODEL: "qwen3:4b" });
    expect(parseRuntimeEnvironment({ AI_MODE: "openai-compatible", AI_BASE_URL: "https://provider.example/openai/v1", AI_MODEL: "provider/model-4b", AI_API_KEY: "secret" })).toMatchObject({ AI_BASE_URL: "https://provider.example/openai/v1" });
    expect(() => parseRuntimeEnvironment({ AI_MODE: "openai-compatible", AI_BASE_URL: "http://ollama:11434/api", AI_MODEL: "qwen3:4b" })).toThrow(/end in \/v1/);
    expect(() => parseRuntimeEnvironment({ AI_MODE: "openai-compatible", AI_BASE_URL: "http://0.0.0.0:11434/v1", AI_MODEL: "qwen3:4b" })).toThrow(/wildcard bind/);
    expect(() => parseRuntimeEnvironment({ AI_MODE: "openai-compatible", AI_BASE_URL: "https://user:pass@provider.example/v1?key=value", AI_MODEL: "qwen3:4b" })).toThrow(/must not embed/);
    expect(() => parseRuntimeEnvironment({ AI_MODE: "openai-compatible", AI_BASE_URL: "http://ollama:11434/v1", AI_MODEL: "qwen model" })).toThrow();
  });

  it("documents model identity, resource limits, opt-in behavior, and both endpoint modes", () => {
    expect(environmentExample).toContain("LOCAL_AI_MODEL=qwen3:4b");
    expect(environmentExample).toContain("LOCAL_AI_NUM_PARALLEL=1");
    expect(operationsGuide).toContain("Apache-2.0");
    expect(operationsGuide).toContain("at least 10 GB");
    expect(operationsGuide).toContain("--profile local-ai");
    expect(operationsGuide).toContain("--profile ai");
    expect(operationsGuide).toContain("Do not add `ports:");
  });
});
