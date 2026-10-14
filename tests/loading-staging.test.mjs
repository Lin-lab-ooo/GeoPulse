import test from 'node:test';
import assert from 'node:assert/strict';
import { stagingPolicy, stageGeometryBatch } from '../public/js/loading-staging.js';

function fixture({ count = 12000, kind = 'polygons', cost = 1, cancelled = () => false } = {}) {
  const batch = { groups: [{ kind, positions: new Float32Array(count * 2), colors: new Uint8Array(count * 4), ids: new Uint32Array(count), featureCount: 100 }] };
  let time = 0, revision = 0, committedRevision = 0, glUploadSubmissionMs = 0;
  const slices = [], commits = [], spans = [];
  const options = { batch, clock: () => time, isCancelled: cancelled,
    getPolicy: () => stagingPolicy({ mode: 'fixed' }),
    getCommitStats: () => ({ stagingRevision: revision, committedRevision, glUploadSubmissionMs }),
    append(piece, summary) { assert.deepEqual(summary, { summaryOnly: true }); slices.push(piece); time += cost; return { revision: ++revision }; },
    async awaitCommit(requested) { commits.push(requested); committedRevision = requested; glUploadSubmissionMs += .2; time += 1; return { committedRevision, glUploadSubmissionMs }; },
    onCommit: span => spans.push(span) };
  return { options, slices, commits, spans };
}

test('fixed streaming has a bounded staging policy while the full-load comparator retains its scope', () => {
  assert.deepEqual(stagingPolicy(), { budgetMs: 4, maxVertices: 4096 });
  assert.deepEqual(stagingPolicy({ interacting: true }), { budgetMs: 2, maxVertices: 1024 });
  assert.deepEqual(stagingPolicy({ mode: 'baseline', interacting: true }), { budgetMs: Infinity, maxVertices: 4096 });
  assert.equal(stagingPolicy({ mode: 'adaptive', adaptiveBudgetMs: 1.3 }).budgetMs, 1.3);
});

test('fast batches pay one final commit and slices preserve primitive alignment and buffer ownership', async () => {
  const f = fixture(); const result = await stageGeometryBatch(f.options);
  assert.equal(result.vertices, 12000); assert.equal(result.yields, 0);
  assert.deepEqual(f.commits, [3]);
  assert.ok(f.slices.every(slice => slice.groups[0].ids.length % 3 === 0));
  assert.ok(f.slices.every(slice => slice.groups[0].positions.buffer === f.options.batch.groups[0].positions.buffer));
  assert.equal(f.slices.reduce((n, slice) => n + slice.featureCount, 0), 100);
});

test('slow staging yields within a batch and final completion follows every revision commit', async () => {
  const f = fixture({ count: 18000, cost: 3 }); const result = await stageGeometryBatch(f.options);
  assert.equal(result.vertices, 18000); assert.equal(result.yields, 2);
  assert.deepEqual(f.commits, [2, 4, 5]);
  assert.equal(f.commits.at(-1), result.revision);
  assert.equal(f.spans.reduce((n, span) => n + span.stagingMs, 0), result.stagingMs);
});

test('an interaction tightens subsequent slices without dropping the remainder', async () => {
  const f = fixture({ count: 9000, kind: 'points' });
  f.options.getPolicy = () => stagingPolicy({ interacting: f.slices.length > 0 });
  const result = await stageGeometryBatch(f.options);
  assert.equal(f.slices[0].groups[0].ids.length, 4096);
  assert.ok(f.slices.slice(1).every(slice => slice.groups[0].ids.length <= 1024));
  assert.equal(result.vertices, 9000); assert.equal(result.cancelled, false);
});

test('cancellation during a yielded commit stops staging and prevents successful acknowledgement', async () => {
  let cancelled = false;
  const f = fixture({ count: 18000, cost: 3, cancelled: () => cancelled });
  const original = f.options.awaitCommit;
  f.options.awaitCommit = async revision => { const stats = await original(revision); cancelled = true; return stats; };
  const result = await stageGeometryBatch(f.options);
  assert.equal(result.cancelled, true); assert.equal(f.slices.length, 2); assert.equal(f.spans.length, 0);
});

test('a failed or premature commit cannot be reported as a completed batch', async () => {
  const failed = fixture(); failed.options.awaitCommit = async () => { throw new Error('lost context'); };
  await assert.rejects(stageGeometryBatch(failed.options), /lost context/);
  const premature = fixture(); premature.options.awaitCommit = async () => ({ committedRevision: 0, glUploadSubmissionMs: 0 });
  await assert.rejects(stageGeometryBatch(premature.options), /before the requested revision/);
});


test('a yielded partial batch exposes cumulative confirmed vertices before later cancellation',async()=>{
 let cancelled=false;const f=fixture({count:18000,cost:3,cancelled:()=>cancelled});
 const original=f.options.awaitCommit;let calls=0;
 f.options.awaitCommit=async revision=>{const stats=await original(revision);if(++calls===2)cancelled=true;return stats;};
 const result=await stageGeometryBatch(f.options);
 assert.equal(result.cancelled,true);assert.equal(f.spans.length,1);
 assert.equal(f.spans[0].confirmedVertices,8190);
 assert.equal(result.vertices,16380);assert.ok(result.vertices>f.spans[0].confirmedVertices);
});
