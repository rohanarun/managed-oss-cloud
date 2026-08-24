import { z } from "zod";

const aiResultSchema = z.object({
  proposal: z.string().trim().min(1).max(20_000),
  evidence: z.array(z.string().uuid()).max(100).default([]),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  approvalRequired: z.literal(true),
}).passthrough();

export type ValidatedAiResult = z.infer<typeof aiResultSchema>;

export function validateAiResult(value: unknown, allowedRecordIds: Iterable<string>): ValidatedAiResult {
  const parsed = aiResultSchema.parse(value);
  const allowed = new Set(allowedRecordIds);
  const evidence = [...new Set(parsed.evidence)];
  const disallowed = evidence.filter((recordId) => !allowed.has(recordId));
  if (disallowed.length) throw new Error("The model cited records outside its authorized workspace context.");
  return { ...parsed, evidence };
}
