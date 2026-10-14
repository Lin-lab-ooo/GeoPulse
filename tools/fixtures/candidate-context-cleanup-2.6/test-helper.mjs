// Candidate-only contract harness. No browser, SDK network, Worker or real GPU.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RecordingGL } from '../../../tests/helpers/recording-renderer.mjs';
const productionURL = new URL('../../../public/js/renderer.js', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function loadCandidate(name = 'renderer.candidate.js') {
  name = process.env.GEOPULSE_CONTEXT_CANDIDATE_FILE || name;
  const manifest = JSON.parse(await readFile(new URL('./CANDIDATE.json', import.meta.url), 'utf8'));
  const bytes = await readFile(name === 'production' ? productionURL : new URL(name, import.meta.url));
  const expected = name === 'renderer.candidate.js' ? manifest.candidateSHA256 : manifest.variants?.[name]?.sha256;
  if (name === 'production') assert.ok([manifest.baseRendererSHA256, manifest.candidateSHA256, ...Object.values(manifest.variants || {}).map(v => v.sha256)].includes(hash(bytes)), 'Production source must match base or a reviewed candidate');
  else assert.equal(hash(bytes), expected, 'Candidate bytes must match the reviewed manifest');
  // Rebase imports for this in-memory candidate only; production files are never written.
  let source = bytes.toString('utf8').replace(/from '(\.\/[^']+)'/g, (_all, relative) => `from '${new URL(relative, productionURL).href}'`);
  source = source.replaceAll('import.meta.url', JSON.stringify(productionURL.href));
  return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).GeoRenderer;
}

export class Target {
  constructor(tag = 'canvas') { this.tagName = tag; this.style = {}; this.children = []; this.listeners = new Map(); this.addCounts = {}; this.removeCounts = {}; this.isConnected = false; }
  appendChild(child) { child.remove(); this.children.push(child); child.parent = this; child.isConnected = true; return child; }
  remove() { if (this.parent) { const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); } this.parent = null; this.isConnected = false; }
  addEventListener(type, fn) { this.addCounts[type] = (this.addCounts[type] || 0) + 1; if (this.throwAdd === type) throw new Error('Injected listener installation failure'); if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.removeCounts[type] = (this.removeCounts[type] || 0) + 1; this.listeners.get(type)?.delete(fn); }
  dispatch(type, event = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener(event); }
  count(type) { return this.listeners.get(type)?.size || 0; }
  first(type) { return [...(this.listeners.get(type) || [])][0]; }
  getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; }
  getContext() { return this.gl ||= new RecordingGL(this); }
  setAttribute() {} setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
}

export function batch(count = 3) {
  const positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) { positions[i * 2] = i; colors.set([30, 160, 220, 255], i * 4); ids[i] = i + 1; }
  return { groups: [{ kind: 'points', positions, colors, ids, featureCount: count }] };
}

export function fixture(Renderer, options = {}) {
  const names = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const old = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const raf = new Map(), maps = [], errors = []; let nextRAF = 0, time = 1000;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { createElement: tag => new Target(tag), head: new Target('head') };
  globalThis.requestAnimationFrame = callback => { raf.set(++nextRAF, callback); return nextRAF; };
  globalThis.cancelAnimationFrame = id => raf.delete(id);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const r = new Renderer(new Target('div'), { onError(error) { errors.push(error); options.onError?.(error); } });
  r.setAdaptive(false); r.setOptimizationOptions({ spatial: false, spatialQueryWorker: false });
  class MapDouble {
    constructor() { this.canvas = new Target(); this.gl = new RecordingGL(this.canvas); this.zoom = 12; this.heading = 0; this.tilt = 0; this.destroyed = 0; maps.push(this); }
    addLayer(layer) { this.layer = layer; }
    destroy() { this.destroyed++; if (this.emitOnDestroy) this.canvas.dispatch('webglcontextlost', { preventDefault() {} }); }
    enableScrollWheelZoom() {} enableRotate() {} enableTilt() {} addEventListener() {} checkResize() {}
    getZoom() { return this.zoom; } getHeading() { return this.heading; } getTilt() { return this.tilt; }
    setZoom(value) { this.zoom = value; } setHeading(value) { this.heading = value; } setTilt(value) { this.tilt = value; }
    centerAndZoom() {} setCenter() {} getCenter() { return { lng: 121.592, lat: 31.189 }; }
  }
  class LayerDouble { constructor(options) { this.options = options; this.removed = 0; } remove() { this.removed++; } triggerRepaint() {} stopAnimation() {} startAnimation() {} setAnimation() {} }
  window.BMap = { Map: MapDouble, WebGLCustomLayer: LayerDouble, Point: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } } };
  return { r, raf, maps, errors,
    async beginConnect() { const promise = r.connectBaidu('candidate-contract-only-key'); await Promise.resolve(); return { promise, map: maps.at(-1) }; },
    drawMap(map) { map.layer.options.onRender({ gl: map.gl, getMVPMatrix: () => r._localMatrix(), getUnitsPerPixel: () => 80, getPixelRatio: () => 1 }); },
    tick() { const callbacks = [...raf.values()]; raf.clear(); time += 16.667; for (const callback of callbacks) callback(time); },
    dispose() { r.destroy(); for (const name of names) { if (old.get(name)) Object.defineProperty(globalThis, name, old.get(name)); else delete globalThis[name]; } }
  };
}
