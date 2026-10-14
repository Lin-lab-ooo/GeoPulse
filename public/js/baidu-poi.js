// Official JSAPI LocalSearch only. The connected browser SDK owns its AK;
// this module never receives, reads, logs, or exports it.
import {gateBaiduPoiRequest} from './baidu-poi-rate-limit.js';
export const BAIDU_POI_SOURCE_URL = 'https://lbs.baidu.com/jsapi/refdoc/v4/classes/BMap.LocalSearch.html';
const NORMAL_COLOR = [58, 214, 174, 255];
const now = () => globalThis.performance?.now() ?? Date.now();

export class BaiduPoiError extends Error {
  constructor(code, message, metadata = null) {
    super(message);
    this.name = code === 'ABORTED' ? 'AbortError' : 'BaiduPoiError';
    this.code = code;
    this.metadata = metadata;
  }
}

function finitePoint(point) {
  return !!point && Number.isFinite(point.lng) && Number.isFinite(point.lat)
    && point.lng >= -180 && point.lng <= 180 && point.lat >= -90 && point.lat <= 90;
}
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new BaiduPoiError('INVALID_OPTIONS', `${name} 必须是 ${min}–${max} 的整数。`);
  return value;
}
function poiRecord(poi, keyword, pageIndex) {
  return {
    uid: typeof poi.uid === 'string' ? poi.uid.trim() : '',
    title: typeof poi.title === 'string' ? poi.title : '',
    address: typeof poi.address === 'string' ? poi.address : '',
    lng: poi.point.lng, lat: poi.point.lat, keywords: [keyword], pageIndex
  };
}
function abortIfNeeded(signal) {
  if (signal?.aborted) throw new BaiduPoiError('ABORTED', '百度真实 POI 检索已取消。');
}

/**
 * Fetch a small, bounded sample of actual POIs in a snapshot of the map bounds.
 * Maximum: 3 keywords × 2 pages × 50 results = 300 returned records before dedup.
 * No markers, synthetic replacements, crawling, or WebService requests are made.
 * timeoutMs is overridable downward for tests; the production default is 12 s/page.
 */
export async function fetchBaiduPois({ sdk, map, keywords = ['产业园', '工厂', '学校'],
  maxPages = 2, pageCapacity = 50, signal, onProgress, timeoutMs = 12000,
  gate = gateBaiduPoiRequest } = {}) {
  integer(maxPages, 1, 2, 'maxPages');
  integer(pageCapacity, 1, 50, 'pageCapacity');
  integer(timeoutMs, 1, 12000, 'timeoutMs');
  if (typeof gate !== 'function') throw new BaiduPoiError('INVALID_OPTIONS', '请求限速入口必须为函数。');
  if (!Array.isArray(keywords) || !keywords.length || keywords.length > 3
    || keywords.some(value => typeof value !== 'string' || !value.trim()))
    throw new BaiduPoiError('INVALID_OPTIONS', '请提供 1–3 个非空检索关键词。');
  keywords = [...new Set(keywords.map(value => value.trim()))];
  if (!sdk || typeof sdk.LocalSearch !== 'function' || typeof sdk.Point !== 'function'
    || typeof sdk.Bounds !== 'function' || typeof map?.getBounds !== 'function')
    throw new BaiduPoiError('SDK_UNAVAILABLE', '请先连接提供 LocalSearch 的百度地图 JSAPI 4.0。');
  abortIfNeeded(signal);
  const currentBounds = map.getBounds();
  const southWest = currentBounds?.getSouthWest?.(), northEast = currentBounds?.getNorthEast?.();
  if (!finitePoint(southWest) || !finitePoint(northEast)
    || southWest.lng > northEast.lng || southWest.lat > northEast.lat)
    throw new BaiduPoiError('INVALID_BOUNDS', '当前地图检索范围不是有效的经纬度矩形。');
  // Copy both corners: panning while the asynchronous search is running cannot
  // mutate the region of later keywords or pages.
  const boundsSnapshot = { southWest: { lng: southWest.lng, lat: southWest.lat },
    northEast: { lng: northEast.lng, lat: northEast.lat } };
  const bounds = new sdk.Bounds(new sdk.Point(southWest.lng, southWest.lat),
    new sdk.Point(northEast.lng, northEast.lat));
  const started = now();
  const metadata = {
    source: '百度地图 JSAPI 4.0 LocalSearch', sourceUrl: BAIDU_POI_SOURCE_URL,
    coordinateSystem: 'BD-09', bounds: boundsSnapshot, keywords: [...keywords],
    maxPages, pageCapacity, timeoutMs, startedAt: new Date().toISOString(),
    completedAt: null, elapsedMs: null, status: 'running', pages: [],
    queryCount: 0, rawCount: 0, actualCount: 0, duplicateCount: 0,
    invalidCoordinateCount: 0, invalidPois: [], sampleOnly: true, truncated: false
  };
  const pois = [], seen = new Map();
  const finish = status => {
    metadata.status = status;
    metadata.actualCount = pois.length;
    metadata.completedAt = new Date().toISOString();
    metadata.elapsedMs = now() - started;
  };
  try {
    for (const keyword of keywords) {
      abortIfNeeded(signal);
      let pending = null;
      const local = new sdk.LocalSearch(map, {
        pageCapacity,
        onSearchComplete(result) {
          if (!pending) return;
          try { pending.resolve({ result, status: local.getStatus() }); }
          catch (error) { pending.reject(error); }
        }
      });
      if (typeof local.searchInBounds !== 'function' || typeof local.gotoPage !== 'function'
        || typeof local.getStatus !== 'function')
        throw new BaiduPoiError('SDK_UNAVAILABLE', '百度 SDK 缺少范围检索或分页方法。');
      // The timeout belongs to the SDK request, not time spent queued/throttled.
      const requestPage = pageIndex => gate(() => new Promise((resolve, reject) => {
        let finished = false;
        const done = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          pending = null;
          error ? reject(error) : resolve(value);
        };
        const aborted = () => done(new BaiduPoiError('ABORTED', '百度真实 POI 检索已取消。'));
        const timer = setTimeout(() => done(new BaiduPoiError('TIMEOUT',
          `百度 POI 检索“${keyword}”第 ${pageIndex + 1} 页超时。`)), timeoutMs);
        pending = { resolve: value => done(null, value), reject: error => done(error) };
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) { aborted(); return; }
        metadata.queryCount++;
        try {
          if (pageIndex === 0) local.searchInBounds(keyword, bounds);
          else local.gotoPage(pageIndex);
        } catch (error) { done(error); }
      }), {signal});
      try {
        let totalPages = 1;
        for (let pageIndex = 0; pageIndex < Math.min(maxPages, totalPages); pageIndex++) {
          abortIfNeeded(signal);
          const pageStarted = now();
          const page = { keyword, pageIndex, status: null, elapsedMs: null,
            reportedPoiCount: 0, receivedCount: 0, acceptedCount: 0,
            duplicateCount: 0, invalidCoordinateCount: 0, totalPages: null };
          metadata.pages.push(page);
          let reply;
          try { reply = await requestPage(pageIndex); }
          catch (error) {
            page.elapsedMs = now() - pageStarted;
            page.error = { code: error?.name === 'AbortError' ? 'ABORTED' : error?.code || 'SDK_ERROR' };
            throw error;
          }
          page.elapsedMs = now() - pageStarted;
          const { result, status } = reply;
          page.status = status;
          abortIfNeeded(signal);
          if (status !== 0) throw new BaiduPoiError('SERVICE_ERROR',
            `百度 POI 检索失败：关键词“${keyword}”，状态码 ${String(status)}。`);
          if (!result || Array.isArray(result) || ['getCurrentNumPois', 'getPoi', 'getNumPages', 'getPageIndex']
            .some(method => typeof result[method] !== 'function'))
            throw new BaiduPoiError('INVALID_RESULT', '百度范围检索没有返回有效的 LocalResult。');
          const count = result.getCurrentNumPois();
          totalPages = result.getNumPages();
          if (!Number.isInteger(count) || count < 0 || count > pageCapacity
            || !Number.isInteger(totalPages) || totalPages < 0 || result.getPageIndex() !== pageIndex
            || (count > 0 && totalPages === 0))
            throw new BaiduPoiError('INVALID_RESULT', '百度 POI 结果数量或分页信息不一致。');
          page.reportedPoiCount = count;
          page.totalPages = totalPages;
          metadata.truncated ||= totalPages > maxPages;
          for (let index = 0; index < count; index++) {
            const poi = result.getPoi(index);
            metadata.rawCount++; page.receivedCount++;
            if (!finitePoint(poi?.point)) {
              metadata.invalidCoordinateCount++; page.invalidCoordinateCount++;
              metadata.invalidPois.push({ keyword, pageIndex, index,
                title: typeof poi?.title === 'string' ? poi.title : '', reason: 'invalid-BD-09-coordinate' });
              continue;
            }
            const record = poiRecord(poi, keyword, pageIndex);
            const key = record.uid ? `uid:${record.uid}` : `point:${JSON.stringify([record.title, record.lng, record.lat])}`;
            const previous = seen.get(key);
            if (previous) {
              metadata.duplicateCount++; page.duplicateCount++;
              if (!previous.keywords.includes(keyword)) previous.keywords.push(keyword);
              continue;
            }
            seen.set(key, record); pois.push(record); page.acceptedCount++;
          }
          metadata.actualCount = pois.length;
          if (onProgress) onProgress({ keyword, pageIndex, queryCount: metadata.queryCount,
            count: pois.length, rawCount: metadata.rawCount, status, page: { ...page } });
        }
      } finally {
        // LocalSearch has no transport abort API. Detach callbacks so late replies
        // after abort/timeout cannot mutate or replace the loaded dataset.
        try { local.setSearchCompleteCallback?.(() => {}); } catch { /* Preserve the search outcome. */ }
        try { local.clearResults?.(); } catch { /* No renderOptions means no map markers to remove. */ }
      }
    }
    abortIfNeeded(signal);
    finish(pois.length ? 'success' : 'no-results');
    return { pois, metadata };
  } catch (error) {
    const wrapped = error instanceof BaiduPoiError ? error
      : error?.name === 'AbortError' ? new BaiduPoiError('ABORTED', '百度真实 POI 检索已取消。')
      : new BaiduPoiError('SDK_ERROR', '百度 POI 检索发生异常，未替换为模拟数据。');
    finish(wrapped.code === 'ABORTED' ? 'aborted' : 'error');
    metadata.error = { code: wrapped.code, message: wrapped.message };
    wrapped.metadata = metadata;
    throw wrapped;
  }
}

/** Use the connected WebGLCustomLayer's official projection, not a manual CRS approximation. */
export function packBaiduPois(pois, projectToLayer) {
  if (!Array.isArray(pois) || typeof projectToLayer !== 'function')
    throw new BaiduPoiError('INVALID_OPTIONS', 'POI 数组和地图图层投影函数不能为空。');
  const accepted = [], records = [], rejected = [];
  let invalidCoordinateCount = 0, invalidProjectionCount = 0;
  for (let index = 0; index < pois.length; index++) {
    const poi = pois[index];
    const record = { id: null, uid: typeof poi?.uid === 'string' ? poi.uid : '',
      title: typeof poi?.title === 'string' ? poi.title : '',
      address: typeof poi?.address === 'string' ? poi.address : '',
      lng: Number.isFinite(poi?.lng) ? poi.lng : null, lat: Number.isFinite(poi?.lat) ? poi.lat : null,
      keywords: Array.isArray(poi?.keywords) ? poi.keywords.filter(value => typeof value === 'string') : [],
      rendered: false };
    records.push(record);
    let reason = null, x, y;
    if (!finitePoint(poi)) { invalidCoordinateCount++; reason = 'invalid-BD-09-coordinate'; }
    else {
      try {
        const projected = projectToLayer([poi.lng, poi.lat]);
        x = projected?.[0] ?? projected?.x; y = projected?.[1] ?? projected?.y;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(Math.fround(x))
          || !Number.isFinite(Math.fround(y))) reason = 'invalid-layer-projection';
      } catch { reason = 'layer-projection-failed'; }
      if (reason) invalidProjectionCount++;
    }
    if (reason) {
      record.reason = reason;
      rejected.push({ index, uid: record.uid, title: record.title, reason });
      continue;
    }
    record.id = accepted.length + 1; record.rendered = true;
    accepted.push([x, y]);
  }
  const positions = new Float32Array(accepted.length * 2), colors = new Uint8Array(accepted.length * 4),
    ids = new Uint32Array(accepted.length);
  for (let index = 0; index < accepted.length; index++) {
    positions.set(accepted[index], index * 2); colors.set(NORMAL_COLOR, index * 4); ids[index] = index + 1;
  }
  return {
    groups: [{ kind: 'points', positions, colors, ids, featureCount: accepted.length }],
    featureCount: accepted.length,
    source: { provider: '百度地图', method: 'JSAPI 4.0 LocalSearch',
      sourceUrl: BAIDU_POI_SOURCE_URL, coordinateSystem: 'BD-09', records },
    metadata: { inputCount: pois.length, actualCount: accepted.length, invalidCoordinateCount,
      invalidProjectionCount, rejected, inputCoordinateSystem: 'BD-09',
      coordinateSystem: 'localBaiduMercator', sourceUrl: BAIDU_POI_SOURCE_URL }
  };
}
