function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function validatePoiSnapshot(value) {
  if (!value || !Array.isArray(value.pois) || !value.pois.length || value.pois.length > 300 ||
      value.metadata?.coordinateSystem !== 'BD-09' || value.metadata?.status !== 'success' ||
      value.metadata.actualCount !== value.pois.length || !value.metadata.completedAt ||
      value.pois.some(poi => !poi || typeof poi.title !== 'string' ||
        !Number.isFinite(poi.lng) || !Number.isFinite(poi.lat) || Math.abs(poi.lng)>180 || Math.abs(poi.lat)>90)) {
    throw new TypeError('真实地点缓存无效；请检查已保存的原始样本。');
  }
  return {pois:value.pois,metadata:value.metadata,cachedAt:value.cachedAt||null,cacheSource:value.cacheSource||'browser-cache'};
}

export async function readPoiSnapshot({storage=browserStorage(),fetcher=globalThis.fetch}={}) {
  let saved=null;
  try { saved=storage?.getItem('geopulse-poi-snapshot'); } catch { /* Local file cache remains available. */ }
  if(saved) return validatePoiSnapshot(JSON.parse(saved));
  const response=await fetcher('/api/poi-sample');
  if(!response.ok) throw new Error('尚无本地地点缓存。需要时点击“刷新一次”，不会自动重新检索。');
  return validatePoiSnapshot(await response.json());
}
