export const explanationKinds = ["title", "description", "criterion", "report", "check", "activity"] as const;
export type ExplanationKind = (typeof explanationKinds)[number];
export interface ExplanationItem {
  kind: ExplanationKind;
  text: string;
}

export const explanationBatchSize = 16;
export const explanationInputLimit = 800;
