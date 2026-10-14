import test from 'node:test';
import assert from 'node:assert/strict';
import { streamURL, transportReceipt } from '../public/js/transport.js';

test('stream selection is explicit, defaults to identity, and preserves source parameters', () => {
  const c = { count: 100000, seed: 19, chunk: 1024, delay: 8 };
  const url = new URL(streamURL(c), 'http://localhost');
  assert.equal(url.searchParams.get('compression'), 'identity');
  assert.equal(url.searchParams.get('seed'), '19');
  assert.equal(new URL(streamURL({ ...c, compression: 'gzip' }), 'http://localhost').searchParams.get('compression'), 'gzip');
  assert.throws(() => streamURL({ ...c, compression: 'br' }), /identity or gzip/);
});
const response = encoding => ({ headers: { get: name => name === 'content-encoding' ? encoding : null } });

test('encoded body bytes and readable bytes have distinct units', () => {
  const r = transportReceipt(response('gzip'), 500, true, [{ entryType: 'resource', responseEnd: 25, encodedBodySize: 90, decodedBodySize: 500 }]);
  assert.equal(r.contentEncoding, 'gzip'); assert.equal(r.decodedResponseBytes, 500);
  assert.equal(r.encodedBodyBytes, 90); assert.equal(r.resourceTimingDecodedBytes, 500);
  assert.match(r.byteScope, /excludes response headers/);
});

test('missing, partial or zero Resource Timing never invents compressed byte counts', () => {
  for (const entries of [[], [{ entryType: 'resource', responseEnd: 25, encodedBodySize: 0 }],
    [{ entryType: 'resource', responseEnd: 0, encodedBodySize: 90 }]]) {
    assert.equal(transportReceipt(response('gzip'), 500, true, entries).encodedBodyBytes, null);
  }
  assert.equal(transportReceipt(response('gzip'), 20, false, [{ entryType: 'resource', responseEnd: 25, encodedBodySize: 90 }]).encodedBodyBytes, null);
  assert.equal(transportReceipt(response(null), 500, true).contentEncoding, 'identity');
});

test('the latest completed resource receipt is chosen without combining runs', () => {
  const r = transportReceipt(response('gzip'), 800, true, [
    { entryType: 'resource', responseEnd: 20, encodedBodySize: 90, decodedBodySize: 500 },
    { entryType: 'resource', responseEnd: 40, encodedBodySize: 120, decodedBodySize: 800 }]);
  assert.equal(r.encodedBodyBytes, 120); assert.equal(r.resourceTimingDecodedBytes, 800);
});

test('a repeated URL cannot reuse an earlier run or mismatched decoded byte receipt', () => {
  const previous = { entryType: 'resource', startTime: 5, responseEnd: 40, encodedBodySize: 120, decodedBodySize: 800 };
  assert.equal(transportReceipt(response('gzip'), 800, true, [previous], 50).encodedBodyBytes, null);
  assert.equal(transportReceipt(response('gzip'), 900, true, [{ ...previous, startTime: 51 }], 50).encodedBodyBytes, null);
  assert.equal(transportReceipt(response('gzip'), 800, true, [{ ...previous, startTime: 51 }], 50).encodedBodyBytes, 120);
});
