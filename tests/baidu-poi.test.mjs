import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBaiduPois, packBaiduPois } from '../public/js/baidu-poi.js';

const poi = (uid, lng = 121.592, lat = 31.189, title = uid) => ({ uid, title,
  address: '真实返回地址', point: { lng, lat } });
function fixture(catalog = {}) {
  const calls = [], instances = [];
  class Point { constructor(lng, lat) { this.lng = lng; this.lat = lat; } }
  class Bounds {
    constructor(sw, ne) { this.sw = sw; this.ne = ne; }
    getSouthWest() { return this.sw; } getNorthEast() { return this.ne; }
  }
  const liveBounds = new Bounds(new Point(121.5, 31.1), new Point(121.7, 31.3));
  class LocalSearch {
    constructor(map, opts) { this.options = opts; this.status = 0; instances.push(this); }
    getStatus() { return this.status; }
    setSearchCompleteCallback(callback) { this.options.onSearchComplete = callback; }
    clearResults() { this.cleared = true; }
    searchInBounds(keyword, bounds) { this.keyword = keyword; this.bounds = bounds; this.deliver(0); }
    gotoPage(index) { this.deliver(index); }
    deliver(index) {
      calls.push({ keyword: this.keyword, index, bounds: this.bounds });
      const entry = catalog[this.keyword] ?? [[]];
      if (entry === 'timeout') return;
      queueMicrotask(() => {
        this.status = entry.status ?? 0;
        const pages = entry.pages ?? entry, data = pages[index] ?? [];
        this.options.onSearchComplete({ getCurrentNumPois: () => data.length,
          getPoi: n => data[n], getNumPages: () => pages.length, getPageIndex: () => index });
      });
    }
  }
  return { sdk: { Point, Bounds, LocalSearch }, map: { getBounds: () => liveBounds }, gate: work => work(),
    calls, instances, liveBounds };
}

test('official callback search paginates at most two pages and deduplicates actual POIs', async () => {
  const f = fixture({ 产业园: [[poi('a'), poi('b')], [poi('a'), poi('c')], [poi('never')]],
    工厂: [[poi('b'), poi('', 121.61, 31.2, '无 UID')], [poi('', 121.61, 31.2, '无 UID')]], 学校: [[]] });
  const progress = [];
  const result = await fetchBaiduPois({ ...f, onProgress: value => progress.push(value) });
  assert.deepEqual(result.pois.map(p => p.uid), ['a', 'b', 'c', '']);
  assert.deepEqual(result.pois[1].keywords, ['产业园', '工厂']);
  assert.equal(result.metadata.queryCount, 5);
  assert.equal(result.metadata.rawCount, 7);
  assert.equal(result.metadata.actualCount, 4);
  assert.equal(result.metadata.duplicateCount, 3);
  assert.equal(result.metadata.status, 'success');
  assert.equal(result.metadata.truncated, true);
  assert.equal(result.metadata.coordinateSystem, 'BD-09');
  assert.equal(progress.length, 5);
  assert.ok(f.instances.every(local => local.options.renderOptions === undefined && local.cleared));
  assert.ok(!f.calls.some(call => call.index > 1));
});

test('bounds are copied once; panning cannot change subsequent queries', async () => {
  const f = fixture({ 产业园: [[poi('a')], [poi('b')]], 工厂: [[poi('c')]] });
  const result = await fetchBaiduPois({ ...f, keywords: ['产业园', '工厂'], onProgress() {
    f.liveBounds.sw.lng = 0; f.liveBounds.ne.lat = 89;
  } });
  assert.equal(result.metadata.bounds.southWest.lng, 121.5);
  assert.equal(result.metadata.bounds.northEast.lat, 31.3);
  assert.ok(f.calls.every(call => call.bounds.sw.lng === 121.5 && call.bounds.ne.lat === 31.3));
});

test('successful empty searches return no-results and never generate synthetic records', async () => {
  const f = fixture();
  const result = await fetchBaiduPois({ ...f, keywords: ['学校'] });
  assert.deepEqual(result.pois, []);
  assert.equal(result.metadata.status, 'no-results');
  assert.equal(result.metadata.actualCount, 0);
  assert.equal(result.metadata.queryCount, 1);
});

test('invalid coordinates are explicitly counted instead of projected', async () => {
  const f = fixture({ 学校: [[poi('bad', NaN), poi('bad2', 121, 91), poi('good')]] });
  const result = await fetchBaiduPois({ ...f, keywords: ['学校'] });
  assert.equal(result.pois.length, 1);
  assert.equal(result.metadata.invalidCoordinateCount, 2);
  assert.equal(result.metadata.pages[0].invalidCoordinateCount, 2);
  assert.equal(result.metadata.invalidPois.length, 2);
});

test('nonzero official status is a visible failure, not an empty or simulated result', async () => {
  const f = fixture({ 学校: { status: 4, pages: [[]] } });
  await assert.rejects(fetchBaiduPois({ ...f, keywords: ['学校'] }), error => {
    assert.equal(error.code, 'SERVICE_ERROR');
    assert.equal(error.metadata.status, 'error');
    assert.equal(error.metadata.pages[0].status, 4);
    assert.equal(error.metadata.actualCount, 0);
    return true;
  });
});

test('abort before starting makes no request; abort while waiting detaches late callbacks', async () => {
  const f = fixture({ 学校: 'timeout' });
  const before = new AbortController(); before.abort();
  await assert.rejects(fetchBaiduPois({ ...f, signal: before.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const during = new AbortController();
  const request = fetchBaiduPois({ ...f, keywords: ['学校'], signal: during.signal });
  during.abort();
  await assert.rejects(request, error => error.name === 'AbortError' && error.metadata.status === 'aborted');
  assert.ok(f.instances[0].cleared);
  assert.doesNotThrow(() => f.instances[0].options.onSearchComplete({}));
});

test('every page has a bounded timeout and no automatic retry', async () => {
  const f = fixture({ 学校: 'timeout' });
  await assert.rejects(fetchBaiduPois({ ...f, keywords: ['学校'], timeoutMs: 5 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.metadata.queryCount, 1);
    assert.equal(error.metadata.status, 'error');
    assert.equal(error.metadata.pages[0].error.code, 'TIMEOUT');
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.ok(f.instances[0].cleared);
});

test('waiting for the request gate does not start or consume the SDK timeout', async () => {
  const f = fixture({ 学校: [[poi('a')]] });
  const result = await fetchBaiduPois({ ...f, keywords: ['学校'], timeoutMs: 5,
    gate: async work => { await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.calls.length, 0); return work(); } });
  assert.equal(result.metadata.status, 'success');
  assert.equal(f.calls.length, 1);
});

test('cancelling in the gate never issues an SDK request', async () => {
  const f = fixture(), controller = new AbortController();
  await assert.rejects(fetchBaiduPois({ ...f, keywords: ['学校'], signal: controller.signal,
    gate: async () => { controller.abort(); const error = new Error('cancelled in queue'); error.name = 'AbortError'; throw error; } }),
  error => error.name === 'AbortError' && error.metadata.queryCount === 0 && error.metadata.pages[0].error.code === 'ABORTED');
  assert.equal(f.calls.length, 0);
});

test('abort from progress on the final page cannot finish as success', async () => {
  const f = fixture({ 学校: [[poi('a')]] }), controller = new AbortController();
  await assert.rejects(fetchBaiduPois({ ...f, keywords: ['学校'], signal: controller.signal,
    onProgress() { controller.abort(); } }), error => error.name === 'AbortError' && error.metadata.status === 'aborted');
});

test('caller cannot increase keyword, page, or capacity sampling limits', async () => {
  const f = fixture();
  for (const invalid of [{ keywords: ['a', 'b', 'c', 'd'] }, { maxPages: 3 }, { pageCapacity: 51 }, { timeoutMs: 12001 }])
    await assert.rejects(fetchBaiduPois({ ...f, ...invalid }), { code: 'INVALID_OPTIONS' });
  assert.equal(f.calls.length, 0);
});

test('official layer projection packs complete point buffers and preserves source records', () => {
  const pois = [{ uid: 'A', title: '产业园 A', address: '园区路 1 号', lng: 121.592, lat: 31.189, keywords: ['产业园'] },
    { uid: 'B', title: '学校 B', address: '学校路 2 号', lng: 121.6, lat: 31.2, keywords: ['学校'] }];
  const calls = [];
  const packed = packBaiduPois(pois, point => { calls.push(point); return [(point[0] - 121.592) * 1000, (point[1] - 31.189) * 1000]; });
  assert.deepEqual(calls, [[121.592, 31.189], [121.6, 31.2]]);
  const group = packed.groups[0];
  assert.equal(group.kind, 'points'); assert.equal(group.featureCount, 2);
  assert.ok(group.positions instanceof Float32Array && group.colors instanceof Uint8Array && group.ids instanceof Uint32Array);
  assert.equal(group.positions.length, 4); assert.equal(group.colors.length, 8); assert.equal(group.ids.length, 2);
  assert.deepEqual([...group.ids], [1, 2]);
  assert.deepEqual([...group.colors], [58, 214, 174, 255, 58, 214, 174, 255]);
  assert.ok(Math.abs(group.positions[2] - 8) < 1e-5);
  assert.equal(packed.source.records[0].uid, 'A');
  assert.equal(packed.source.records[0].address, '园区路 1 号');
  assert.equal(packed.metadata.coordinateSystem, 'localBaiduMercator');
});

test('invalid projection is reported and keeps a rejected source record with no fabricated position', () => {
  const pois = [{ uid: 'good', lng: 121, lat: 31 }, { uid: 'invalid', lng: 122, lat: 32 },
    { uid: 'throws', lng: 123, lat: 33 }, { uid: 'overflow', lng: 124, lat: 34 }, { uid: 'bad-coord', lng: NaN, lat: 31 }];
  const packed = packBaiduPois(pois, ([lng]) => {
    if (lng === 123) throw new Error('projection not ready');
    if (lng === 124) return [1e50, 0];
    return lng === 122 ? [NaN, 0] : { x: 10, y: 20 };
  });
  assert.equal(packed.featureCount, 1);
  assert.equal(packed.metadata.invalidCoordinateCount, 1);
  assert.equal(packed.metadata.invalidProjectionCount, 3);
  assert.equal(packed.metadata.rejected.length, 4);
  assert.equal(packed.source.records.length, 5);
  assert.deepEqual(packed.source.records.map(record => record.rendered), [true, false, false, false, false]);
  assert.deepEqual([...packed.groups[0].positions], [10, 20]);
  assert.equal(packed.source.records[1].id, null);
});
