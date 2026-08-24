import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateAiResult } from "../src/server/ai-result";

describe("AI result authorization", () => {
  it("accepts a bounded proposal with authorized evidence and removes duplicate citations", () => {
    const recordId = randomUUID();
    expect(validateAiResult({ proposal: "Draft a response for human review.", evidence: [recordId, recordId], assumptions: ["The customer is asking about onboarding."], approvalRequired: true }, [recordId])).toEqual({
      proposal: "Draft a response for human review.", evidence: [recordId], assumptions: ["The customer is asking about onboarding."], approvalRequired: true,
    });
  });

  it("rejects hallucinated or cross-scope evidence IDs", () => {
    expect(() => validateAiResult({ proposal: "Unsafe claim", evidence: [randomUUID()], assumptions: [], approvalRequired: true }, [])).toThrow(/outside its authorized/);
  });

  it("requires an explicit approval decision and structured fields", () => {
    expect(() => validateAiResult({ proposal: "Missing contract", evidence: [] }, [])).toThrow();
  });
});
