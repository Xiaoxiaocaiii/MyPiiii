import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adjudicateRealEvalSample,
  createRealEvalBlindPackets,
  extractRealEvalLineReferences,
  hashRealEvalRubrics,
  parseRealEvalRubrics,
  realEvalAdjudicationDatasetSchema,
  realEvalAdjudicationRecordSchema,
  realEvalTaskRubricSchema,
  unblindRealEvalAdjudications,
} from '../../src/eval/real-eval-adjudication.js';
import {
  computeRealEvalWorkingTreeDiffSha256,
  createRealEvalSnapshot,
  realEvalSourcePaths,
  type RealEvalSnapshot,
} from '../../src/eval/real-eval-snapshot.js';

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

const sourcePath = 'src/core/runtime.ts';
const sourceContents = new Map(
  realEvalSourcePaths.map((path) => [
    path,
    Buffer.from(
      path === sourcePath
        ? 'first line\nconst x = 1;\nreturn x;\nlast line\n'
        : `// fixture: ${path}\n`,
      'utf8',
    ),
  ]),
);

let temporaryRoot: string;
let repositoryRoot: string;
let snapshotsDirectory: string;
let snapshot: RealEvalSnapshot;

async function createFixtureSnapshot(): Promise<RealEvalSnapshot> {
  const origins = new Map(
    realEvalSourcePaths.map((path) => [
      path,
      { gitStatus: '??', baseSha256: null, diffSha256: null },
    ]),
  );
  for (const path of realEvalSourcePaths) {
    const filePath = join(repositoryRoot, ...path.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, sourceContents.get(path)!);
  }
  const workingTreeDiffSha256 = computeRealEvalWorkingTreeDiffSha256(
    realEvalSourcePaths.map((path) => ({
      path,
      sha256: sha256(sourceContents.get(path)!),
      origin: origins.get(path)!,
    })),
  );
  return createRealEvalSnapshot({
    repositoryRoot,
    snapshotsDirectory,
    baseRevision: 'b'.repeat(40),
    workingTreeDiffSha256,
    origins,
    createdAt: new Date('2026-10-24T00:00:00.000Z'),
  });
}

const taskRubric = (importance: 'core' | 'supporting' = 'core') =>
  realEvalTaskRubricSchema.parse({
    taskId: 'task-001',
    category: 'context_and_feedback',
    split: 'development',
    snapshotId: snapshot.manifest.snapshotId,
    requiredFacts: [
      {
        factId: 'fact-one',
        importance,
        criterion: 'The function returns x.',
        evidence: [`${sourcePath}#L2-L3`],
      },
    ],
    commonErrors: ['Claiming a different value is returned.'],
    completePassRule: 'State the return value and cite its implementation.',
  });

function packetFor(answer: string | null) {
  const result = createRealEvalBlindPackets([
    {
      taskId: 'task-001',
      snapshotId: snapshot.manifest.snapshotId,
      question: 'What does the function return?',
      taskHash: sha256('What does the function return?'),
      planItemId: 'task-001-A-r1',
      sessionId: 'session-hidden',
      variantId: 'A',
      configHash: 'c'.repeat(64),
      runStatus: answer === null ? 'failed' : 'completed',
      runtimeFailureCode: answer === null ? 'MODEL_CALL_FAILED' : null,
      artifacts: {
        tracePath: 'batches/batch-1/sessions/session-hidden/trace.jsonl',
        manifestPath: 'batches/batch-1/sessions/session-hidden/run-manifest.json',
        finalOutputPath: 'batches/batch-1/sessions/session-hidden/final-output.json',
        modelAttemptsPath: 'batches/batch-1/sessions/session-hidden/model-attempts.jsonl',
      },
      answer,
    },
  ]);
  return { packet: result.packets[0]!, key: result.unblindingKey };
}

function reviewFor(
  packet: Awaited<ReturnType<typeof packetFor>>['packet'],
  overrides: {
    readonly answerExcerpt?: string | null;
    readonly accuracy?: 'accurate' | 'minor_inaccuracy' | 'material_error' | 'not_assessable';
    readonly completeness?: 'complete' | 'partial' | 'not_assessable';
    readonly citations?: readonly {
      readonly path: string;
      readonly lineStart: number;
      readonly lineEnd: number;
      readonly sourceExcerpt: string;
      readonly supportsClaim: boolean;
      readonly rationale: string;
    }[];
  } = {},
) {
  return {
    schemaVersion: 1 as const,
    blindSampleId: packet.blindSampleId,
    taskId: packet.taskId,
    snapshotId: packet.snapshotId,
    reviewedAt: '2026-10-24T01:00:00.000Z',
    factReviews: [
      {
        factId: 'fact-one',
        accuracy: overrides.accuracy ?? 'accurate',
        completeness: overrides.completeness ?? 'complete',
        answerExcerpt:
          overrides.answerExcerpt === undefined
            ? 'The function returns x.'
            : overrides.answerExcerpt,
        rationale: 'The answer states the return value.',
        citations: [
          ...(overrides.citations ?? [
            {
              path: sourcePath,
              lineStart: 2,
              lineEnd: 3,
              sourceExcerpt: 'const x = 1;\nreturn x;',
              supportsClaim: true,
              rationale: 'The selected lines define and return x.',
            },
          ]),
        ],
      },
    ],
    materialClaims: [],
  };
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mypiiii-real-eval-adjudication-'));
  repositoryRoot = join(temporaryRoot, 'repository');
  snapshotsDirectory = join(temporaryRoot, 'snapshots');
  await mkdir(repositoryRoot);
  await mkdir(snapshotsDirectory);
  snapshot = await createFixtureSnapshot();
});

afterAll(async () => {
  if (snapshot !== undefined) {
    await Promise.all(
      realEvalSourcePaths.map((path) =>
        chmod(join(snapshot.rootDirectory, ...path.split('/')), 0o644).catch(() => undefined),
      ),
    );
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe('real evaluation blind adjudication', () => {
  it('keeps variant and configuration identity out of the review packet', () => {
    const { packet, key } = packetFor('The function returns x.');

    expect(JSON.stringify(packet)).not.toContain('variantId');
    expect(JSON.stringify(packet)).not.toContain('configHash');
    expect(JSON.stringify(packet)).not.toContain('session-hidden');
    expect(key[0]).toMatchObject({
      blindSampleId: packet.blindSampleId,
      variantId: 'A',
      configHash: 'c'.repeat(64),
      artifacts: {
        tracePath: 'batches/batch-1/sessions/session-hidden/trace.jsonl',
        manifestPath: 'batches/batch-1/sessions/session-hidden/run-manifest.json',
        finalOutputPath: 'batches/batch-1/sessions/session-hidden/final-output.json',
        modelAttemptsPath: 'batches/batch-1/sessions/session-hidden/model-attempts.jsonl',
      },
    });
    expect(packet).not.toHaveProperty('trace');
    expect(packet).not.toHaveProperty('history');
  });

  it('validates answer citations, line ranges, source excerpts, and strict pass', async () => {
    const { packet } = packetFor(`The function returns x. (${sourcePath}#L2-L3)`);
    const record = await adjudicateRealEvalSample({
      packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(packet),
    });

    expect(record).toMatchObject({
      contentLabel: 'pass',
      citationAssessment: 'valid',
      strictPass: true,
      assessmentMethod: 'ai_assisted_source_review',
      factReviews: [
        {
          answerExcerpt: 'The function returns x.',
          citations: [{ status: 'valid', issues: [] }],
        },
      ],
    });
    expect(
      realEvalAdjudicationRecordSchema.safeParse({
        ...record,
        factReviews: record.factReviews.map((fact) => ({
          ...fact,
          citations: fact.citations.map((citation) => ({ ...citation, status: 'invalid' })),
        })),
      }).success,
    ).toBe(false);
  });

  it('extracts supported repository path and line citation formats', () => {
    expect(
      extractRealEvalLineReferences(
        'src/core/runtime.ts#L2-L3, src/core/model.ts:L4-L5, src/core/config.ts lines 6-7',
      ),
    ).toEqual([
      { path: 'src/core/runtime.ts', lineStart: 2, lineEnd: 3 },
      { path: 'src/core/model.ts', lineStart: 4, lineEnd: 5 },
      { path: 'src/core/config.ts', lineStart: 6, lineEnd: 7 },
    ]);
  });

  it('rejects a source excerpt that does not match the frozen line range', async () => {
    const { packet } = packetFor(`The function returns x. (${sourcePath}#L2-L3)`);
    const record = await adjudicateRealEvalSample({
      packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(packet, {
        citations: [
          {
            path: sourcePath,
            lineStart: 2,
            lineEnd: 3,
            sourceExcerpt: 'return 5;',
            supportsClaim: true,
            rationale: 'This claim is supported.',
          },
        ],
      }),
    });

    expect(record.citationAssessment).toBe('invalid');
    expect(record.strictPass).toBe(false);
    expect(record.factReviews[0]?.citations[0]?.issues).toContain('source_excerpt_mismatch');
  });

  it('rejects citations that are absent from the answer or outside the snapshot', async () => {
    const { packet } = packetFor('The function returns x. No source shown.');
    const absentReference = await adjudicateRealEvalSample({
      packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(packet),
    });
    expect(absentReference.citationAssessment).toBe('invalid');
    expect(absentReference.factReviews[0]?.citations[0]?.issues).toContain('not_cited_in_answer');

    const unknownPath = 'src/core/not-in-snapshot.ts';
    const unknownPathPacket = packetFor(`The function returns x. (${unknownPath}#L2-L3)`);
    const pathRecord = await adjudicateRealEvalSample({
      packet: unknownPathPacket.packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(unknownPathPacket.packet, {
        citations: [
          {
            path: unknownPath,
            lineStart: 2,
            lineEnd: 3,
            sourceExcerpt: 'const x = 1;\nreturn x;',
            supportsClaim: true,
            rationale: 'This claim is supported.',
          },
        ],
      }),
    });
    expect(pathRecord.citationAssessment).toBe('invalid');
    expect(pathRecord.factReviews[0]?.citations[0]?.issues).toContain('path_not_in_snapshot');
  });

  it('keeps missing citations separate from content accuracy and never strictly passes', async () => {
    const { packet } = packetFor('The function returns x.');
    const review = reviewFor(packet, { citations: [] });
    const record = await adjudicateRealEvalSample({
      packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review,
    });

    expect(record.contentLabel).toBe('pass');
    expect(record.citationAssessment).toBe('missing');
    expect(record.strictPass).toBe(false);
  });

  it('records fact accuracy and completeness separately for partial answers', async () => {
    const answer = `It returns x but omits a detail. (${sourcePath}#L2-L3)`;
    const { packet } = packetFor(answer);
    const record = await adjudicateRealEvalSample({
      packet,
      rubric: taskRubric('supporting'),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(packet, {
        accuracy: 'accurate',
        completeness: 'partial',
        answerExcerpt: 'It returns x but omits a detail.',
      }),
    });

    expect(record).toMatchObject({
      contentLabel: 'partial',
      citationAssessment: 'valid',
      strictPass: false,
      factReviews: [{ accuracy: 'accurate', completeness: 'partial' }],
    });
  });

  it('marks a missing core fact as fail and an execution without an answer not assessable', async () => {
    const answer = packetFor('No answer to the question.');
    const omitted = await adjudicateRealEvalSample({
      packet: answer.packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(answer.packet, {
        accuracy: 'not_assessable',
        completeness: 'partial',
        answerExcerpt: null,
        citations: [],
      }),
    });
    expect(omitted.contentLabel).toBe('fail');
    expect(omitted.strictPass).toBe(false);

    const failedRun = packetFor(null);
    const notAssessable = await adjudicateRealEvalSample({
      packet: failedRun.packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
    });
    expect(notAssessable).toMatchObject({
      contentLabel: 'not_assessable',
      citationAssessment: 'not_assessable',
      strictPass: false,
    });
  });

  it('rejects mismatched snapshot identity and invalid snapshot capabilities', async () => {
    const { packet } = packetFor('The function returns x.');
    await expect(
      adjudicateRealEvalSample({
        packet: { ...packet, snapshotId: 'd'.repeat(64) },
        rubric: taskRubric(),
        rubricHash: 'a'.repeat(64),
        snapshot,
        review: reviewFor(packet),
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });

    await expect(
      adjudicateRealEvalSample({
        packet,
        rubric: taskRubric(),
        rubricHash: 'a'.repeat(64),
        snapshot: { ...snapshot },
        review: reviewFor(packet),
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_INVALID' });
  });

  it('unblinds only after adjudication and validates the machine-readable dataset', async () => {
    const { packet, key } = packetFor(`The function returns x. (${sourcePath}#L2-L3)`);
    const record = await adjudicateRealEvalSample({
      packet,
      rubric: taskRubric(),
      rubricHash: 'a'.repeat(64),
      snapshot,
      review: reviewFor(packet),
    });
    const dataset = realEvalAdjudicationDatasetSchema.parse({
      schemaVersion: 1,
      snapshotId: snapshot.manifest.snapshotId,
      rubricHash: 'a'.repeat(64),
      assessmentMethod: 'ai_assisted_source_review',
      records: [record],
    });
    const unblinded = unblindRealEvalAdjudications(dataset.records, key);

    expect(unblinded[0]?.run).toMatchObject({
      planItemId: 'task-001-A-r1',
      variantId: 'A',
      configHash: 'c'.repeat(64),
    });
    expect(unblinded[0]?.adjudication.strictPass).toBe(true);
  });

  it('parses a synthetic rubric fixture and hashes it deterministically', () => {
    const rubric = parseRealEvalRubrics({
      schemaVersion: 1,
      snapshotId: snapshot.manifest.snapshotId,
      purpose: 'Synthetic unit-test rubric; not used to score an evaluation run.',
      assessmentDimensions: {
        factAccuracy: ['accurate', 'minor_inaccuracy', 'material_error', 'not_assessable'],
        completeness: ['complete', 'partial', 'not_assessable'],
        citationAssessment: ['valid', 'invalid', 'missing', 'not_assessable'],
        contentLabel: ['pass', 'partial', 'fail', 'not_assessable'],
      },
      globalRules: {
        pass: 'Test fixture pass rule.',
        partial: 'Test fixture partial rule.',
        fail: 'Test fixture fail rule.',
        not_assessable: 'Test fixture not-assessable rule.',
        citationAggregation: 'Test fixture citation rule.',
        strictTaskPass: 'Test fixture strict-pass rule.',
        evidenceRule: 'Test fixture evidence rule.',
      },
      tasks: Array.from({ length: 12 }, (_, index) => ({
        taskId: `task-${String(index + 1).padStart(3, '0')}`,
        category: 'context_and_feedback',
        split: index === 0 ? 'development' : 'holdout',
        snapshotId: snapshot.manifest.snapshotId,
        requiredFacts: [
          {
            factId: 'fixture-fact',
            importance: 'core',
            criterion: 'The test fact is represented.',
            evidence: [`${sourcePath}#L2-L3`],
          },
        ],
        commonErrors: ['No evaluation claim is made by this fixture.'],
        completePassRule: 'Match the test-only evidence and citation.',
      })),
    });
    expect(rubric.tasks).toHaveLength(12);
    expect(hashRealEvalRubrics(rubric)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRealEvalRubrics(rubric)).toBe(hashRealEvalRubrics(rubric));
  });
});
