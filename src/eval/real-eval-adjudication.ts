import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  readRealEvalSnapshotFiles,
  realEvalSourcePaths,
  type RealEvalSnapshot,
} from './real-eval-snapshot.js';
import { artifactRelativePathSchema } from '../observability/trace-contracts.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const taskIdSchema = z.string().regex(/^task-\d{3}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const realEvalRubricFactSchema = z.strictObject({
  factId: identifierSchema,
  importance: z.enum(['core', 'supporting']),
  criterion: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
});

export const realEvalTaskRubricSchema = z.strictObject({
  taskId: taskIdSchema,
  category: z.enum([
    'control_flow_and_errors',
    'tool_permissions_and_input_boundaries',
    'context_and_feedback',
    'trace_and_evidence',
  ]),
  split: z.enum(['development', 'holdout']),
  snapshotId: sha256Schema,
  requiredFacts: z.array(realEvalRubricFactSchema).min(1),
  commonErrors: z.array(z.string().min(1)),
  completePassRule: z.string().min(1),
});

export type RealEvalTaskRubric = z.infer<typeof realEvalTaskRubricSchema>;

const rubricAssessmentDimensionsSchema = z.strictObject({
  factAccuracy: z.array(
    z.enum(['accurate', 'minor_inaccuracy', 'material_error', 'not_assessable']),
  ),
  completeness: z.array(z.enum(['complete', 'partial', 'not_assessable'])),
  citationAssessment: z.array(z.enum(['valid', 'invalid', 'missing', 'not_assessable'])),
  contentLabel: z.array(z.enum(['pass', 'partial', 'fail', 'not_assessable'])),
});

const rubricGlobalRulesSchema = z.strictObject({
  pass: z.string().min(1),
  partial: z.string().min(1),
  fail: z.string().min(1),
  not_assessable: z.string().min(1),
  citationAggregation: z.string().min(1),
  strictTaskPass: z.string().min(1),
  evidenceRule: z.string().min(1),
});

export const realEvalRubricsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotId: sha256Schema,
    purpose: z.string().min(1),
    assessmentDimensions: rubricAssessmentDimensionsSchema,
    globalRules: rubricGlobalRulesSchema,
    tasks: z.array(realEvalTaskRubricSchema).length(12),
  })
  .superRefine((rubrics, context) => {
    const ids = new Set<string>();
    rubrics.tasks.forEach((task, index) => {
      if (task.snapshotId !== rubrics.snapshotId) {
        context.addIssue({
          code: 'custom',
          message: 'Every task rubric must target the top-level frozen snapshot',
          path: ['tasks', index, 'snapshotId'],
        });
      }
      if (ids.has(task.taskId)) {
        context.addIssue({
          code: 'custom',
          message: 'Task rubric IDs must be unique',
          path: ['tasks', index, 'taskId'],
        });
      }
      ids.add(task.taskId);
      const factIds = task.requiredFacts.map((fact) => fact.factId);
      if (new Set(factIds).size !== factIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Required fact IDs must be unique within a task',
          path: ['tasks', index, 'requiredFacts'],
        });
      }
    });
  });

export type RealEvalRubrics = z.infer<typeof realEvalRubricsSchema>;

export function parseRealEvalRubrics(value: unknown): RealEvalRubrics {
  return realEvalRubricsSchema.parse(value);
}

export function hashRealEvalRubrics(value: unknown): string {
  const rubrics = realEvalRubricsSchema.parse(value);
  return createHash('sha256').update(stableStringify(rubrics)).digest('hex');
}

export const realEvalBlindPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  blindSampleId: z.string().regex(/^blind-[a-f0-9-]{36}$/),
  taskId: taskIdSchema,
  snapshotId: sha256Schema,
  question: z.string().min(1),
  answer: z.string().min(1).nullable(),
});

export type RealEvalBlindPacket = z.infer<typeof realEvalBlindPacketSchema>;

const runArtifactReferencesSchema = z.strictObject({
  tracePath: artifactRelativePathSchema.nullable(),
  manifestPath: artifactRelativePathSchema.nullable(),
  finalOutputPath: artifactRelativePathSchema.nullable(),
  modelAttemptsPath: artifactRelativePathSchema.nullable(),
});

const blindSourceSchema = z
  .strictObject({
    taskId: taskIdSchema,
    snapshotId: sha256Schema,
    question: z
      .string()
      .min(1)
      .max(4_000)
      .refine((value) => value.trim().length > 0),
    taskHash: sha256Schema,
    planItemId: identifierSchema,
    sessionId: identifierSchema,
    variantId: z.enum(['A', 'B']),
    configHash: sha256Schema,
    runStatus: z.enum(['completed', 'failed', 'interrupted']),
    runtimeFailureCode: identifierSchema.nullable(),
    artifacts: runArtifactReferencesSchema,
    answer: z.string().min(1).nullable(),
  })
  .superRefine((source, context) => {
    const actualTaskHash = createHash('sha256').update(source.question).digest('hex');
    if (source.taskHash !== actualTaskHash) {
      context.addIssue({
        code: 'custom',
        message: 'The task text does not match its recorded hash',
        path: ['taskHash'],
      });
    }
    if (
      source.runStatus === 'completed' &&
      Object.values(source.artifacts).some((path) => path === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Completed runs require references to all evidence artifacts',
        path: ['artifacts'],
      });
    }
  });

export type RealEvalBlindSource = z.input<typeof blindSourceSchema>;

export const realEvalUnblindingEntrySchema = z.strictObject({
  blindSampleId: realEvalBlindPacketSchema.shape.blindSampleId,
  taskId: taskIdSchema,
  taskHash: sha256Schema,
  planItemId: identifierSchema,
  sessionId: identifierSchema,
  variantId: z.enum(['A', 'B']),
  configHash: sha256Schema,
  runStatus: z.enum(['completed', 'failed', 'interrupted']),
  runtimeFailureCode: identifierSchema.nullable(),
  artifacts: runArtifactReferencesSchema,
});

export type RealEvalUnblindingEntry = z.infer<typeof realEvalUnblindingEntrySchema>;

export function createRealEvalBlindPackets(sources: readonly RealEvalBlindSource[]): {
  readonly packets: readonly RealEvalBlindPacket[];
  readonly unblindingKey: readonly RealEvalUnblindingEntry[];
} {
  if (sources.length === 0) {
    throw new RealEvalAdjudicationError('INPUT_INVALID');
  }

  const parsed = sources.map((source) => blindSourceSchema.safeParse(source));
  if (parsed.some((source) => !source.success)) {
    throw new RealEvalAdjudicationError('INPUT_INVALID');
  }
  const values = parsed.map((source) => {
    if (!source.success) {
      throw new RealEvalAdjudicationError('INPUT_INVALID');
    }
    if (
      (source.data.runStatus === 'completed' && source.data.answer === null) ||
      (source.data.runStatus !== 'completed' && source.data.answer !== null)
    ) {
      throw new RealEvalAdjudicationError('INPUT_INVALID');
    }
    return source.data;
  });

  const sourceKeys = values.map((source) => source.planItemId);
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new RealEvalAdjudicationError('INPUT_INVALID');
  }

  const packets: RealEvalBlindPacket[] = [];
  const unblindingKey: RealEvalUnblindingEntry[] = [];
  for (const source of values) {
    const blindSampleId = `blind-${randomUUID()}`;
    packets.push(
      realEvalBlindPacketSchema.parse({
        schemaVersion: 1,
        blindSampleId,
        taskId: source.taskId,
        snapshotId: source.snapshotId,
        question: source.question,
        answer: source.answer,
      }),
    );
    unblindingKey.push(
      realEvalUnblindingEntrySchema.parse({
        blindSampleId,
        taskId: source.taskId,
        taskHash: source.taskHash,
        planItemId: source.planItemId,
        sessionId: source.sessionId,
        variantId: source.variantId,
        configHash: source.configHash,
        runStatus: source.runStatus,
        runtimeFailureCode: source.runtimeFailureCode,
        artifacts: source.artifacts,
      }),
    );
  }
  return { packets, unblindingKey };
}

const lineReferenceSchema = z.strictObject({
  path: z.string().min(1).max(256),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
});

export type RealEvalLineReference = z.infer<typeof lineReferenceSchema>;

const lineReferencePattern =
  /(?<path>src\/[a-zA-Z0-9_./-]+\.ts)(?:#L(?<hashStart>\d+)(?:-L?(?<hashEnd>\d+))?|:L?(?<colonStart>\d+)(?:-L?(?<colonEnd>\d+))?|\s+lines?\s+(?<wordStart>\d+)(?:\s*[-–]\s*(?<wordEnd>\d+))?)/gi;

export function extractRealEvalLineReferences(answer: string): RealEvalLineReference[] {
  const references: RealEvalLineReference[] = [];
  for (const match of answer.matchAll(lineReferencePattern)) {
    const path = match.groups?.['path'];
    const lineStart = Number(
      match.groups?.['hashStart'] ?? match.groups?.['colonStart'] ?? match.groups?.['wordStart'],
    );
    const lineEnd = Number(
      match.groups?.['hashEnd'] ??
        match.groups?.['colonEnd'] ??
        match.groups?.['wordEnd'] ??
        lineStart,
    );
    const parsed = lineReferenceSchema.safeParse({ path, lineStart, lineEnd });
    if (parsed.success) {
      references.push(parsed.data);
    }
  }
  return references;
}

const reviewerCitationSchema = z.strictObject({
  path: z.string().min(1).max(256),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  sourceExcerpt: z.string().min(1).max(20_000),
  supportsClaim: z.boolean(),
  rationale: z.string().min(1).max(4_000),
});

const factAssessmentSchema = z.strictObject({
  factId: identifierSchema,
  accuracy: z.enum(['accurate', 'minor_inaccuracy', 'material_error', 'not_assessable']),
  completeness: z.enum(['complete', 'partial', 'not_assessable']),
  answerExcerpt: z.string().min(1).max(8_000).nullable(),
  rationale: z.string().min(1).max(4_000),
  citations: z.array(reviewerCitationSchema),
});

const materialClaimAssessmentSchema = z.strictObject({
  answerExcerpt: z.string().min(1).max(8_000),
  assessment: z.enum(['supported', 'partially_supported', 'unsupported', 'not_assessable']),
  rationale: z.string().min(1).max(4_000),
  citations: z.array(reviewerCitationSchema),
});

export const realEvalReviewSubmissionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  blindSampleId: realEvalBlindPacketSchema.shape.blindSampleId,
  taskId: taskIdSchema,
  snapshotId: sha256Schema,
  reviewedAt: z.string().datetime({ offset: true }),
  factReviews: z.array(factAssessmentSchema),
  materialClaims: z.array(materialClaimAssessmentSchema),
});

export type RealEvalReviewSubmission = z.infer<typeof realEvalReviewSubmissionSchema>;

const citationIssueSchema = z.enum([
  'not_cited_in_answer',
  'path_not_in_snapshot',
  'line_range_invalid',
  'source_excerpt_mismatch',
  'claim_not_supported',
]);

const validatedCitationSchema = z.strictObject({
  path: z.string().min(1).max(256),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  sourceExcerpt: z.string().min(1).max(20_000),
  supportsClaim: z.boolean(),
  rationale: z.string().min(1).max(4_000),
  status: z.enum(['valid', 'invalid']),
  issues: z.array(citationIssueSchema),
});

const factReviewRecordSchema = z.strictObject({
  factId: identifierSchema,
  importance: z.enum(['core', 'supporting']),
  accuracy: z.enum(['accurate', 'minor_inaccuracy', 'material_error', 'not_assessable']),
  completeness: z.enum(['complete', 'partial', 'not_assessable']),
  answerExcerpt: z.string().min(1).max(8_000).nullable(),
  rationale: z.string().min(1).max(4_000),
  citations: z.array(validatedCitationSchema),
});

const materialClaimRecordSchema = z.strictObject({
  answerExcerpt: z.string().min(1).max(8_000),
  assessment: z.enum(['supported', 'partially_supported', 'unsupported', 'not_assessable']),
  rationale: z.string().min(1).max(4_000),
  citations: z.array(validatedCitationSchema),
});

export const realEvalAdjudicationRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    blindSampleId: realEvalBlindPacketSchema.shape.blindSampleId,
    taskId: taskIdSchema,
    snapshotId: sha256Schema,
    rubricHash: sha256Schema,
    assessmentMethod: z.literal('ai_assisted_source_review'),
    reviewedAt: z.string().datetime({ offset: true }),
    contentLabel: z.enum(['pass', 'partial', 'fail', 'not_assessable']),
    citationAssessment: z.enum(['valid', 'invalid', 'missing', 'not_assessable']),
    strictPass: z.boolean(),
    unreviewedAnswerReferences: z.array(z.string()),
    factReviews: z.array(factReviewRecordSchema),
    materialClaims: z.array(materialClaimRecordSchema),
  })
  .superRefine((record, context) => {
    const derivedLabel = deriveContentLabel(record.factReviews, record.materialClaims);
    if (record.contentLabel !== derivedLabel) {
      context.addIssue({
        code: 'custom',
        message: 'Content label does not match its recorded fact and claim assessments',
        path: ['contentLabel'],
      });
    }
    const validEvidenceIsComplete =
      record.factReviews.length > 0 &&
      record.factReviews.every(
        (fact) =>
          fact.citations.length > 0 && fact.citations.every((entry) => entry.status === 'valid'),
      ) &&
      record.materialClaims.every(
        (claim) =>
          claim.assessment === 'not_assessable' ||
          (claim.citations.length > 0 &&
            claim.citations.every((entry) => entry.status === 'valid')),
      ) &&
      record.unreviewedAnswerReferences.length === 0;
    if (record.citationAssessment === 'valid' && !validEvidenceIsComplete) {
      context.addIssue({
        code: 'custom',
        message: 'Valid citation assessment requires complete, validated evidence',
        path: ['citationAssessment'],
      });
    }
    if (
      record.strictPass !==
      (record.contentLabel === 'pass' && record.citationAssessment === 'valid')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Strict pass must require both passing content and valid citations',
        path: ['strictPass'],
      });
    }
  });

export type RealEvalAdjudicationRecord = z.infer<typeof realEvalAdjudicationRecordSchema>;

export const realEvalAdjudicationDatasetSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotId: sha256Schema,
    rubricHash: sha256Schema,
    assessmentMethod: z.literal('ai_assisted_source_review'),
    records: z.array(realEvalAdjudicationRecordSchema).min(1),
  })
  .superRefine((dataset, context) => {
    if (
      new Set(dataset.records.map((record) => record.blindSampleId)).size !== dataset.records.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Blind sample IDs must be unique in an adjudication dataset',
        path: ['records'],
      });
    }
    dataset.records.forEach((record, index) => {
      if (record.snapshotId !== dataset.snapshotId || record.rubricHash !== dataset.rubricHash) {
        context.addIssue({
          code: 'custom',
          message: 'Every record must match the dataset snapshot and rubric identities',
          path: ['records', index],
        });
      }
    });
  });

export type RealEvalAdjudicationDataset = z.infer<typeof realEvalAdjudicationDatasetSchema>;

export const realEvalUnblindedRecordSchema = z.strictObject({
  adjudication: realEvalAdjudicationRecordSchema,
  run: realEvalUnblindingEntrySchema,
});

export type RealEvalUnblindedRecord = z.infer<typeof realEvalUnblindedRecordSchema>;

export type RealEvalAdjudicationErrorCode =
  | 'INPUT_INVALID'
  | 'PACKET_MISMATCH'
  | 'REVIEW_INVALID'
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_MISMATCH'
  | 'UNBLINDING_KEY_INVALID';

const adjudicationErrorMessages: Record<RealEvalAdjudicationErrorCode, string> = {
  INPUT_INVALID: 'The blind adjudication input is invalid',
  PACKET_MISMATCH: 'The review does not match its blind packet or rubric',
  REVIEW_INVALID: 'The reviewer assessment is incomplete or inconsistent',
  SNAPSHOT_INVALID: 'The frozen source snapshot could not be verified',
  SNAPSHOT_MISMATCH: 'The packet, rubric, and source snapshot identities differ',
  UNBLINDING_KEY_INVALID: 'The unblinding key is invalid or incomplete',
};

export class RealEvalAdjudicationError extends Error {
  override readonly name = 'RealEvalAdjudicationError';
  readonly code: RealEvalAdjudicationErrorCode;

  constructor(code: RealEvalAdjudicationErrorCode) {
    super(adjudicationErrorMessages[code]);
    this.code = code;
  }
}

export interface AdjudicateRealEvalSampleOptions {
  readonly packet: RealEvalBlindPacket;
  readonly rubric: RealEvalTaskRubric;
  readonly rubricHash: string;
  readonly snapshot: RealEvalSnapshot;
  readonly review?: RealEvalReviewSubmission;
}

export async function adjudicateRealEvalSample(
  options: AdjudicateRealEvalSampleOptions,
): Promise<RealEvalAdjudicationRecord> {
  const packet = realEvalBlindPacketSchema.safeParse(options.packet);
  const rubric = realEvalTaskRubricSchema.safeParse(options.rubric);
  const rubricHash = sha256Schema.safeParse(options.rubricHash);
  if (!packet.success || !rubric.success || !rubricHash.success) {
    throw new RealEvalAdjudicationError('INPUT_INVALID');
  }
  if (
    packet.data.taskId !== rubric.data.taskId ||
    packet.data.snapshotId !== rubric.data.snapshotId ||
    packet.data.snapshotId !== options.snapshot.manifest.snapshotId
  ) {
    throw new RealEvalAdjudicationError('SNAPSHOT_MISMATCH');
  }

  if (packet.data.answer === null) {
    if (options.review !== undefined) {
      throw new RealEvalAdjudicationError('REVIEW_INVALID');
    }
    await verifySnapshotCapability(options.snapshot);
    return createNotAssessableRecord(packet.data, rubric.data, rubricHash.data);
  }

  const review = realEvalReviewSubmissionSchema.safeParse(options.review);
  if (
    !review.success ||
    review.data.blindSampleId !== packet.data.blindSampleId ||
    review.data.taskId !== packet.data.taskId ||
    review.data.snapshotId !== packet.data.snapshotId
  ) {
    throw new RealEvalAdjudicationError('PACKET_MISMATCH');
  }
  validateReviewCoverage(packet.data.answer, rubric.data, review.data);

  const answerReferences = extractRealEvalLineReferences(packet.data.answer);
  const rawCitations = [
    ...review.data.factReviews.flatMap((fact) => fact.citations),
    ...review.data.materialClaims.flatMap((claim) => claim.citations),
  ];
  const citationRecords = await validateCitations({
    answer: packet.data.answer,
    answerReferences,
    citations: rawCitations,
    snapshot: options.snapshot,
  });

  let citationIndex = 0;
  const factReviews = review.data.factReviews.map((fact) => {
    const rubricFact = rubric.data.requiredFacts.find((entry) => entry.factId === fact.factId);
    if (rubricFact === undefined) {
      throw new RealEvalAdjudicationError('REVIEW_INVALID');
    }
    const citations = citationRecords.slice(citationIndex, citationIndex + fact.citations.length);
    citationIndex += fact.citations.length;
    return {
      ...fact,
      importance: rubricFact.importance,
      citations,
    };
  });
  const materialClaims = review.data.materialClaims.map((claim) => {
    const citations = citationRecords.slice(citationIndex, citationIndex + claim.citations.length);
    citationIndex += claim.citations.length;
    return { ...claim, citations };
  });

  const unreviewedAnswerReferences = answerReferences
    .filter((reference) => !rawCitations.some((citation) => referenceCovers(reference, citation)))
    .map(formatLineReference);
  const contentLabel = deriveContentLabel(factReviews, materialClaims);
  const citationAssessment = deriveCitationAssessment(
    packet.data.answer,
    factReviews,
    materialClaims,
    unreviewedAnswerReferences,
  );
  const strictPass = contentLabel === 'pass' && citationAssessment === 'valid';

  return realEvalAdjudicationRecordSchema.parse({
    schemaVersion: 1,
    blindSampleId: packet.data.blindSampleId,
    taskId: packet.data.taskId,
    snapshotId: packet.data.snapshotId,
    rubricHash: rubricHash.data,
    assessmentMethod: 'ai_assisted_source_review',
    reviewedAt: review.data.reviewedAt,
    contentLabel,
    citationAssessment,
    strictPass,
    unreviewedAnswerReferences,
    factReviews,
    materialClaims,
  });
}

function validateReviewCoverage(
  answer: string,
  rubric: RealEvalTaskRubric,
  review: RealEvalReviewSubmission,
): void {
  const expectedFactIds = rubric.requiredFacts.map((fact) => fact.factId);
  const reviewedFactIds = review.factReviews.map((fact) => fact.factId);
  if (
    expectedFactIds.length !== reviewedFactIds.length ||
    expectedFactIds.some((factId) => !reviewedFactIds.includes(factId)) ||
    new Set(reviewedFactIds).size !== reviewedFactIds.length
  ) {
    throw new RealEvalAdjudicationError('REVIEW_INVALID');
  }
  const answerExcerpts = [
    ...review.factReviews.map((fact) => fact.answerExcerpt),
    ...review.materialClaims.map((claim) => claim.answerExcerpt),
  ];
  if (answerExcerpts.some((excerpt) => excerpt !== null && !answer.includes(excerpt))) {
    throw new RealEvalAdjudicationError('REVIEW_INVALID');
  }
  if (
    review.factReviews.some(
      (fact) =>
        (fact.completeness === 'complete' && fact.answerExcerpt === null) ||
        (fact.completeness === 'not_assessable' && fact.accuracy !== 'not_assessable') ||
        (fact.accuracy === 'not_assessable' && fact.completeness === 'complete'),
    )
  ) {
    throw new RealEvalAdjudicationError('REVIEW_INVALID');
  }
}

async function validateCitations(options: {
  readonly answer: string;
  readonly answerReferences: readonly RealEvalLineReference[];
  readonly citations: readonly z.infer<typeof reviewerCitationSchema>[];
  readonly snapshot: RealEvalSnapshot;
}): Promise<z.infer<typeof validatedCitationSchema>[]> {
  const allowedPaths = new Set<string>(realEvalSourcePaths);
  const pathsToRead = [
    ...new Set(
      options.citations.map((citation) => citation.path).filter((path) => allowedPaths.has(path)),
    ),
  ];
  if (pathsToRead.length === 0) pathsToRead.push(realEvalSourcePaths[0]);
  let sourceFiles: ReadonlyMap<string, Buffer>;
  try {
    sourceFiles = await readRealEvalSnapshotFiles(options.snapshot, pathsToRead);
  } catch {
    throw new RealEvalAdjudicationError('SNAPSHOT_INVALID');
  }

  return options.citations.map((citation) => {
    const issues: z.infer<typeof citationIssueSchema>[] = [];
    const reference: RealEvalLineReference = {
      path: citation.path,
      lineStart: citation.lineStart,
      lineEnd: citation.lineEnd,
    };
    if (
      !options.answerReferences.some((answerReference) =>
        referenceCovers(answerReference, reference),
      )
    ) {
      issues.push('not_cited_in_answer');
    }
    if (!allowedPaths.has(citation.path)) {
      issues.push('path_not_in_snapshot');
    }
    if (citation.lineEnd < citation.lineStart || citation.lineEnd - citation.lineStart > 199) {
      issues.push('line_range_invalid');
    } else if (allowedPaths.has(citation.path)) {
      const source = sourceFiles.get(citation.path);
      if (source === undefined) {
        issues.push('line_range_invalid');
      } else {
        const lines = source.toString('utf8').replaceAll('\r\n', '\n').split('\n');
        if (lines.at(-1) === '' && source.toString('utf8').endsWith('\n')) {
          lines.pop();
        }
        const selectedLines = lines.slice(citation.lineStart - 1, citation.lineEnd);
        if (
          citation.lineStart > lines.length ||
          citation.lineEnd > lines.length ||
          selectedLines.length !== citation.lineEnd - citation.lineStart + 1
        ) {
          issues.push('line_range_invalid');
        } else if (selectedLines.join('\n') !== citation.sourceExcerpt) {
          issues.push('source_excerpt_mismatch');
        }
      }
    }
    if (!citation.supportsClaim) {
      issues.push('claim_not_supported');
    }
    return {
      ...citation,
      status: issues.length === 0 ? 'valid' : 'invalid',
      issues,
    };
  });
}

async function verifySnapshotCapability(snapshot: RealEvalSnapshot): Promise<void> {
  try {
    await readRealEvalSnapshotFiles(snapshot, [realEvalSourcePaths[0]]);
  } catch {
    throw new RealEvalAdjudicationError('SNAPSHOT_INVALID');
  }
}

function referenceCovers(
  reference: RealEvalLineReference,
  citation: Pick<RealEvalLineReference, 'path' | 'lineStart' | 'lineEnd'>,
): boolean {
  return (
    reference.path === citation.path &&
    reference.lineStart <= citation.lineStart &&
    reference.lineEnd >= citation.lineEnd
  );
}

function formatLineReference(reference: RealEvalLineReference): string {
  return `${reference.path}#L${reference.lineStart}${
    reference.lineEnd === reference.lineStart ? '' : `-L${reference.lineEnd}`
  }`;
}

function deriveContentLabel(
  facts: readonly z.infer<typeof factReviewRecordSchema>[],
  claims: readonly z.infer<typeof materialClaimRecordSchema>[],
): RealEvalAdjudicationRecord['contentLabel'] {
  if (
    facts.some((fact) => fact.accuracy === 'material_error') ||
    facts.some((fact) => fact.completeness === 'partial' && fact.importance === 'core') ||
    claims.some((claim) => claim.assessment === 'unsupported')
  ) {
    return 'fail';
  }
  if (
    facts.some((fact) => fact.accuracy === 'not_assessable') ||
    facts.some((fact) => fact.completeness === 'not_assessable') ||
    claims.some((claim) => claim.assessment === 'not_assessable')
  ) {
    return 'not_assessable';
  }
  if (
    facts.some((fact) => fact.accuracy === 'minor_inaccuracy' || fact.completeness === 'partial') ||
    claims.some((claim) => claim.assessment === 'partially_supported')
  ) {
    return 'partial';
  }
  return 'pass';
}

function deriveCitationAssessment(
  answer: string,
  facts: readonly z.infer<typeof factReviewRecordSchema>[],
  claims: readonly z.infer<typeof materialClaimRecordSchema>[],
  unreviewedAnswerReferences: readonly string[],
): RealEvalAdjudicationRecord['citationAssessment'] {
  if (answer.trim().length === 0) {
    return 'not_assessable';
  }
  const allCitations = [
    ...facts.flatMap((fact) => fact.citations),
    ...claims.flatMap((claim) => claim.citations),
  ];
  if (
    allCitations.some((citation) => citation.status === 'invalid') ||
    unreviewedAnswerReferences.length > 0
  ) {
    return 'invalid';
  }
  if (
    facts.some((fact) => fact.citations.length === 0) ||
    claims.some((claim) => claim.assessment !== 'not_assessable' && claim.citations.length === 0) ||
    allCitations.length === 0
  ) {
    return 'missing';
  }
  return 'valid';
}

function createNotAssessableRecord(
  packet: RealEvalBlindPacket,
  rubric: RealEvalTaskRubric,
  rubricHash: string,
): RealEvalAdjudicationRecord {
  return realEvalAdjudicationRecordSchema.parse({
    schemaVersion: 1,
    blindSampleId: packet.blindSampleId,
    taskId: packet.taskId,
    snapshotId: packet.snapshotId,
    rubricHash,
    assessmentMethod: 'ai_assisted_source_review',
    reviewedAt: new Date().toISOString(),
    contentLabel: 'not_assessable',
    citationAssessment: 'not_assessable',
    strictPass: false,
    unreviewedAnswerReferences: [],
    factReviews: rubric.requiredFacts.map((fact) => ({
      factId: fact.factId,
      importance: fact.importance,
      accuracy: 'not_assessable',
      completeness: 'not_assessable',
      answerExcerpt: null,
      rationale: 'No final answer was available; this fact was not assessed.',
      citations: [],
    })),
    materialClaims: [],
  });
}

export function unblindRealEvalAdjudications(
  records: readonly RealEvalAdjudicationRecord[],
  unblindingKey: readonly RealEvalUnblindingEntry[],
): RealEvalUnblindedRecord[] {
  const parsedRecords = records.map((record) => realEvalAdjudicationRecordSchema.safeParse(record));
  const parsedKey = unblindingKey.map((entry) => realEvalUnblindingEntrySchema.safeParse(entry));
  if (
    parsedRecords.some((record) => !record.success) ||
    parsedKey.some((entry) => !entry.success)
  ) {
    throw new RealEvalAdjudicationError('UNBLINDING_KEY_INVALID');
  }
  const recordValues = parsedRecords.map((record) => {
    if (!record.success) throw new RealEvalAdjudicationError('UNBLINDING_KEY_INVALID');
    return record.data;
  });
  const keyValues = parsedKey.map((entry) => {
    if (!entry.success) throw new RealEvalAdjudicationError('UNBLINDING_KEY_INVALID');
    return entry.data;
  });
  if (
    new Set(recordValues.map((record) => record.blindSampleId)).size !== recordValues.length ||
    new Set(keyValues.map((entry) => entry.blindSampleId)).size !== keyValues.length ||
    recordValues.length !== keyValues.length
  ) {
    throw new RealEvalAdjudicationError('UNBLINDING_KEY_INVALID');
  }

  const byBlindId = new Map(keyValues.map((entry) => [entry.blindSampleId, entry]));
  return recordValues.map((adjudication) => {
    const run = byBlindId.get(adjudication.blindSampleId);
    if (run === undefined || run.taskId !== adjudication.taskId) {
      throw new RealEvalAdjudicationError('UNBLINDING_KEY_INVALID');
    }
    return realEvalUnblindedRecordSchema.parse({ adjudication, run });
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
