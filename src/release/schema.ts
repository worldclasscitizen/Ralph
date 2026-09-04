import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const object = { additionalProperties: false } as const;
export const ReleaseSubjectSchema = Type.Object(
  {
    version: Type.String(),
    sourceCommit: Type.String(),
    sourceTree: Type.String(),
    runtimeDigest: hash,
    dependencyDigest: hash,
    testDigest: hash,
  },
  object,
);
export const VerificationReportSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    kind: Type.Union([
      Type.Literal("ci"),
      Type.Literal("coverage"),
      Type.Literal("operational"),
      Type.Literal("accessibility"),
      Type.Literal("provider"),
      Type.Literal("comparison"),
      Type.Literal("catalog"),
      Type.Literal("installation"),
    ]),
    subject: ReleaseSubjectSchema,
    checkedAt: Type.String(),
    runner: Type.Object(
      {
        platform: Type.String(),
        node: Type.String(),
        workflowRunId: Type.Optional(Type.String()),
      },
      object,
    ),
    status: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("blocked"),
    ]),
    checks: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          passed: Type.Boolean(),
          detail: Type.Optional(Type.String()),
        },
        object,
      ),
      { minItems: 1 },
    ),
    details: Type.Record(Type.String(), Type.Unknown()),
  },
  object,
);
export type VerificationReportV1 = Static<typeof VerificationReportSchema>;
export const ProviderVerificationSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    adapter: Type.String(),
    model: Type.String(),
    cliVersion: Type.String(),
    platform: Type.String(),
    node: Type.String(),
    checkedAt: Type.String(),
    runtimeDigest: hash,
    testDigest: hash,
    reportDigest: hash,
    features: Type.Array(Type.String()),
    support: Type.Union([
      Type.Literal("verified"),
      Type.Literal("compatible"),
      Type.Literal("experimental"),
    ]),
  },
  object,
);
export type ProviderVerificationV1 = Static<typeof ProviderVerificationSchema>;
export const LiveTestBudgetSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    releaseId: Type.String(),
    maxCalls: Type.Literal(24),
    maxActiveMs: Type.Literal(1800000),
    apiSpendUsd: Type.Literal(0),
    calls: Type.Integer({ minimum: 0, maximum: 24 }),
    activeMs: Type.Number({ minimum: 0 }),
    pending: Type.Union([
      Type.Null(),
      Type.Object(
        {
          attemptId: Type.String(),
          startedAt: Type.Number(),
          reservedMs: Type.Number(),
        },
        object,
      ),
    ]),
    attempts: Type.Array(
      Type.Object(
        {
          attemptId: Type.String(),
          purpose: Type.String(),
          durationMs: Type.Number(),
          outcome: Type.String(),
          usage: Type.Unknown(),
        },
        object,
      ),
    ),
  },
  object,
);
export type LiveTestBudgetV1 = Static<typeof LiveTestBudgetSchema>;
export const ReleaseManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    releaseId: Type.String(),
    subject: ReleaseSubjectSchema,
    artifact: Type.Object(
      { file: Type.String(), integrity: Type.String(), sha256: hash },
      object,
    ),
    reports: Type.Array(
      Type.Object({ file: Type.String(), sha256: hash }, object),
    ),
    createdAt: Type.String(),
  },
  object,
);
export type ReleaseManifestV1 = Static<typeof ReleaseManifestSchema>;
const ajv = new Ajv.default({ allErrors: true, strict: false });
const validators = new Map<object, ReturnType<typeof ajv.compile>>();
export function assertReleaseSchema(schema: object, value: unknown): void {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (!validate(value))
    throw new Error(
      `Invalid release evidence: ${ajv.errorsText(validate.errors)}`,
    );
}
