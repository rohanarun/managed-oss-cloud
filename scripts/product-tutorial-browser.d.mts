import type { Page } from "playwright-core";

export interface TutorialProduct {
  slug: string;
  name: string;
  moduleId: string;
  url: string;
  primaryActionId: string;
  primaryActionTitle: string;
  primaryRecordType?: string;
  tutorialInput: Record<string, unknown>;
}

export interface TutorialStep {
  id: "overview" | "connect" | "configure" | "execute" | "inspect";
  label: string;
  fact: string;
  observedAt: string;
}

export interface TutorialWorkflowProof {
  product: Pick<TutorialProduct, "slug" | "name" | "moduleId">;
  action: { id: string; title: string; httpStatus: number };
  record: { id: string; recordType: string; title: string; state: string };
  detail: { httpStatus: number; matched: true };
  steps: TutorialStep[];
}

export function findChromiumExecutable(): Promise<string>;
export function fillGuidedActionForm(page: Page, input: Record<string, unknown>): Promise<void>;
export function runProductTutorialWorkflow(
  page: Page,
  options: {
    product: TutorialProduct;
    webKey: string;
    animatePointer?: boolean;
    onStep?: (step: TutorialStep) => Promise<void> | void;
    pause?: (step: TutorialStep | { id: "complete"; label: string; fact: string }) => Promise<void> | void;
  },
): Promise<TutorialWorkflowProof>;
