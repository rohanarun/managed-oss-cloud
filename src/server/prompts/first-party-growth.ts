import { createHash } from "node:crypto";
import type { FirstPartyGrowthModuleId } from "../../shared/first-party-growth-actions.js";

export interface FirstPartyGrowthPromptPolicy {
  id: string;
  version: "2026-08-24.1";
  system: string;
  forbiddenAutonomy: string[];
  resultContract: {
    version: "first-party-growth-ai-result.v1";
    proposal: "non-empty string";
    evidence: "authorized record UUIDs only";
    confidence: "number from 0 to 1";
    assumptions: "explicit string array";
    reviewStatus: "pending-human-review";
    approvalRequired: true;
    model: "executed model identifier";
  };
}

const shared = `You produce a proposal for a private multi-tenant workspace. The earlier failure pattern to prevent is treating a plausible model completion as a fact or action. Always distinguish observed evidence, assumptions, and recommendations. Cite only the authorized record IDs supplied in the request. Never claim a provider call, publication, consent, moderation decision, eligibility decision, or destination change occurred. Return a proposal for human review with confidence and explicit assumptions; never perform an external side effect.`;

export const firstPartyGrowthPromptPolicies: Record<FirstPartyGrowthModuleId, FirstPartyGrowthPromptPolicy> = {
  giveaways: {
    id: "first-party-growth.giveaways",
    version: "2026-08-24.1",
    system: `${shared} For contest integrity, use only enumerated behavioral signals and selected evidence. Never infer race, ethnicity, nationality, religion, sex, gender identity, sexual orientation, age, disability, health, family status, socioeconomic status, political belief, or another protected or sensitive trait. Never infer a protected trait from names, language, location, devices, timing, or proxies. Do not exclude an entrant, alter a weight, choose a winner, or characterize uncertainty as fraud.`,
    forbiddenAutonomy: ["protected-trait inference", "automated disqualification", "entry weight mutation", "winner selection", "outreach", "publication"],
    resultContract: { version: "first-party-growth-ai-result.v1", proposal: "non-empty string", evidence: "authorized record UUIDs only", confidence: "number from 0 to 1", assumptions: "explicit string array", reviewStatus: "pending-human-review", approvalRequired: true, model: "executed model identifier" },
  },
  testimonials: {
    id: "first-party-growth.testimonials",
    version: "2026-08-24.1",
    system: `${shared} For testimonials, preserve the submitter's exact words when quoting. Mark every paraphrase as a paraphrase. Never invent a customer, quote, metric, role, company, endorsement, consent state, or causal result. Do not moderate, redact, publish, contact a submitter, or extend consent. Treat revoked or absent publication consent as unavailable for public copy.`,
    forbiddenAutonomy: ["fabricated quote", "fabricated attribution", "consent inference", "moderation", "redaction", "publication", "outreach"],
    resultContract: { version: "first-party-growth-ai-result.v1", proposal: "non-empty string", evidence: "authorized record UUIDs only", confidence: "number from 0 to 1", assumptions: "explicit string array", reviewStatus: "pending-human-review", approvalRequired: true, model: "executed model identifier" },
  },
  "brand-pages": {
    id: "first-party-growth.brand-pages",
    version: "2026-08-24.1",
    system: `${shared} For page copy, use only facts in selected records. Never invent performance, customer, compliance, security, pricing, availability, or comparative claims. Never create, fetch, activate, or rewrite a URL; never publish a page or QR route. Clearly flag missing support and keep destination changes outside the proposal.`,
    forbiddenAutonomy: ["fabricated claim", "URL creation", "URL fetch", "destination mutation", "page publication", "QR activation"],
    resultContract: { version: "first-party-growth-ai-result.v1", proposal: "non-empty string", evidence: "authorized record UUIDs only", confidence: "number from 0 to 1", assumptions: "explicit string array", reviewStatus: "pending-human-review", approvalRequired: true, model: "executed model identifier" },
  },
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function firstPartyGrowthPromptDigest(moduleId: FirstPartyGrowthModuleId) {
  return createHash("sha256").update(JSON.stringify(canonical(firstPartyGrowthPromptPolicies[moduleId]))).digest("hex");
}
