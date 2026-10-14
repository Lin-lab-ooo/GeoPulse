// Coordinates: local Baidu Mercator metres relative to Zhangjiang.
// Sandbox works without a map SDK or AK. Pages are never resized on append.
import { planDirtyRanges } from './dirty-ranges.js';
import { ColorDirtyState } from './color-dirty-state.js';
import { createDensityUploadPlanner, DENSITY_SCRATCH_BYTES } from './upload-density-policy.js';
import { decideSpatialWork } from './spatial-work-policy.js';
import { PrimitiveSpatialIndex } from './spatial-index.js';
import { CoarseSpatialIndex } from './coarse-spatial-index.js';
import { LiveBoundsIndex } from './live-bounds-index.js';
import { queryPickPrimitiveStarts } from './pick-spatial.js';
import { classifyProjectedBounds, createClassifierStats, viewportWorldBox } from './projected-bounds.js';
import { SpatialQueryClient } from './spatial-query-client.js';
import { FeatureOverlay } from './feature-overlay.js';
import { CoalescingUpdateQueue } from './update-queue.js';

// 0xffff is fixed primitive restart in WebGL2, even for POINTS.
const PAGE_VERTICES = 65535;
const CENTER = { lng: 121.592, lat: 31.189 };
const KINDS = ['polygons', 'lines', 'points'];
const PRIMITIVE_SIZE = { points: 1, lines: 2, polygons: 3 };
const MAX_TRACKED_FEATURES = 4096;
const KIND_ALIAS = { point: 'points', line: 'lines', polygon: 'polygons', points: 'points', lines: 'lines', polygons: 'polygons' };
const VS = [
  'attribute vec2 a_position;', 'attribute vec4 a_color;',
  'uniform mat4 u_mvpMatrix;', 'uniform float u_size;',
  'uniform float u_pixelRatio;', 'uniform float u_time;',
  'uniform float u_maxSize;', 'varying vec4 v_color;',
  'void main() {',
  '  gl_Position = u_mvpMatrix * vec4(a_position, 0.0, 1.0);',
  '  float alert = step(0.82, a_color.r) * (1.0 - step(0.48, a_color.b));',
  '  float pulse = 1.0 + alert * 0.16 * sin(u_time * 2.4);',
  '  gl_PointSize = clamp(u_size * u_pixelRatio * pulse, 1.0, u_maxSize);',
  '  v_color = a_color;',
  '}'
].join('\n');
const FS = [
  'precision mediump float;', 'varying vec4 v_color;',
  'uniform float u_round;', 'void main() {',
  '  float alpha = v_color.a;',
  '  if (u_round > 0.5) {',
  '    float d = length(gl_PointCoord * 2.0 - 1.0);',
  '    if (d > 1.0) discard;',
  '    alpha *= 1.0 - smoothstep(0.78, 1.0, d);',
  '  }',
  '  gl_FragColor = vec4(v_color.rgb, alpha);',
  '}'
].join('\n');

let sdkPromise = null;
let sequence = 0;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const isAlert = (colors, vertex) => {
  const p = vertex * 4;
  return colors[p] >= 210 && colors[p + 1] < 240 && colors[p + 2] < 120;
};
// Exactly the byte-domain predicate used by the unchanged pulse shader. The
// CPU risk detector has a narrower blue/green rule and cannot drive animation.
const hasShaderPulse = (colors, vertex) => colors[vertex * 4] >= 210 && colors[vertex * 4 + 2] <= 122;

function loadBaiduSDK(ak) {
  if (window.BMap && typeof window.BMap.WebGLCustomLayer === 'function') return Promise.resolve(window.BMap);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const callback = '__geoPulseBaidu_' + (++sequence);
    const script = document.createElement('script');
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      delete window[callback];
      script.onerror = null;
    };
    const fail = (message) => {
      if (finished) return;
      finished = true;
      cleanup();
      script.remove();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('百度地图 JSAPI 4.0 加载超时（15秒），请检查网络、AK及域名白名单。'), 15000);
    window[callback] = () => {
      if (finished) return;
      if (!window.BMap || typeof window.BMap.WebGLCustomLayer !== 'function') {
        fail('百度 SDK 未提供 JSAPI 4.0 WebGLCustomLayer，请检查 AK 授权和 SDK 版本。');
        return;
      }
      finished = true;
      cleanup();
      resolve(window.BMap);
    };
    script.async = true;
    // Official 4.0 endpoint; callback is generated, never user input.
    script.src = 'https://api.map.baidu.com/api?v=4.0&ak=' + encodeURIComponent(ak) + '&callback=' + callback;
    script.onerror = () => fail('百度地图 SDK 请求失败，请检查网络与浏览器控制台。');
    document.head.appendChild(script);
  }).catch((error) => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}

function compileProgram(gl) {
  const webgl2 = typeof gl.createVertexArray === 'function';
  const vertexSource = webgl2
    ? '#version 300 es\n' + VS.replaceAll('attribute ', 'in ').replaceAll('varying ', 'out ')
    : VS;
  const fragmentSource = webgl2
    ? '#version 300 es\n' + FS.replace('precision mediump float;', 'precision mediump float;\nout vec4 outColor;')
      .replaceAll('varying ', 'in ').replaceAll('gl_FragColor', 'outColor')
    : FS;
  const shaders = [];
  let program;
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('无法分配 WebGL 着色器。');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('着色器编译失败：' + gl.getShaderInfoLog(shader));
    }
    program = gl.createProgram();
    if (!program) throw new Error('无法分配 WebGL 程序。');
    shaders.forEach((shader) => gl.attachShader(program, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('程序链接失败：' + gl.getProgramInfoLog(program));
    const locations = {};
    for (const name of ['u_mvpMatrix', 'u_size', 'u_pixelRatio', 'u_time', 'u_maxSize', 'u_round']) {
      locations[name] = gl.getUniformLocation(program, name);
    }
    const vaoExtension = webgl2 ? null : gl.getExtension('OES_vertex_array_object');
    return {
      gl, program, locations, webgl2,
      position: gl.getAttribLocation(program, 'a_position'),
      color: gl.getAttribLocation(program, 'a_color'),
      vao: webgl2 ? gl.createVertexArray() : vaoExtension ? vaoExtension.createVertexArrayOES() : null,
      vaoExtension, maxPointSize: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]
    };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    shaders.forEach((shader) => gl.deleteShader(shader));
  }
}

export class GeoRenderer {
  constructor(container, { onFrame, onInteraction, onError, contextVersion = 'webgl' } = {}) {
    if (!container || typeof container.appendChild !== 'function') throw new TypeError('GeoRenderer 需要一个 DOM 容器。');
    this.container = container;
    this.onFrame = typeof onFrame === 'function' ? onFrame : () => {};
    this._frameListeners = new Set();
    this.onInteraction = typeof onInteraction === 'function' ? onInteraction : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.layers = { points: true, lines: true, polygons: true };
    this.pages = { points: [], lines: [], polygons: [] };
    // Geometry submission is independent of visibility. Only touched pages
    // belong here; clean pages still draw on every shared SDK callback.
    this._dirtyGeometryPages = new Set();
    this._geometrySubmission = { queuedPagesVisited: 0, pagesSubmitted: 0, cleanPagesSkipped: 0 };
    // Only explicitly subscribed IDs get bindings; ordinary million-feature
    // loads keep using the existing flat ID arrays without a global Map.
    this._trackedFeatureIds = new Set();
    this._featureBindings = new Map();
    this.pointSize = 3.2;
    this.adaptive = true;
    this.riskPreservation = true;
    this.optimization = { spatial: true, spatialPolicy: 'settled', settleFrames: 3,
      spatialBuildPolicy: 'lazy', spatialRetainOnDisable: true,
      spatialBuildExecution: 'progressive', spatialBuildBudgetMs: .75, spatialBuildChunkPrimitives: 128,
      leafSize: 64, minExtent: 8, maxDepth: 16, maxCandidateRatio: .15,
      dirtyMode: 'ranges', mergeGapBytes: 64, maxDirtyRanges: 32, colorUploadPolicy: 'density',
      // Kept for saved-option compatibility. Selection coverage is the actual
      // queried viewport; an unqueried slack band must never authorize reuse.
      selectionReuseSlack: 1.06,
      // Offload fine-tree construction and querying to a worker when the host
      // provides one. Falls back to the synchronous path per page.
      spatialQueryWorker: true, coarseCandidates: false,
      liveBounds: false, liveBoundsBlockSize: 64, liveBoundsBudgetMs: .5,
      liveBoundsChunkPrimitives: 2048, movedFilter: false, positionDirtyPolicy: 'binding-runs', spatialPicking: true };
    this._liveBoundsPending = new Set();
    this._liveBoundsCpu = { liveBoundsMutationCpuMs: 0, liveBoundsMaintenanceCpuMs: 0 };
    this._movedFilterStats = { movedPrimitivesTested: 0, movedPrimitivesRejected: 0, movedBaseCandidatesSkipped: 0 };
    this._classifierStats = createClassifierStats();
    this._featureOverlay = new FeatureOverlay();
    this._removedFeatureMoves = new Map();
    this._overlayStats = { positionUpdates: 0, removals: 0, restorations: 0, tombstoned: 0 };
    // Live-stream policy for lambda > mu: latest-wins state plus retained
    // critical events. The caller drains it; the renderer only exposes it.
    this._updateQueue = new CoalescingUpdateQueue();
    this._spatialQueryClient = null;
    this._spatialQueryFailure = null;
    this._spatialQueryFailureCount = 0;
    this._workerPageSerial = 0;
    this._spatialQueryApplied = { pages: 0, denseFallbacks: 0, staleSkips: 0, misses: 0, lastTransportMs: null };
    // Replaced per frame by the render loop; a zeroed record keeps stats() and
    // getStats() valid before the first frame and after a reset.
    this._selectionMetrics = { queryMs: 0, indexMs: 0, indexUploadSubmissionMs: 0,
      coarseQueryMs: 0, coarseBucketsTested: 0, coarseDensityGuardPages: 0, coarseEmptyPages: 0, coarseCandidatePages: 0, coarseCandidatePrimitives: 0,
      indexUploadedBytes: 0, nodesTested: 0, cacheHits: 0, spatialDenseFallbackPages: 0,
      spatialPendingFallbackPages: 0, exactReuses: 0, incrementalReuses: 0, worldBoxMisses: 0 };
    this._spatialBuildMs = 0;
    this._coarseBuildMs = 0;
    this._spatialLifecycle = { fineBuildCount: 0, fineAppendCount: 0, fineReuseCount: 0, coarseDensityGuardCount: 0 };
    this._spatialBuildQueue = [];
    this._spatialBuildCursor = 0;
    this._spatialBuildProgress = { spatialBuildChunks: 0, spatialBuildCpuMs: 0, spatialBuildSliceMaxMs: 0,
      spatialBuildMaxSliceMs: 0, spatialBuildMaxFrameMs: 0, spatialBuildCompletedCount: 0,
      spatialBuildLastReadyWallMs: 0, spatialBuildMaxReadyWallMs: 0, spatialBuildSynchronousCount: 0 };
    this.mode = 'sandbox';
    this.destroyed = false;
    this.contextLost = false;
    this.camera = { x: 0, y: 0, scale: 0, heading: 0 };
    this.matrix = new Float32Array(16);
    this._pipeline = null;
    this._gl = null;
    this._raf = 0;
    this.renderPolicy = 'demand';
    this._renderPending = true;
    this._settlePending = false;
    this._pulseActive = false;
    this._repaintPending = false;
    this._repaintSerial = 0;
    this._scheduleEpoch = 0;
    this._sdkAnimationLayer = null;
    this._sdkAnimating = false;
    this._scheduleCounters = { wakeRequests: 0, coalescedWakeRequests: 0, repaintRequests: 0,
      businessFrames: 0, drawCalls: 0, verticesSubmitted: 0, renderCpuMs: 0,
      animationStarts: 0, animationStops: 0, sandboxFrameRequests: 0, reentrantCallbacks: 0 };
    this._lastWakeReason = 'initial';
    this._map = null;
    this._layer = null;
    this._mapHost = null;
    this._connecting = null;
    this._connectCancel = null;
    this._connectToken = 0;
    this._listeners = [];
    this._contextCanvases = new Map();
    this._lastFrameTime = 0;
    this._fpsSamples = [];
    this._startTime = performance.now();
    this._stagingRevision = 0;
    this._committedRevision = 0;
    this._minimumRevision = 0;
    this._commitWaiters = new Set();
    this._commitError = null;
    this._glUploadSubmissionMs = 0;
    this._totals = { vertices: 0, features: 0, points: 0, pointAlerts: 0, cpuBytes: 0, gpuBytes: 0, uploadedBytes: 0 };
    this._frame = {
      fps: 0, frameMs: 0, frameInterval: 0, drawCalls: 0, geometryDrawCalls: 0,
      vertices: 0, pointsSubmitted: 0, pointAlertsDrawn: 0,
      culledPages: 0, visiblePages: 0, lodStride: 1, time: 0
    };
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'geo-canvas';
    this.canvas.setAttribute('aria-label', '本地 WebGL 沙盒：拖拽平移，滚轮缩放，Shift 拖拽旋转');
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      display: 'block', touchAction: 'none', cursor: 'grab'
    });
    this.container.appendChild(this.canvas);
    if (!['webgl', 'webgl2'].includes(contextVersion)) throw new TypeError('未知 WebGL 版本。');
    this._localGL = this.canvas.getContext(contextVersion, {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false
    });
    if (!this._localGL) {
      this.canvas.remove();
      throw new Error('浏览器无法创建 WebGL 上下文，请启用硬件加速。');
    }
    this._activeContextCanvas = this.canvas;
    this._bindContextEvents(this.canvas);
    this._bindInteraction();
    this._resize();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._startSandbox();
  }

  _listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    this._listeners.push(() => target.removeEventListener(type, listener, options));
  }

  _bindContextEvents(canvas) {
    if (!canvas || this._contextCanvases.has(canvas)) return;
    const lost = (event) => {
      if (this.destroyed || this._activeContextCanvas !== canvas) return;
      event.preventDefault();
      this.contextLost = true;
      this._pipeline = null;
      this._gl = null;
      this._totals.gpuBytes = 0;
      for (const kind of KINDS) for (const page of this.pages[kind]) {
        page.gpu = null; page.uploaded = 0; page.indexUploaded = 0; page.selection = null;
        if (page.count) this._dirtyGeometryPages.add(page);
      }
      this._notifyError(new Error('WebGL 上下文丢失，保留 CPU 数据并等待浏览器恢复。'));
    };
    const restored = () => {
      if (this.destroyed || this._activeContextCanvas !== canvas) return;
      this.contextLost = false;
      this._commitError = null;
      this._lastError = null;
      this._requestRender('context-restored');
    };
    // Context canvases have a shorter lifetime than the renderer's own input listeners.
    // Register both removers together so SDK teardown can release its canvas promptly.
    this._contextCanvases.set(canvas, { lost, restored });
    try {
      canvas.addEventListener('webglcontextlost', lost);
      canvas.addEventListener('webglcontextrestored', restored);
    } catch (error) {
      this._unbindContextEvents(canvas);
      throw error;
    }
  }

  _unbindContextEvents(canvas) {
    const listeners = this._contextCanvases.get(canvas);
    if (!listeners) return;
    this._contextCanvases.delete(canvas);
    canvas.removeEventListener('webglcontextlost', listeners.lost);
    canvas.removeEventListener('webglcontextrestored', listeners.restored);
  }

  _resize() {
    if (this.destroyed) return;
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.width = Math.max(1, rect.width || this.container.clientWidth || 1);
    this.height = Math.max(1, rect.height || this.container.clientHeight || 1);
    this.pixelRatio = clamp(window.devicePixelRatio || 1, 1, 2);
    const width = Math.max(1, Math.round(this.width * this.pixelRatio));
    const height = Math.max(1, Math.round(this.height * this.pixelRatio));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const previousScale = this._defaultScale;
    this._defaultScale = Math.min(this.width, this.height) / 13000;
    if (!this.camera.scale) this.camera.scale = this._defaultScale;
    else if (previousScale) this.camera.scale *= this._defaultScale / previousScale;
    if (this._map && typeof this._map.checkResize === 'function') this._map.checkResize();
    this._requestRender('resize');
  }

  _worldAt(px, py) {
    const c = Math.cos(this.camera.heading), s = Math.sin(this.camera.heading);
    const x = (px - this.width / 2) / this.camera.scale;
    const y = -(py - this.height / 2) / this.camera.scale;
    return { x: this.camera.x + c * x + s * y, y: this.camera.y - s * x + c * y };
  }

  _emitInteraction(type, extra = {}) {
    if (type !== 'pick') this._requestRender('camera-' + type);
    this.onInteraction({
      type, mode: this.mode, x: this.camera.x, y: this.camera.y,
      scale: this.camera.scale, heading: this.camera.heading * 180 / Math.PI, ...extra
    });
  }

  _bindInteraction() {
    let drag = null;
    this._listen(this.canvas, 'pointerdown', (event) => {
      if (this.mode !== 'sandbox' || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, distance: 0, rotate: event.shiftKey };
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = event.shiftKey ? 'ew-resize' : 'grabbing';
      event.preventDefault();
    });
    this._listen(this.canvas, 'pointermove', (event) => {
      if (!drag || this.mode !== 'sandbox') return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.distance += Math.hypot(dx, dy);
      drag.x = event.clientX; drag.y = event.clientY;
      if (drag.rotate || event.shiftKey) {
        this.camera.heading = (this.camera.heading + dx * 0.006) % (Math.PI * 2);
        this._emitInteraction('rotate');
      } else {
        const c = Math.cos(this.camera.heading), s = Math.sin(this.camera.heading);
        this.camera.x += (-c * dx + s * dy) / this.camera.scale;
        this.camera.y += (s * dx + c * dy) / this.camera.scale;
        this._emitInteraction('pan');
      }
    });
    const release = (event) => {
      if (!drag) return;
      const clicked = drag.distance < 5 && event.type !== 'pointercancel';
      drag = null;
      this.canvas.style.cursor = 'grab';
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (clicked) {
        const rect = this.canvas.getBoundingClientRect();
        this._pickScreen(event.clientX - rect.left, event.clientY - rect.top);
      }
    };
    this._listen(this.canvas, 'pointerup', release);
    this._listen(this.canvas, 'pointercancel', release);
    this._listen(this.canvas, 'wheel', (event) => {
      if (this.mode !== 'sandbox') return;
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const px = event.clientX - rect.left, py = event.clientY - rect.top;
      const before = this._worldAt(px, py);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * this.height : event.deltaY;
      this.camera.scale = clamp(this.camera.scale * Math.exp(-delta * 0.0015), 0.0005, 16);
      const after = this._worldAt(px, py);
      this.camera.x += before.x - after.x; this.camera.y += before.y - after.y;
      this._emitInteraction('zoom');
    }, { passive: false });
    this._listen(this.canvas, 'dblclick', () => {
      this.camera = { x: 0, y: 0, scale: this._defaultScale, heading: 0 };
      this._emitInteraction('focus');
    });
  }

  _newPage(kind) {
    const capacity = Math.floor(PAGE_VERTICES / PRIMITIVE_SIZE[kind]) * PRIMITIVE_SIZE[kind];
    const page = {
      kind, capacity, count: 0, uploaded: 0, gpu: null,
      colorDirtyStart: Infinity, colorDirtyEnd: 0, colorDirtyRanges: [], colorDirtyState: null,
      positionDirtyRanges: [],
      // Change index: vertices whose live position (or removal) differs from the
      // append-only geometry the spatial tree was built from.
      overlayMoved: new Set(), overlayRemoved: new Set(), deletedVertices: new Map(),
      movedPrimitiveStarts: new Set(), liveBoundsIndex: null, liveBoundsEmpty: false, geometryVersion: 0,
      positions: new Float32Array(capacity * 2), colors: new Uint8Array(capacity * 4),
      ids: new Uint32Array(capacity), indices: kind === 'points' ? new Uint16Array(capacity) : null,
      indexCount: 0, indexUploaded: 0, indexedUntil: 0, indexStride: 0,
      pointAlertCount: 0, pointIndexAlertCount: 0,
      pointPulseCount: 0, pointIndexPulseCount: 0,
      dataVersion: 0, alertVersion: 0, spatial: null, spatialIndexedUntil: 0,
      spatialTask: null,
      coarse: new CoarseSpatialIndex({ primitiveSize: PRIMITIVE_SIZE[kind],
        referenceCapacity: this.optimization.coarseCandidates ? Math.floor(PAGE_VERTICES / PRIMITIVE_SIZE[kind]) : null }), coarseIndexedUntil: 0, selection: null,
      minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity
    };
    if (this.optimization.liveBounds) this._createLiveBounds(page);
    this.pages[kind].push(page);
    this._totals.cpuBytes += capacity * (kind === 'points' ? 18 : 16);
    return page;
  }

  append(batch, { summaryOnly = false } = {}) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (typeof summaryOnly !== 'boolean') throw new TypeError('summaryOnly 须为布尔值。');
    if (!batch || !Array.isArray(batch.groups)) throw new TypeError('append 需要包含 groups 的批次。');
    for (const group of batch.groups) {
      const kind = group && KIND_ALIAS[group.kind];
      if (!kind) throw new TypeError('未知几何类型。');
      if (!(group.positions instanceof Float32Array) || !(group.colors instanceof Uint8Array) || !(group.ids instanceof Uint32Array)) {
        throw new TypeError('positions/colors/ids 必须是 Float32Array/Uint8Array/Uint32Array。');
      }
      const count = group.positions.length / 2;
      if (!Number.isInteger(count) || count % PRIMITIVE_SIZE[kind] || group.colors.length !== count * 4 || group.ids.length !== count) {
        throw new RangeError('顶点、RGBA、ID长度或几何完整性不一致。');
      }
      for (let i = 0; i < group.positions.length; i++) {
        if (!Number.isFinite(group.positions[i])) throw new RangeError('坐标必须为有限数值。');
      }
    }
    let groupFeatures = 0;
    for (const group of batch.groups) {
      const kind = KIND_ALIAS[group.kind], vertices = group.ids.length;
      let offset = 0;
      while (offset < vertices) {
        const list = this.pages[kind];
        let page = list[list.length - 1];
        if (!page || page.count === page.capacity) page = this._newPage(kind);
        const count = Math.min(page.capacity - page.count, vertices - offset), start = page.count;
        page.positions.set(group.positions.subarray(offset * 2, (offset + count) * 2), start * 2);
        page.colors.set(group.colors.subarray(offset * 4, (offset + count) * 4), start * 4);
        page.ids.set(group.ids.subarray(offset, offset + count), start);
        for (let i = start; i < start + count; i++) {
          const x = page.positions[i * 2], y = page.positions[i * 2 + 1];
          page.minX = Math.min(page.minX, x); page.minY = Math.min(page.minY, y);
          page.maxX = Math.max(page.maxX, x); page.maxY = Math.max(page.maxY, y);
          const tombstoned = this._featureOverlay.removedCount > 0 && this._featureOverlay.isRemoved(page.ids[i]);
          if (tombstoned) {
            page.deletedVertices.set(i, { rgba: page.colors.slice(i * 4, i * 4 + 4), moved: false });
            page.overlayRemoved.add(i); page.colors[i * 4 + 3] = 0;
          }
          if (kind === 'points' && !tombstoned && isAlert(page.colors, i)) {
            page.pointAlertCount++;
            this._totals.pointAlerts++;
          }
          if (kind === 'points' && !tombstoned && hasShaderPulse(page.colors, i)) page.pointPulseCount++;
        }
        if (this._trackedFeatureIds.size) this._bindTrackedVertices(page, start, start + count);
        page.count += count; offset += count;
        this._dirtyGeometryPages.add(page);
        page.dataVersion++; page.geometryVersion++;
        if (page.liveBoundsIndex) {
          const began = performance.now();
          page.liveBoundsIndex.append(start, page.count);
          this._publishLiveBounds(page);
          this._liveBoundsCpu.liveBoundsMutationCpuMs += performance.now() - began;
        }
        const coarseBegan = performance.now();
        page.coarse.append(page.positions, page.coarseIndexedUntil, page.count);
        page.coarseIndexedUntil = page.count;
        this._coarseBuildMs += performance.now() - coarseBegan;
        // Streaming stays cheap in lazy mode, including append while disabled.
        // Existing fine trees catch up from their own watermark on a later query.
        if (this.optimization.spatial && this.optimization.spatialBuildPolicy === 'eager') this._ensureSpatialIndex(page);
      }
      this._totals.vertices += vertices;
      if (kind === 'points') this._totals.points += vertices;
      if (Number.isFinite(group.featureCount)) groupFeatures += Math.max(0, group.featureCount);
    }
    this._totals.features += groupFeatures || (Number.isFinite(batch.featureCount) ? Math.max(0, batch.featureCount) : 0);
    this._stagingRevision += 1;
    this._requestRender('append');
    return { ...(summaryOnly ? this.getCommitStats() : this.getStats()), revision: this._stagingRevision };
  }

  _createLiveBounds(page) {
    const began = performance.now();
    page.liveBoundsIndex?.destroy();
    page.liveBoundsIndex = new LiveBoundsIndex({ positions: page.positions,
      primitiveSize: PRIMITIVE_SIZE[page.kind], vertexCapacity: page.capacity,
      blockSize: this.optimization.liveBoundsBlockSize, isRemoved: vertex => page.overlayRemoved.has(vertex) });
    page.liveBoundsIndex.append(0, page.count);
    this._publishLiveBounds(page);
    this._liveBoundsCpu.liveBoundsMutationCpuMs += performance.now() - began;
  }

  _publishLiveBounds(page) {
    const bounds = page.liveBoundsIndex.getBounds();
    page.minX = bounds.minX; page.minY = bounds.minY;
    page.maxX = bounds.maxX; page.maxY = bounds.maxY; page.liveBoundsEmpty = bounds.empty;
    if (bounds.pendingBlocks) this._liveBoundsPending.add(page);
    else this._liveBoundsPending.delete(page);
  }

  _captureLiveChanges(ids, predicate) {
    if (!this.optimization.liveBounds) return null;
    const began = performance.now(), pages = new Map(), captures = new Map();
    for (const id of ids) this._eachBindingVertex(id, (page, vertex) => {
      if (!page.liveBoundsIndex || !predicate(id, page, vertex)) return;
      let starts = pages.get(page); if (!starts) pages.set(page, starts = new Set());
      starts.add(vertex - vertex % PRIMITIVE_SIZE[page.kind]);
    });
    for (const [page, starts] of pages) captures.set(page, page.liveBoundsIndex.captureChanges(starts));
    this._liveBoundsCpu.liveBoundsMutationCpuMs += performance.now() - began;
    return captures;
  }

  _commitLiveChanges(captures, touched, kind) {
    for (const page of touched) page.geometryVersion++;
    if (!captures) return;
    const began = performance.now();
    for (const [page, token] of captures) {
      page.liveBoundsIndex.commitChanges(token, {kind});
      this._publishLiveBounds(page);
    }
    this._liveBoundsCpu.liveBoundsMutationCpuMs += performance.now() - began;
  }

  _pumpLiveBounds() {
    if (!this._liveBoundsPending.size) return;
    const began = performance.now(), limit = this.optimization.liveBoundsBudgetMs;
    let remaining = Math.max(this.optimization.liveBoundsChunkPrimitives, this.optimization.liveBoundsBlockSize);
    // Set insertion order is a rotating queue. Share one soft time budget across
    // ALL pages, including hidden/offscreen pages, and never starve a full block.
    const visits = this._liveBoundsPending.size;
    for (let i = 0; i < visits && remaining >= this.optimization.liveBoundsBlockSize; i++) {
      if (i && performance.now() - began >= limit) break;
      const page = this._liveBoundsPending.values().next().value;
      this._liveBoundsPending.delete(page);
      // First complete block may exceed a tiny soft time budget; finite progress
      // wins. Later blocks respect the remaining budget.
      const result = page.liveBoundsIndex.maintain({maxPrimitives: this.optimization.liveBoundsBlockSize, budgetMs: Infinity});
      remaining -= result.scannedPrimitives;
      const budgetMs = limit - (performance.now() - began);
      if (result.pendingBlocks && remaining >= this.optimization.liveBoundsBlockSize && budgetMs > 0) {
        const rest = page.liveBoundsIndex.maintain({maxPrimitives: remaining, budgetMs});
        remaining -= rest.scannedPrimitives;
      }
      this._publishLiveBounds(page);
    }
    this._liveBoundsCpu.liveBoundsMaintenanceCpuMs += performance.now() - began;
  }

  _bindTrackedVertices(page, start, end) {
    for (let vertex = start; vertex < end; vertex++) {
      const id = page.ids[vertex];
      if (!this._trackedFeatureIds.has(id)) continue;
      let bindings = this._featureBindings.get(id);
      if (!bindings) this._featureBindings.set(id, bindings = []);
      const last = bindings[bindings.length - 1];
      if (last && last.page === page && last.end === vertex) last.end = vertex + 1;
      else bindings.push({ page, start: vertex, end: vertex + 1 });
    }
  }

  /** Replaces subscriptions; scans existing pages once and also binds future appends. */
  trackFeatures(ids) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (!Array.isArray(ids) && !(ids instanceof Uint32Array)) throw new TypeError('订阅 ID 需要数组或 Uint32Array。');
    if (ids.length > MAX_TRACKED_FEATURES) throw new RangeError('最多订阅 4096 个要素 ID。');
    const tracked = new Set();
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id > 4294967295) throw new TypeError('订阅 ID 必须为 uint32。');
      tracked.add(id);
    }
    this._trackedFeatureIds = tracked;
    this._featureBindings.clear();
    if (tracked.size) for (const kind of KINDS) for (const page of this.pages[kind]) {
      this._bindTrackedVertices(page, 0, page.count);
    }
    return { tracked: tracked.size, bound: this._featureBindings.size };
  }

  /** RGBA bytes (0–255); unknown/unsubscribed IDs are ignored, invalid input is atomic. */
  updateFeatureColors(updates, { summaryOnly = false } = {}) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (typeof summaryOnly !== 'boolean') throw new TypeError('summaryOnly 须为布尔值。');
    if (!Array.isArray(updates)) throw new TypeError('颜色更新需要包含 id/color 的数组。');
    // Validate the whole request before changing any bytes or commit revision.
    const validated = new Map();
    for (const update of updates) {
      if (!update || !Number.isInteger(update.id) || update.id < 0 || update.id > 4294967295) {
        throw new TypeError('颜色更新 ID 必须为 uint32。');
      }
      const color = update.color;
      if ((!Array.isArray(color) && !(color instanceof Uint8Array)) || color.length !== 4 ||
          !Array.from(color).every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
        throw new RangeError('颜色需要四个 0–255 的有限整数 RGBA 值。');
      }
      validated.set(update.id, color);
    }
    let updated = 0, updatedVertices = 0, ignored = 0, unchanged = 0;
    for (const [id, color] of validated) {
      const bindings = this._featureBindings.get(id);
      if (!bindings || this._featureOverlay.isRemoved(id)) { ignored++; continue; }
      let changed = 0;
      for (const { page, start, end } of bindings) {
        for (let vertex = start; vertex < end; vertex++) {
          const offset = vertex * 4;
          if (color.every((value, channel) => page.colors[offset + channel] === value)) continue;
          const wasAlert = page.kind === 'points' && isAlert(page.colors, vertex);
          const wasPulse = page.kind === 'points' && hasShaderPulse(page.colors, vertex);
          page.colors.set(color, offset);
          if (vertex < page.uploaded) {
            page.colorDirtyStart = Math.min(page.colorDirtyStart, vertex);
            page.colorDirtyEnd = Math.max(page.colorDirtyEnd, vertex + 1);
            this._markColorDirty(page, vertex);
          }
          this._dirtyGeometryPages.add(page);
          if (page.kind === 'points') {
            const alertDelta = Number(isAlert(page.colors, vertex)) - Number(wasAlert);
            const pulseDelta = Number(hasShaderPulse(page.colors, vertex)) - Number(wasPulse);
            page.pointPulseCount += pulseDelta;
            page.pointAlertCount += alertDelta;
            this._totals.pointAlerts += alertDelta;
            // Rebuild membership and its cached quality count after promotion
            // or recovery, including uniformly sampled points whose ID stays.
            if ((alertDelta || pulseDelta) && vertex < page.indexedUntil) page.indexStride = 0;
            if (alertDelta || pulseDelta) page.alertVersion++;
          }
          changed++;
        }
      }
      if (changed) { updated++; updatedVertices += changed; }
      else unchanged++;
    }
    if (updated) {
      this._stagingRevision++;
      this._requestRender('colors');
    }
    return { ...(summaryOnly ? this.getCommitStats() : this.getStats()), revision: this._stagingRevision, updated, updatedVertices, ignored, unchanged };
  }

  _markPositionDirty(page, start) {
    const ranges = page.positionDirtyRanges, end = start + 8;
    const last = ranges[ranges.length - 1];
    // Only collapse an exact union: no clean gap, no deferred state change.
    // Repeated edits and contiguous bindings allocate one run; scattered edits
    // retain the existing planner and its byte/call trade-off at submission.
    if (this.optimization.positionDirtyPolicy === 'runs' && last && start <= last[1] && end >= last[0]) {
      last[0] = Math.min(last[0], start); last[1] = Math.max(last[1], end);
    } else ranges.push([start, end]);
  }

  _markColorDirty(page, vertex) {
    if (vertex >= page.uploaded) return;
    if (this.optimization.colorUploadPolicy === 'accumulator') {
      (page.colorDirtyState ||= new ColorDirtyState({ capacity: page.capacity })).mark(vertex);
    } else page.colorDirtyRanges.push([vertex * 4, vertex * 4 + 4]);
  }

  _eachBindingVertex(id, visit) {
    for (const { page, start, end } of this._featureBindings.get(id) ?? []) {
      for (let vertex = start; vertex < end; vertex++) visit(page, vertex);
    }
  }

  /**
   * Live position edits on top of append-only pages.
   *
   * The vertex slot keeps its index, so a move costs one 8-byte bufferSubData.
   * The fine tree still holds the old position; the overlay records the move so
   * the selection can force the feature back in whenever it might be visible.
   * Requires the feature to be subscribed, exactly like colour updates.
   */
  updateFeaturePositions(updates, { summaryOnly = false } = {}) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (typeof summaryOnly !== 'boolean') throw new TypeError('summaryOnly 须为布尔值。');
    if (!Array.isArray(updates)) throw new TypeError('位置更新需要包含 id/x/y 的数组。');
    const validated = new Map();
    for (const update of updates) {
      if (!update || !Number.isInteger(update.id) || update.id < 0 || update.id > 4294967295) {
        throw new TypeError('位置更新 ID 必须为 uint32。');
      }
      if (!Number.isFinite(update.x) || !Number.isFinite(update.y) ||
          !Number.isFinite(Math.fround(update.x)) || !Number.isFinite(Math.fround(update.y))) {
        throw new RangeError('位置更新需要有限的 Float32 局部 xy 米制坐标。');
      }
      validated.set(update.id, { id: update.id, x: Math.fround(update.x), y: Math.fround(update.y) });
    }
    const captures = this._captureLiveChanges(validated.keys(), (id, page, vertex) => {
      if (this._featureOverlay.isRemoved(id)) return false;
      const {x, y} = validated.get(id);
      return page.positions[vertex * 2] !== x || page.positions[vertex * 2 + 1] !== y;
    });
    const touched = new Set();
    let updated = 0, ignored = 0, unchanged = 0;
    for (const { id, x, y } of validated.values()) {
      const bindings = this._featureBindings.get(id);
      if (!bindings || this._featureOverlay.isRemoved(id)) { ignored++; continue; }
      let changed = 0;
      // Bindings already encode contiguous slots for one feature. Record exact
      // changed runs within a binding; random single-slot features avoid a
      // comparison with the preceding feature's dirty interval.
      for (const { page, start, end } of bindings) {
        const bindingRuns = this.optimization.positionDirtyPolicy === 'binding-runs';
        let runStart = -1, runEnd = -1;
        for (let vertex = start; vertex < end; vertex++) {
          const offset = vertex * 2;
          if (page.positions[offset] === x && page.positions[offset + 1] === y) continue;
          page.positions[offset] = x;
          page.positions[offset + 1] = y;
          page.minX = Math.min(page.minX, x); page.maxX = Math.max(page.maxX, x);
          page.minY = Math.min(page.minY, y); page.maxY = Math.max(page.maxY, y);
          if (vertex < page.uploaded) {
            const byte = offset * 4;
            if (bindingRuns) {
              if (runEnd === byte) runEnd += 8;
              else {
                if (runStart !== -1) page.positionDirtyRanges.push([runStart, runEnd]);
                runStart = byte; runEnd = byte + 8;
              }
            } else this._markPositionDirty(page, byte);
          }
          this._dirtyGeometryPages.add(page);
          page.overlayMoved.add(vertex);
          page.movedPrimitiveStarts.add(vertex - vertex % PRIMITIVE_SIZE[page.kind]);
          touched.add(page);
          changed++;
        }
        if (runStart !== -1) page.positionDirtyRanges.push([runStart, runEnd]);
      }
      if (changed) { this._featureOverlay.setPosition(id, x, y); updated++; }
      else unchanged++;
    }
    this._commitLiveChanges(captures, touched, 'update');
    if (updated) for (const page of touched) this._invalidateSelection(page);
    this._overlayStats.positionUpdates += updated;
    if (updated) {
      this._stagingRevision++;
      this._requestRender('positions');
    }
    return { ...(summaryOnly ? this.getCommitStats() : this.getStats()), revision: this._stagingRevision, updated, unchanged, ignored, overlay: this._featureOverlay.snapshot() };
  }

  /**
   * Tombstones features: the slot becomes invisible instead of compacting the
   * page, and the selection stops offering it. Reversible with restoreFeatures.
   */
  removeFeatures(ids) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (!Array.isArray(ids) && !(ids instanceof Uint32Array)) throw new TypeError('删除需要 ID 数组或 Uint32Array。');
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id > 4294967295) throw new TypeError('删除 ID 必须为 uint32。');
    }
    const captures = this._captureLiveChanges(new Set(ids), id => !this._featureOverlay.isRemoved(id));
    const touched = new Set();
    let removed = 0, ignored = 0;
    for (const id of new Set(ids)) {
      if (this._featureOverlay.isRemoved(id)) { ignored++; continue; }
      const bindings = this._featureBindings.get(id);
      if (!bindings) { ignored++; continue; }
      const position = this._featureOverlay.resolve(id)?.moved;
      if (position) this._removedFeatureMoves.set(id, position);
      this._featureOverlay.remove(id);
      this._eachBindingVertex(id, (page, vertex) => {
        const offset = vertex * 4;
        const rgba = page.colors.slice(offset, offset + 4);
        page.deletedVertices.set(vertex, { rgba, moved: page.overlayMoved.has(vertex) });
        page.overlayMoved.delete(vertex); page.overlayRemoved.add(vertex);
        if (page.kind === 'points') {
          const alert = Number(isAlert(page.colors, vertex)), pulse = Number(hasShaderPulse(page.colors, vertex));
          page.pointAlertCount -= alert; page.pointPulseCount -= pulse;
          this._totals.pointAlerts -= alert; page.alertVersion++;
        }
        if (rgba[3] !== 0) {
          page.colors[offset + 3] = 0;
          if (vertex < page.uploaded) this._markColorDirty(page, vertex);
          this._dirtyGeometryPages.add(page);
        }
        touched.add(page);
      });
      removed++;
    }
    this._commitLiveChanges(captures, touched, 'delete');
    if (removed) for (const page of touched) this._invalidateSelection(page);
    this._overlayStats.removals += removed;
    this._overlayStats.tombstoned += removed;
    if (removed) {
      this._stagingRevision++;
      this._requestRender('removals');
    }
    return { ...this.getStats(), revision: this._stagingRevision, removed, ignored, overlay: this._featureOverlay.snapshot() };
  }

  restoreFeatures(ids) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (!Array.isArray(ids) && !(ids instanceof Uint32Array)) throw new TypeError('恢复需要 ID 数组或 Uint32Array。');
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id > 4294967295) throw new TypeError('恢复 ID 必须为 uint32。');
    }
    // Validate every bound snapshot before restoring any feature.
    for (const id of new Set(ids)) if (this._featureOverlay.isRemoved(id) && this._featureBindings.has(id)) {
      this._eachBindingVertex(id, (page, vertex) => {
        if (!page.deletedVertices.has(vertex)) throw new Error('删除状态缺少颜色快照。');
      });
    }
    const captures = this._captureLiveChanges(new Set(ids), id => this._featureOverlay.isRemoved(id));
    const touched = new Set();
    let restored = 0;
    for (const id of new Set(ids)) {
      if (!this._featureOverlay.isRemoved(id)) continue;
      if (!this._featureBindings.has(id)) continue;
      this._featureOverlay.restore(id, { position: this._removedFeatureMoves.get(id) ?? null });
      this._removedFeatureMoves.delete(id);
      this._eachBindingVertex(id, (page, vertex) => {
        const saved = page.deletedVertices.get(vertex), offset = vertex * 4;
        const changed = !saved.rgba.every((v, channel) => v === page.colors[offset + channel]);
        page.colors.set(saved.rgba, offset);
        page.overlayRemoved.delete(vertex);
        if (saved.moved) page.overlayMoved.add(vertex);
        page.deletedVertices.delete(vertex);
        if (page.kind === 'points') {
          const alert = Number(isAlert(page.colors, vertex)), pulse = Number(hasShaderPulse(page.colors, vertex));
          page.pointAlertCount += alert; page.pointPulseCount += pulse;
          this._totals.pointAlerts += alert; page.alertVersion++;
        }
        if (changed) {
          if (vertex < page.uploaded) this._markColorDirty(page, vertex);
          this._dirtyGeometryPages.add(page);
        }
        touched.add(page);
      });
      restored++;
    }
    this._commitLiveChanges(captures, touched, 'restore');
    if (restored) for (const page of touched) this._invalidateSelection(page);
    this._overlayStats.restorations += restored;
    this._overlayStats.tombstoned = Math.max(0, this._overlayStats.tombstoned - restored);
    if (restored) {
      this._stagingRevision++;
      this._requestRender('restores');
    }
    return { ...this.getStats(), revision: this._stagingRevision, restored, overlay: this._featureOverlay.snapshot() };
  }

  /**
   * The cached candidate set may predate the edit, so the next frame must
   * re-query. The previous record is kept as the change-detection baseline:
   * an edit that leaves the candidate set identical then costs no index bytes.
   */
  _invalidateSelection(page) {
    if (page.selection) page.selectionStale = true;
    page.indexStride = 0;
  }

  getOverlay() {
    return { ...this._featureOverlay.snapshot(), ...this._overlayStats };
  }

  /** Resolves after GL calls for every geometry page have been issued, not GPU execution. */  awaitCommit(revision, { timeoutMs = 15000 } = {}) {
    if (this.destroyed) return Promise.reject(new DOMException('渲染器已销毁。', 'AbortError'));
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this._stagingRevision) {
      return Promise.reject(new RangeError('提交编号必须来自当前渲染器的 append 或颜色更新结果。'));
    }
    if (revision < this._minimumRevision) return Promise.reject(new DOMException('该提交已随重置取消。', 'AbortError'));
    if (this._commitError) return Promise.reject(this._commitError);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15000) return Promise.reject(new RangeError('提交等待上限须在 0–15000 ms 内。'));
    if (revision <= this._committedRevision) return Promise.resolve(this.getStats());
    return new Promise((resolve, reject) => {
      const waiter = { revision, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this._commitWaiters.delete(waiter);
        reject(new Error('等待 GL 几何提交超时，请保持页面可见并检查 WebGL 状态。'));
      }, timeoutMs);
      this._commitWaiters.add(waiter);
      this._requestRender('await-commit');
    });
  }

  _rejectCommitWaiters(error) {
    for (const waiter of this._commitWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this._commitWaiters.clear();
  }

  _resolveCommitWaiters(stats) {
    if (!this._commitWaiters.size) return;
    for (const waiter of this._commitWaiters) {
      if (waiter.revision > this._committedRevision) continue;
      clearTimeout(waiter.timer);
      this._commitWaiters.delete(waiter);
      waiter.resolve(stats);
    }
  }

  _submitGeometryUpload(submit) {
    const started = performance.now();
    try { return submit(); }
    finally { this._glUploadSubmissionMs += performance.now() - started; }
  }

  _deleteGPU() {
    const gl = this._gl;
    if (gl && !gl.isContextLost()) {
      for (const kind of KINDS) for (const page of this.pages[kind]) {
        if (page.gpu) for (const buffer of Object.values(page.gpu)) gl.deleteBuffer(buffer);
      }
      if (this._pipeline) {
        const pipeline = this._pipeline;
        if (pipeline.vao) {
          if (pipeline.webgl2) gl.deleteVertexArray(pipeline.vao);
          else pipeline.vaoExtension.deleteVertexArrayOES(pipeline.vao);
        }
        gl.deleteProgram(pipeline.program);
      }
    }
    for (const kind of KINDS) for (const page of this.pages[kind]) {
      page.gpu = null; page.uploaded = 0; page.indexUploaded = 0; page.selection = null;
      if (page.count) this._dirtyGeometryPages.add(page);
    }
    this._totals.gpuBytes = 0;
    this._pipeline = null;
    this._gl = null;
  }

  _useContext(gl) {
    if (this._gl === gl && this._pipeline) return;
    const previousCanvas = this._activeContextCanvas;
    if (previousCanvas && previousCanvas !== this.canvas && previousCanvas !== gl.canvas) this._unbindContextEvents(previousCanvas);
    this._deleteGPU();
    this._gl = gl;
    this._activeContextCanvas = gl.canvas;
    this._pipeline = compileProgram(gl);
    this._bindContextEvents(gl.canvas);
  }

  _upload(page) {
    // Skip range allocation/sorting on stable pages. Position edits and alpha
    // tombstones use their own ranges and must be included, even off screen.
    if (page.gpu && page.uploaded === page.count && !page.colorDirtyRanges.length && !page.colorDirtyState?.pendingUniqueVertices && !page.positionDirtyRanges.length) {
      this._dirtyGeometryPages.delete(page);
      this._geometrySubmission.cleanPagesSkipped++;
      return;
    }
    // Capture one submission generation and append boundary. A synchronous
    // adapter may call a public update while issuing GL; its new bytes must not
    // be consumed by this generation or acknowledged before a later upload.
    const submissionRevision = this._stagingRevision;
    const from = page.uploaded, targetCount = page.count;
    const gl = this._gl;
    if (!page.gpu) {
      page.gpu = { position: gl.createBuffer(), color: gl.createBuffer() };
      if (page.kind === 'points') page.gpu.index = gl.createBuffer();
      if (Object.values(page.gpu).some((buffer) => !buffer)) throw new Error('GPU 缓冲区分配失败。');
      gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.position);
      this._submitGeometryUpload(() => gl.bufferData(gl.ARRAY_BUFFER, page.capacity * 8, gl.DYNAMIC_DRAW));
      gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.color);
      this._submitGeometryUpload(() => gl.bufferData(gl.ARRAY_BUFFER, page.capacity * 4, gl.DYNAMIC_DRAW));
      if (page.gpu.index) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, page.gpu.index);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, page.capacity * 2, gl.DYNAMIC_DRAW);
      }
      this._totals.gpuBytes += page.capacity * (page.kind === 'points' ? 14 : 12);
    }
    if (from < targetCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.position);
      this._submitGeometryUpload(() => gl.bufferSubData(gl.ARRAY_BUFFER, from * 8, page.positions.subarray(from * 2, targetCount * 2)));
      gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.color);
      this._submitGeometryUpload(() => gl.bufferSubData(gl.ARRAY_BUFFER, from * 4, page.colors.subarray(from * 4, targetCount * 4)));
      this._totals.uploadedBytes += (targetCount - from) * 12;
      page.uploaded = targetCount;
    }
    // Appended colors already include any staging-time updates. Only the dirty
    // range below the old upload boundary needs an additional color submission.
    let dirtyPlan = null;
    if (this.optimization.colorUploadPolicy === 'accumulator' && page.colorDirtyRanges.length) {
      const state = page.colorDirtyState ||= new ColorDirtyState({ capacity: page.capacity });
      for (const [start, end] of page.colorDirtyRanges) for (let slot = start / 4; slot < Math.min(end / 4, from); slot++) state.mark(slot);
      page.colorDirtyRanges.length = 0;
    }
    let ranges;
    if (this.optimization.colorUploadPolicy === 'accumulator') {
      dirtyPlan = page.colorDirtyState?.peekPlan({ bufferBytes: from * 4,
        mergeGapBytes: this.optimization.mergeGapBytes,
        maxRanges: this.optimization.dirtyMode === 'envelope' ? 1 : this.optimization.maxDirtyRanges }) ?? null;
      ranges = dirtyPlan?.ranges ?? [];
    } else {
      const dirty = page.colorDirtyRanges.map(([start, end]) => [start, Math.min(end, from * 4)])
        .filter(([start, end]) => start < end);
      // Only many single-vertex RGBA edits use the measured density fast path.
      // Custom gap/cap and envelope options retain their exact legacy semantics.
      // Raw bytes upper-bound unique bytes: a span >2x raw bytes cannot pass the
      // fast-path byte bound, so reject it before allocating/resetting scratch.
      let densityEligible = this.optimization.colorUploadPolicy === 'density' &&
        this.optimization.dirtyMode === 'ranges' && this.optimization.mergeGapBytes === 64 &&
        this.optimization.maxDirtyRanges === 32 && dirty.length >= 512;
      if (densityEligible) {
        let min = Infinity, max = 0;
        for (const [start, end] of dirty) {
          if (end - start !== 4) { densityEligible = false; break; }
          min = Math.min(min, start); max = Math.max(max, end);
        }
        if (max - min > dirty.length * 8) densityEligible = false;
      }
      ranges = densityEligible
        ? (this._densityUploadPlanner ||= createDensityUploadPlanner())(dirty, from * 4).ranges
        : planDirtyRanges(dirty, {
          mergeGapBytes: this.optimization.mergeGapBytes,
          maxRanges: this.optimization.dirtyMode === 'envelope' ? 1 : this.optimization.maxDirtyRanges
        });
    }
    if (ranges.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.color);
      for (const [start, end] of ranges) {
        this._submitGeometryUpload(() => gl.bufferSubData(
          gl.ARRAY_BUFFER, start, page.colors.subarray(start, end)
        ));
        this._totals.uploadedBytes += end - start;
      }
    }
    // Consume neither channel until every GL submission below has succeeded.
    // Live position edits are 8 bytes per vertex and use the same planner, so a
    // few scattered moves still cost one call each instead of a whole page.
    const dirtyPositions = page.positionDirtyRanges.map(([start, end]) => [start, Math.min(end, from * 8)])
      .filter(([start, end]) => start < end);
    if (dirtyPositions.length) {
      const positionRanges = planDirtyRanges(dirtyPositions, {
        mergeGapBytes: this.optimization.mergeGapBytes,
        maxRanges: this.optimization.dirtyMode === 'envelope' ? 1 : this.optimization.maxDirtyRanges
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.position);
      for (const [start, end] of positionRanges) {
        this._submitGeometryUpload(() => gl.bufferSubData(
          gl.ARRAY_BUFFER, start, page.positions.subarray(start / 4, end / 4)
        ));
        this._totals.uploadedBytes += end - start;
      }
    }
    if (submissionRevision !== this._stagingRevision || page.count !== targetCount) {
      // Public updates after a tail was sent may have deliberately created no
      // prefix marker. Re-upload that original tail with its latest CPU values.
      page.uploaded = from;
      if (this.pages[page.kind].includes(page)) {
        this._dirtyGeometryPages.add(page);
        this._requestRender('geometry-after-submit');
      }
    } else {
      page.colorDirtyStart = Infinity;
      page.colorDirtyEnd = 0;
      page.colorDirtyRanges.length = 0;
      page.positionDirtyRanges.length = 0;
      const colorsCleared = !dirtyPlan || page.colorDirtyState.clear(dirtyPlan.token, { tailUploaded: true });
      if (colorsCleared) this._dirtyGeometryPages.delete(page);
      else this._requestRender('colors-after-submit');
    }
    this._geometrySubmission.pagesSubmitted++;
  }

  _updateIndices(page, stride) {
    if (page.selection && !page.selection.denseFallback) {
      page.selection = null; page.indexStride = 0;
    }
    if (page.indexStride !== stride) {
      page.indexCount = 0; page.indexedUntil = 0; page.indexUploaded = 0; page.indexStride = stride;
      page.pointIndexAlertCount = 0;
      page.pointIndexPulseCount = 0;
    }
    // Only appended vertices are visited while the LOD stride stays unchanged.
    for (let i = page.indexedUntil; i < page.count; i++) {
      if (page.overlayRemoved.has(i)) continue;
      const alert = isAlert(page.colors, i);
      if (i % stride === 0 || (this.riskPreservation && alert)) {
        page.indices[page.indexCount++] = i;
        if (alert) page.pointIndexAlertCount++;
        if (hasShaderPulse(page.colors, i)) page.pointIndexPulseCount++;
      }
    }
    page.indexedUntil = page.count;
    if (page.indexUploaded < page.indexCount) {
      this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, page.gpu.index);
      this._gl.bufferSubData(
        this._gl.ELEMENT_ARRAY_BUFFER, page.indexUploaded * 2,
        page.indices.subarray(page.indexUploaded, page.indexCount)
      );
      this._totals.uploadedBytes += (page.indexCount - page.indexUploaded) * 2;
      page.indexUploaded = page.indexCount;
    }
  }

  _outside(page, matrix) {
    return this._classifyBounds(page, matrix) === -1;
  }

  // Convex projected rectangle / expanded viewport classification. Crossing the
  // eye plane or nonfinite projection is retained; z clipping is left to GL.
  // Delegates to the shared module so the same conservative test can also run
  // inside the spatial query worker.
  _classifyBounds(page, matrix) {
    if (page.liveBoundsEmpty === true) return -1;
    return classifyProjectedBounds(page, matrix, {
      marginX: 1 + this.pointSize * 2 / this.width,
      marginY: 1 + this.pointSize * 2 / this.height,
      stats: this._classifierStats
    });
  }

  _ensureIndexBuffer(page) {
    if (!page.indices) {
      page.indices = new Uint16Array(page.capacity);
      this._totals.cpuBytes += page.capacity * 2;
    }
    if (!page.gpu.index) {
      page.gpu.index = this._gl.createBuffer();
      if (!page.gpu.index) throw new Error('GPU 索引缓冲区分配失败。');
      this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, page.gpu.index);
      this._gl.bufferData(this._gl.ELEMENT_ARRAY_BUFFER, page.capacity * 2, this._gl.DYNAMIC_DRAW);
      this._totals.gpuBytes += page.capacity * 2;
    }
  }

  _updateSpatialIndices(page, matrix, stride) {
    const baseline = page.selection;
    // An edit marks the selection stale: it must be re-queried, but the old
    // record still tells us whether the resulting index buffer actually changed.
    const stale = page.selectionStale === true;
    page.selectionStale = false;
    const previous = stale ? null : baseline;
    const marginX = 1 + this.pointSize * 2 / this.width;
    const marginY = 1 + this.pointSize * 2 / this.height;
    const key = [page.dataVersion, page.alertVersion, stride, this.riskPreservation,
      this.pointSize, this.width, this.height, this.optimization.maxCandidateRatio, this.optimization.coarseCandidates, page.geometryVersion, this.optimization.movedFilter];
    if (previous && key.every((value, i) => value === previous.key[i])) {
      let hit = matrix.every((value, i) => value === previous.matrix[i]);
      if (hit) this._selectionMetrics.exactReuses++;
      else if (previous.worldBox) {
        // An AABB inside the old viewport's AABB is insufficient after rotation.
        // For a finite front-facing current viewport, its world AABB is an outer bound;
        // require that entire bound to lie inside the actual previous clip area.
        // Unprojection rejects horizons and behind-eye views instead of reusing.
        const nowBox = viewportWorldBox(matrix, { marginX, marginY });
        hit = Boolean(nowBox && classifyProjectedBounds(nowBox, previous.matrix,
          { marginX: previous.marginX, marginY: previous.marginY }) === 1);
        if (hit) this._selectionMetrics.incrementalReuses++;
        else this._selectionMetrics.worldBoxMisses++;
      }
      if (hit) {
        this._selectionMetrics.cacheHits++;
        if (page.spatial && page.spatialIndexedUntil === page.count) this._spatialLifecycle.fineReuseCount++;
        return !previous.denseFallback;
      }
    }
    let coarseResult = null;
    const validCoarse = !page.overlayMoved.size && !page.overlayRemoved.size && page.coarseIndexedUntil === page.count;
    const countCoarse = () => {
      if (!coarseResult) {
        const began = performance.now();
        coarseResult = page.coarse.count(bounds => this._classifyBounds(bounds, matrix));
        this._selectionMetrics.coarseQueryMs += performance.now() - began;
        this._selectionMetrics.coarseBucketsTested += coarseResult.bucketsTested;
      }
      return coarseResult;
    };
    const applyCoarse = () => {
      if (!this.optimization.coarseCandidates || !validCoarse || page.coarse.referenceCapacity === null) return null;
      const counted = countCoarse(), budget = page.count * this.optimization.maxCandidateRatio / PRIMITIVE_SIZE[page.kind];
      if (counted.primitivesSelected > budget) return null;
      this._ensureIndexBuffer(page);
      this._candidateScratch ||= new Uint16Array(PAGE_VERTICES);
      let n = 0; const began = performance.now();
      const enumerated = page.coarse.query(bounds => this._classifyBounds(bounds, matrix), start => { this._candidateScratch[n++] = start; });
      if (n !== counted.primitivesSelected || enumerated.primitivesSelected !== n) throw new Error('粗索引候选枚举水位不一致。');
      this._selectionMetrics.coarseQueryMs += performance.now() - began;
      const result = this._writeSelectionIndices(page, this._candidateScratch.subarray(0, n), stride, baseline, matrix);
      page.selection = this._selectionRecord(key, matrix, { coarseCandidates: true, coarseCount: n });
      this._selectionMetrics.indexMs += result.indexMs;
      this._selectionMetrics.coarseCandidatePages++;
      this._selectionMetrics.coarseCandidatePrimitives += n;
      return true;
    };
    // Decide cold work before Worker registration/copy/build. Intersecting
    // coarse buckets give U, contained buckets give L: L <= bbox candidates <= U.
    // L > rN proves even the fine candidate set would be dense. A high U alone
    // cannot prove that. Old coarse geometry must not decide after live edits.
    const hasWorkerPage = Boolean(page.workerId && this._spatialQueryClient?.pages.has(page.workerId));
    if (!page.spatial && !hasWorkerPage && this.optimization.spatialBuildPolicy === 'lazy' &&
        validCoarse) {
      const coarse = countCoarse();
      const decision = decideSpatialWork({ primitiveCount: page.count / PRIMITIVE_SIZE[page.kind],
        coarseUpperBound: coarse.primitivesSelected, coarseLowerBound: coarse.containedPrimitives,
        coarseComplete: true, maxCandidateRatio: this.optimization.maxCandidateRatio });
      if (decision.action === 'dense-fallback') {
        if (previous && !previous.denseFallback) page.indexStride = 0;
        page.selection = this._selectionRecord(key, matrix, { denseFallback: true, coarseGuard: true });
        this._selectionMetrics.coarseDensityGuardPages++;
        this._spatialLifecycle.coarseDensityGuardCount++;
        return false;
      }
      if (decision.action === 'empty') {
        page.indexCount = 0; page.indexUploaded = 0; page.indexStride = 0;
        page.pointIndexAlertCount = 0; page.indexedUntil = page.count;
        page.pointIndexPulseCount = 0;
        page.selection = this._selectionRecord(key, matrix, { coarseEmpty: true });
        this._selectionMetrics.coarseEmptyPages++;
        return true;
      }
    }
    // Cold sparse coarse references are ready as soon as this append completes.
    if (!page.spatial && !hasWorkerPage) {
      const coarseApplied = applyCoarse(); if (coarseApplied !== null) return coarseApplied;
    }
    // A registered Worker or retained fine tree bypasses the cold gate.
    const workerApplied = this._tryWorkerSelection(page, matrix, stride, marginX, marginY, baseline);
    if (workerApplied === true) return true;
    if (workerApplied === false) {
      const coarseApplied = applyCoarse(); return coarseApplied ?? false;
    }
    // A retained fine tree may be more selective than the coarse upper bound.
    // Query it directly instead of allowing a coarse false positive to block it.
    if (!this._ensureSpatialIndex(page)) {
      const coarseApplied = applyCoarse(); if (coarseApplied !== null) return coarseApplied;
      // A partial index cannot prove that the appended tail is outside the
      // view. Render the complete page (or its ordinary, risk-preserving LOD)
      // until every primitive is indexed. Never cache this temporary fallback.
      if (previous && !previous.denseFallback) page.indexStride = 0;
      page.selection = null;
      this._selectionMetrics.spatialPendingFallbackPages++;
      return false;
    }
    const countBegan = performance.now();
    const counted = page.spatial.count(bounds => this._classifyBounds(bounds, matrix));
    this._selectionMetrics.queryMs += performance.now() - countBegan;
    this._selectionMetrics.nodesTested += counted.nodesTested;
    if (counted.primitivesSelected * PRIMITIVE_SIZE[page.kind] > page.count * this.optimization.maxCandidateRatio) {
      const coarseApplied = applyCoarse(); if (coarseApplied !== null) return coarseApplied;
      if (previous && !previous.denseFallback) page.indexStride = 0;
      page.selection = this._selectionRecord(key, matrix, { denseFallback: true });
      return false;
    }
    this._ensureIndexBuffer(page);
    const began = performance.now();
    this._candidateScratch ||= new Uint16Array(PAGE_VERTICES);
    let candidateCount = 0;
    const metrics = page.spatial.query(bounds => this._classifyBounds(bounds, matrix), start => {
      this._candidateScratch[candidateCount++] = start;
    });
    this._selectionMetrics.queryMs += performance.now() - began;
    this._selectionMetrics.nodesTested += metrics.nodesTested;
    const result = this._writeSelectionIndices(page, this._candidateScratch.subarray(0, candidateCount), stride, baseline, matrix);
    page.selection = this._selectionRecord(key, matrix);
    this._selectionMetrics.indexMs += result.indexMs;
    return true;
  }

  /** Shared tail of the sync and worker paths: sort candidates, apply LOD and alerts, upload. */
  _writeSelectionIndices(page, starts, stride, previous, matrix) {
    const indexBegan = performance.now();
    starts.sort(); // Numeric typed-array sort preserves original alpha order.
    const primitiveSize = PRIMITIVE_SIZE[page.kind];
    const removed = page.overlayRemoved;
    // Geometric contamination outlives ID deletion: a partially transparent
    // line/triangle still uses the deleted vertex's current position.
    const moved = page.movedPrimitiveStarts;
    let candidates = starts;
    if (moved.size) {
      this._mergedStarts ||= new Uint16Array(PAGE_VERTICES * 2);
      const merged = this._mergedStarts;
      let n = 0;
      for (const start of starts) {
        if (this.optimization.movedFilter && moved.has(start)) { this._movedFilterStats.movedBaseCandidatesSkipped++; continue; }
        merged[n++] = start;
      }
      for (const start of moved) {
        if (this.optimization.movedFilter) {
          this._movedFilterStats.movedPrimitivesTested++;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, live = false;
          for (let vertex = start; vertex < start + primitiveSize; vertex++) {
            const x = page.positions[vertex * 2], y = page.positions[vertex * 2 + 1];
            minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            if (!removed.has(vertex)) live = true;
          }
          if (!live || this._classifyBounds({minX, minY, maxX, maxY}, matrix) === -1) {
            this._movedFilterStats.movedPrimitivesRejected++; continue;
          }
        }
        merged[n++] = start;
      }
      const view = merged.subarray(0, n); view.sort();
      let write = 0;
      for (let read = 0; read < n; read++) {
        if (read && view[read] === view[read - 1]) continue;
        view[write++] = view[read];
      }
      candidates = merged.subarray(0, write);
    }
    let count = 0, alerts = 0, pulses = 0, changed = !previous || previous.denseFallback;
    for (const start of candidates) {
      // Keep partially removed mixed-ID primitives: per-vertex alpha still
      // contributes to rasterization, exactly as in the full/dense path.
      if (removed && removed.size) {
        let dropped = true;
        for (let vertex = start; vertex < start + primitiveSize; vertex++) {
          if (!removed.has(vertex)) { dropped = false; break; }
        }
        if (dropped) { changed = true; continue; }
      }
      if (page.kind === 'points') {
        const alert = isAlert(page.colors, start);
        if (start % stride && !(this.riskPreservation && alert)) continue;
        if (alert) alerts++;
        if (hasShaderPulse(page.colors, start)) pulses++;
      }
      for (let vertex = start; vertex < start + primitiveSize; vertex++) {
        if (page.indices[count] !== vertex) changed = true;
        page.indices[count++] = vertex;
      }
    }
    if (page.indexCount !== count || page.indexUploaded !== count) changed = true;
    page.indexCount = count; page.pointIndexAlertCount = alerts;
    page.pointIndexPulseCount = pulses;
    page.indexedUntil = page.count; page.indexStride = 0;
    if (changed && count) {
      const uploadBegan = performance.now();
      this._gl.bindBuffer(this._gl.ELEMENT_ARRAY_BUFFER, page.gpu.index);
      this._gl.bufferSubData(this._gl.ELEMENT_ARRAY_BUFFER, 0, page.indices.subarray(0, count));
      this._totals.uploadedBytes += count * 2;
      this._selectionMetrics.indexUploadedBytes += count * 2;
      this._selectionMetrics.indexUploadSubmissionMs += performance.now() - uploadBegan;
    }
    page.indexUploaded = count;
    return { count, indexMs: performance.now() - indexBegan };
  }

  /**
   * The actual world box a selection was built for. Kept
   * per selection so a later frame can prove the old candidate set still covers
   * the new viewport. Null when the matrix is singular: no reuse is possible.
   */
  _selectionRecord(key, matrix, extra = {}) {
    const marginX = 1 + this.pointSize * 2 / this.width;
    const marginY = 1 + this.pointSize * 2 / this.height;
    return {
      key, matrix: Float64Array.from(matrix), marginX, marginY,
      worldBox: viewportWorldBox(matrix, { marginX, marginY }),
      ...extra
    };
  }

  _failSpatialQueryClient(client, error) {
    const owned = this._spatialQueryClient === client;
    if (owned) {
      this._spatialQueryClient = null;
      if (!this._spatialQueryFailure) {
        this._spatialQueryFailure = error?.message || String(error || 'Spatial Worker failed');
        this._spatialQueryFailureCount++;
      }
    }
    try { client?.dispose(); } catch (_) { /* The fallback must survive cleanup errors. */ }
    if (owned && !this.destroyed) this._requestRender('spatial-worker-fallback');
  }

  _ensureSpatialQueryClient() {
    if (this.destroyed || this._spatialQueryFailure || !this.optimization.spatialQueryWorker) return null;
    if (this._spatialQueryClient) return this._spatialQueryClient;
    if (typeof Worker === 'undefined') return null;
    // Initialized before construction so synchronous construction/error adapters
    // cannot enter a temporal dead zone. Failure stays latched for this run.
    let client = null;
    try {
      client = new SpatialQueryClient({
        createWorker: () => new Worker(new URL('./spatial-query-worker.js', import.meta.url), { type: 'module' }),
        onResult: (id, result) => {
          if (this.destroyed || this._spatialQueryClient !== client) return;
          for (const kind of KINDS) for (const page of this.pages[kind]) {
            const selection = page.selection;
            if (page.workerId === id && selection?.coarseCandidates && !result.dense && result.count < selection.coarseCount &&
                result.dataVersion === page.dataVersion && result.indexedUntil === page.count &&
                result.marginX === selection.marginX && result.marginY === selection.marginY &&
                result.matrix?.every((value, i) => value === selection.matrix[i])) page.selectionStale = true;
          }
          this._requestRender('spatial-worker');
        },
        onError: error => {
          if (this._spatialQueryClient === client) this._failSpatialQueryClient(client, error);
        }
      });
      if (this._spatialQueryFailure) { client.dispose(); return null; }
      this._spatialQueryClient = client;
    } catch (error) { this._failSpatialQueryClient(client, error); }
    return this._spatialQueryClient;
  }

  /**
   * Returns true/false when a worker result was applied, or null when the
   * caller must fall back to the synchronous path. The worker mirrors the page
   * positions; it never shares them, so the main thread keeps ownership.
   */
  _tryWorkerSelection(page, matrix, stride, marginX, marginY, baseline) {
    if (!this.optimization.spatialQueryWorker) return null;
    const client = this._ensureSpatialQueryClient();
    if (!client) return null;
    const id = page.workerId || (page.workerId = 'pg' + (++this._workerPageSerial));
    try {
      if (!client.pages.has(id)) {
        client.register(id, {
          primitiveSize: PRIMITIVE_SIZE[page.kind],
          options: { leafSize: this.optimization.leafSize, minExtent: this.optimization.minExtent, maxDepth: this.optimization.maxDepth },
          dataVersion: page.dataVersion
        });
        page.workerMirrored = 0;
      }
      if ((page.workerMirrored ?? 0) < page.count) {
        client.append(id, page.positions, page.workerMirrored ?? 0, page.count, { dataVersion: page.dataVersion });
        page.workerMirrored = page.count;
      }
    } catch (error) {
      this._failSpatialQueryClient(client, error);
      return null;
    }
    // A synchronous Worker adapter can report an error during postMessage.
    if (this._spatialQueryClient !== client) return null;
    const candidateBudget = page.count * this.optimization.maxCandidateRatio / PRIMITIVE_SIZE[page.kind];
    const ready = client.latest(id, { matrix, marginX, marginY, candidateBudget });
    const entry = client.pages.get(id);
    // Verify independently at the application boundary: ACKed cursor alone
    // does not prove an old result covers the appended tail or this camera.
    const usable = ready && !ready.stale && ready.count !== undefined &&
      ready.generation === entry?.generation && ready.dataVersion === page.dataVersion &&
      ready.indexedUntil === page.count && entry?.indexedUntil === page.count &&
      ready.marginX === marginX && ready.marginY === marginY && ready.candidateBudget === candidateBudget &&
      ready.matrix?.length === matrix.length && matrix.every((value, i) => value === ready.matrix[i]);
    if (usable) {
      if (ready.dense) {
        this._spatialQueryApplied.denseFallbacks++;
        if (page.selection && !page.selection.denseFallback) page.indexStride = 0;
        page.selection = this._selectionRecord(this._selectionKey(page, stride), matrix, { denseFallback: true, worker: true });
        return false;
      }
      if (!ready.starts) return null;
      this._ensureIndexBuffer(page);
      const result = this._writeSelectionIndices(page, ready.starts, stride, baseline, matrix);
      page.selection = this._selectionRecord(this._selectionKey(page, stride), matrix, { worker: true });
      page.workerSeq = ready.seq;
      this._spatialQueryApplied.pages++;
      this._spatialQueryApplied.lastTransportMs = client.stats.lastTransportMs;
      this._selectionMetrics.queryMs += ready.stats?.queryMs ?? 0;
      this._selectionMetrics.nodesTested += ready.stats?.nodesTested ?? 0;
      this._selectionMetrics.indexMs += result.indexMs;
      return true;
    }
    if (!usable || ready?.stale) this._spatialQueryApplied.misses++;
    try {
      client.query(id, { matrix, marginX, marginY, candidateBudget });
    } catch (error) { this._failSpatialQueryClient(client, error); }
    return null;
  }

  _selectionKey(page, stride) {
    return [page.dataVersion, page.alertVersion, stride, this.riskPreservation,
      this.pointSize, this.width, this.height, this.optimization.maxCandidateRatio, this.optimization.coarseCandidates, page.geometryVersion, this.optimization.movedFilter];
  }

  _lod(unitsPerPixel) {
    if (!this.adaptive || this._totals.points < 50000) return 1;
    // Camera-dependent LOD is deterministic across benchmark pipelines.
    // FPS-dependent sampling would quietly change their GPU workloads.
    return unitsPerPixel > 180 ? 16 : unitsPerPixel > 90 ? 8 : unitsPerPixel > 45 ? 4 : unitsPerPixel > 20 ? 2 : 1;
  }

  _localMatrix() {
    const m = this.matrix;
    m.fill(0);
    const c = Math.cos(this.camera.heading), s = Math.sin(this.camera.heading);
    const sx = 2 * this.camera.scale / this.width, sy = 2 * this.camera.scale / this.height;
    m[0] = c * sx; m[4] = -s * sx;
    m[1] = s * sy; m[5] = c * sy;
    m[10] = 1; m[15] = 1;
    m[12] = (-c * this.camera.x + s * this.camera.y) * sx;
    m[13] = (-s * this.camera.x - c * this.camera.y) * sy;
    return m;
  }

  _render(gl, matrix, { time, unitsPerPixel, pixelRatio, shared = false }) {
    const started = performance.now();
    if (this.destroyed || this.contextLost || gl.isContextLost()) return;
    if (this._inRender) {
      this._scheduleCounters.reentrantCallbacks++;
      this._requestRender('render-reentry');
      return;
    }
    this._renderPending = false;
    this._repaintPending = false;
    this._repaintSerial++;
    this._settlePending = false;
    this._pulseActive = false;
    this._inRender = true;
    this._spatialBuildProgress.spatialBuildCpuMs = 0;
    this._spatialBuildProgress.spatialBuildSliceMaxMs = 0;
    try {
    this._pumpLiveBounds();
    if (shared && (!this._sharedDiagnosticsAt || time - this._sharedDiagnosticsAt > 1000)) {
      this._sharedDiagnosticsAt = time;
      const parameter = (name) => gl[name] === undefined ? null : gl.getParameter(gl[name]);
      const enabled = (name) => gl[name] === undefined || typeof gl.isEnabled !== 'function' ? null : gl.isEnabled(gl[name]);
      const clip = (x, y) => [
        matrix[0] * x + matrix[4] * y + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[14],
        matrix[3] * x + matrix[7] * y + matrix[15]
      ];
      const samplePage = this.pages.points.find((page) => page.count) || this.pages.lines.find((page) => page.count);
      const sample = samplePage ? Array.from(samplePage.positions.subarray(0, 2)) : null;
      this._sharedDiagnostics = {
        matrix: Array.from(matrix), originClip: clip(0, 0), sample,
        sampleClip: sample ? clip(...sample) : null,
        colorMask: parameter('COLOR_WRITEMASK'), viewport: parameter('VIEWPORT'),
        scissorBox: parameter('SCISSOR_BOX'), scissorTest: enabled('SCISSOR_TEST'),
        stencilTest: enabled('STENCIL_TEST'), depthTest: enabled('DEPTH_TEST'),
        rasterizerDiscard: enabled('RASTERIZER_DISCARD')
      };
    }
    this._useContext(gl);
    const pipeline = this._pipeline;
    if (pipeline.vao) {
      if (pipeline.webgl2) gl.bindVertexArray(pipeline.vao);
      else pipeline.vaoExtension.bindVertexArrayOES(pipeline.vao);
    }
    if (!shared) {
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    // Shared rendering never touches framebuffer, viewport or global render state.
    // unsafeGL:true delegates program/buffer/vertex-state restoration to the SDK.
    gl.useProgram(pipeline.program);
    gl.uniformMatrix4fv(pipeline.locations.u_mvpMatrix, false, matrix);
    gl.uniform1f(pipeline.locations.u_size, this.pointSize);
    gl.uniform1f(pipeline.locations.u_pixelRatio, pixelRatio);
    gl.uniform1f(pipeline.locations.u_time, (time - this._startTime) / 1000);
    gl.uniform1f(pipeline.locations.u_maxSize, pipeline.maxPointSize);
    gl.enableVertexAttribArray(pipeline.position); gl.enableVertexAttribArray(pipeline.color);
    const stride = this._lod(unitsPerPixel);
    const cameraKey = [this.width, this.height, this.pointSize];
    const sameCamera = this._selectionCamera && matrix.every((value, i) => value === this._selectionCamera[i]) &&
      cameraKey.every((value, i) => value === this._selectionCameraKey[i]);
    this._stableCameraFrames = sameCamera ? this._stableCameraFrames + 1 : 0;
    if (!sameCamera) {
      this._selectionCamera = new Float32Array(matrix); this._selectionCameraKey = cameraKey;
    }
    // Guard pages count decisions made this frame; a cached coarse fallback is
    // reported by cacheHits + spatialDenseFallbackPages without another query.
    this._selectionMetrics = { queryMs: 0, indexMs: 0, indexUploadSubmissionMs: 0,
      coarseQueryMs: 0, coarseBucketsTested: 0, coarseDensityGuardPages: 0, coarseEmptyPages: 0, coarseCandidatePages: 0, coarseCandidatePrimitives: 0,
      indexUploadedBytes: 0, nodesTested: 0, cacheHits: 0, spatialDenseFallbackPages: 0,
      spatialPendingFallbackPages: 0,
      exactReuses: 0, incrementalReuses: 0, worldBoxMisses: 0 };
    let drawCalls = 0, vertices = 0, pointsSubmitted = 0, pointAlertsDrawn = 0, culledPages = 0, visiblePages = 0;
    // Commit every dirty geometry page before visibility filtering. ACK cannot
    // otherwise guarantee submission when a layer is hidden or off screen.
    for (const page of this._dirtyGeometryPages) {
      this._geometrySubmission.queuedPagesVisited++;
      this._upload(page);
    }
    for (const kind of KINDS) {
      if (!this.layers[kind]) continue;
      gl.uniform1f(pipeline.locations.u_round, kind === 'points' ? 1 : 0);
      const mode = kind === 'points' ? gl.POINTS : kind === 'lines' ? gl.LINES : gl.TRIANGLES;
      for (const page of this.pages[kind]) {
        if (!page.count) continue;
        const relation = this._classifyBounds(page, matrix);
        if (relation === -1) { culledPages++; continue; }
        this._upload(page);
        gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.position);
        gl.vertexAttribPointer(pipeline.position, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, page.gpu.color);
        gl.vertexAttribPointer(pipeline.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);
        let count = page.count;
        page.stableDataFrames = page.stableDataVersion === page.dataVersion ? (page.stableDataFrames || 0) + 1 : 0;
        page.stableDataVersion = page.dataVersion;
        const settled = this._stableCameraFrames >= this.optimization.settleFrames &&
          page.stableDataFrames >= this.optimization.settleFrames;
        if (this.optimization.spatial && relation === 0 && this.optimization.spatialPolicy === 'settled' && !settled) this._settlePending = true;
        let spatialSelection = this.optimization.spatial && relation === 0 &&
          (this.optimization.spatialPolicy === 'always' || settled);
        if (spatialSelection) {
          spatialSelection = this._updateSpatialIndices(page, matrix, kind === 'points' ? stride : 1);
          if (!spatialSelection && page.selection?.denseFallback) this._selectionMetrics.spatialDenseFallbackPages++;
        }
        if (spatialSelection) {
          count = page.indexCount;
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, page.gpu.index);
          if (count) gl.drawElements(mode, count, gl.UNSIGNED_SHORT, 0);
        } else if (kind === 'points' && stride > 1) {
          this._updateIndices(page, stride);
          count = page.indexCount;
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, page.gpu.index);
          if (count) gl.drawElements(mode, count, gl.UNSIGNED_SHORT, 0);
        } else if (count) gl.drawArrays(mode, 0, count);
        if (count) {
          drawCalls++; vertices += count; visiblePages++;
          if (kind === 'points') {
            pointsSubmitted += count;
            pointAlertsDrawn += spatialSelection || stride > 1 ? page.pointIndexAlertCount : page.pointAlertCount;
            if ((spatialSelection || stride > 1 ? page.pointIndexPulseCount : page.pointPulseCount) > 0) this._pulseActive = true;
          }
        }
      }
    }
    // One shared allowance for the entire renderer, after complete drawing.
    // A changing camera never pays background tree work. Individual append /
    // split calls are atomic, so this budget is best effort, not hard realtime.
    this._pumpSpatialBuilds();
    const frameMs = performance.now() - started;
    const interval = this._lastFrameTime ? time - this._lastFrameTime : 0;
    this._lastFrameTime = time;
    if (interval > 0 && interval < 1000) {
      this._fpsSamples.push(interval);
      if (this._fpsSamples.length > 60) this._fpsSamples.shift();
    }
    const fps = this._fpsSamples.length
      ? 1000 * this._fpsSamples.length / this._fpsSamples.reduce((sum, value) => sum + value, 0) : 0;
    this._frame = {
      time, fps, frameMs, frameInterval: interval, drawCalls, geometryDrawCalls: drawCalls,
      vertices, pointsSubmitted, pointAlertsDrawn, culledPages, visiblePages, lodStride: stride, unitsPerPixel,
      ...this._selectionMetrics, matrixChanged: !sameCamera,
      previousFrameTelemetryCpuMs: this._frame.frameTelemetryCpuMs || 0,
      previousFrameTotalCpuMs: this._frame.frameTotalCpuMs || 0,
      spatialSettled: this._stableCameraFrames >= this.optimization.settleFrames
    };
    const telemetryStarted = performance.now();
    this._scheduleCounters.businessFrames++;
    this._scheduleCounters.drawCalls += drawCalls;
    this._scheduleCounters.verticesSubmitted += vertices;
    // A reentrant update can keep geometry pending after this frame. ACK is
    // issued only after the entire renderer reaches a clean submission state.
    if (!this._dirtyGeometryPages.size) this._committedRevision = this._stagingRevision;
    const info = { ...this.getStats(), time };
    // One aggregate stats scan serves both awaited ACKs and frame observers.
    this._resolveCommitWaiters(info);
    this.onFrame(info);
    for (const listener of this._frameListeners) {
      // Measurement observers cannot stop the SDK's drawing loop.
      try { listener(info); } catch (_) { /* The observer owns its failure. */ }
    }
    // frameMs retains its draw/submission/build meaning. This separate field
    // covers stats creation and observers, and is available on the next read.
    this._frame.frameTelemetryCpuMs = performance.now() - telemetryStarted;
    this._syncRenderSchedule(true);
    this._inRender = false;
    this._frame.frameTotalCpuMs = performance.now() - started;
    this._scheduleCounters.renderCpuMs += this._frame.frameTotalCpuMs;
    } catch (error) {
      this._inRender = false;
      this._commitError = error instanceof Error ? error : new Error(String(error));
      this._rejectCommitWaiters(this._commitError);
      this._stopRenderSchedule();
      throw error;
    }
  }

  _startSandbox() {
    if (this._raf || this.destroyed || this.contextLost || this._commitError) return;
    this._sandboxFrame ||= (time) => {
      this._raf = 0;
      if (this.destroyed || this.mode !== 'sandbox') return;
      try {
        this._render(this._localGL, this._localMatrix(), {
          time, unitsPerPixel: 1 / this.camera.scale, pixelRatio: this.pixelRatio
        });
      } catch (error) {
        this._notifyError(error);
        return;
      }
    };
    this._scheduleCounters.sandboxFrameRequests++;
    this._raf = requestAnimationFrame(this._sandboxFrame);
  }

  /** Demand controls our scheduling only; every SDK-supplied shared frame draws fully. */
  setRenderPolicy(policy) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (!['demand', 'continuous'].includes(policy)) throw new TypeError('渲染策略须为 demand 或 continuous。');
    if (this.renderPolicy === policy) return this.renderPolicy;
    this.renderPolicy = policy;
    this._requestRender('render-policy');
    return this.renderPolicy;
  }

  _requestRender(reason) {
    if (this.destroyed) return;
    this._scheduleCounters.wakeRequests++;
    if (this._renderPending || this._raf || this._repaintPending) this._scheduleCounters.coalescedWakeRequests++;
    this._lastWakeReason = reason;
    this._renderPending = true;
    if (!this._inRender) this._syncRenderSchedule();
  }

  _buildNeedsFrames() {
    return this.optimization.spatial && this.optimization.spatialBuildExecution === 'progressive' && this._spatialBuildQueue.length > 0;
  }

  _setSdkAnimation(active) {
    const layer = this._layer;
    if (!layer) return;
    if (this._sdkAnimationLayer !== layer) {
      this._sdkAnimationLayer = layer;
      this._sdkAnimating = typeof layer.isAnimating === 'function' ? Boolean(layer.isAnimating()) : false;
    }
    if (this._sdkAnimating === active) return;
    const method = active ? 'startAnimation' : 'stopAnimation';
    if (typeof layer[method] !== 'function') return;
    const previous = this._sdkAnimating;
    this._sdkAnimating = active;
    try {
      layer[method]();
      this._scheduleCounters[active ? 'animationStarts' : 'animationStops']++;
    } catch (error) { this._sdkAnimating = previous; throw error; }
  }

  _queueSdkRepaint() {
    if (!this._layer || this._repaintPending || this._sdkAnimating) return;
    this._repaintPending = true;
    const layer = this._layer, epoch = this._scheduleEpoch, serial = ++this._repaintSerial;
    // A microtask coalesces synchronous append/style/camera bursts and prevents
    // repaint calls inside our GL render. It is never a permanent rAF poll.
    queueMicrotask(() => {
      if (this.destroyed || this.contextLost || this._commitError || this._layer !== layer ||
          this._scheduleEpoch !== epoch || this._repaintSerial !== serial || !this._repaintPending) return;
      if (this._sdkAnimating) { this._repaintPending = false; return; }
      this._scheduleCounters.repaintRequests++;
      try { layer.triggerRepaint(); } catch (error) { this._repaintPending = false; this._notifyError(error); }
    });
  }

  _syncRenderSchedule(allowInRender = false) {
    if (this._inRender && !allowInRender) return;
    if (this.destroyed || this.contextLost || this._commitError) { this._stopRenderSchedule(); return; }
    const active = this.renderPolicy === 'continuous' || this._pulseActive || this._settlePending || this._buildNeedsFrames() || this._liveBoundsPending.size > 0;
    if (this._layer) {
      this._setSdkAnimation(active);
      if (!this._sdkAnimating && (this._renderPending || active)) this._queueSdkRepaint();
    } else if (this.mode === 'sandbox' && (this._renderPending || active)) this._startSandbox();
  }

  _stopRenderSchedule() {
    this._scheduleEpoch++;
    this._repaintPending = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._setSdkAnimation(false);
  }

  _renderSchedulingStats() {
    const reasons = [];
    if (this.renderPolicy === 'continuous') reasons.push('continuous');
    if (this._renderPending) reasons.push('dirty');
    if (this._pulseActive) reasons.push('pulse');
    if (this._settlePending) reasons.push('settling');
    if (this._buildNeedsFrames()) reasons.push('spatial-build');
    if (this._liveBoundsPending.size) reasons.push('live-bounds');
    return { ...this._scheduleCounters, policy: this.renderPolicy, lastWakeReason: this._lastWakeReason,
      activeReasons: reasons, pulseActive: this._pulseActive, pendingFrame: this._renderPending,
      sdkAnimating: this._sdkAnimating, sandboxFramePending: Boolean(this._raf),
      sleeping: !reasons.length && !this._raf && !this._repaintPending && !this._sdkAnimating,
      interpretation: 'Constructor-lifetime counters; compare phase deltas. Scheduling controls our own animation/repaint only; SDK callbacks always redraw. Pulse counts reflect the unchanged shader predicate in submitted candidates, conservatively including potentially clipped points.' };
  }

  /** Constant-time scheduling/counter snapshot; does not scan geometry pages. */
  getRenderScheduling() { return this._renderSchedulingStats(); }

  _notifyError(error) {
    this._lastError = error instanceof Error ? error.message : String(error);
    this._commitError = error instanceof Error ? error : new Error(String(error));
    this._rejectCommitWaiters(this._commitError);
    this._stopRenderSchedule();
    this.onError(error instanceof Error ? error : new Error(this._lastError));
  }

  _pickScreen(px, py) {
    if (!this._pipeline) return;
    const m = this.matrix, radius = Math.max(10, this.pointSize * 2);
    let best = null, distance = radius ** 2;
    const stats = { candidateVertices: 0, testedVertices: 0, spatialPages: 0, fullPages: 0,
      nodesTested: 0, movedTested: 0, movedRejected: 0, baseMovedSkipped: 0 };
    for (const kind of ['points', 'lines', 'polygons']) {
      if (!this.layers[kind]) continue;
      const primitiveSize = PRIMITIVE_SIZE[kind];
      for (const page of this.pages[kind]) {
        // Query only an existing complete tree: a click never starts a build.
        // Do not cull against the unpadded screen rectangle; near-edge vertices
        // outside that rectangle may still lie within the picking radius.
        const query = this.optimization.spatialPicking ? queryPickPrimitiveStarts({
          positions: page.positions, count: page.count, primitiveSize,
          spatial: page.spatial, spatialIndexedUntil: page.spatialIndexedUntil,
          movedPrimitiveStarts: page.movedPrimitiveStarts, matrix: m,
          width: this.width, height: this.height, px, py, radius, currentBounds: page
        }) : null;
        const starts = query?.starts ?? null;
        stats[starts === null ? 'fullPages' : 'spatialPages']++;
        if (query) for (const key of ['nodesTested', 'movedTested', 'movedRejected', 'baseMovedSkipped']) stats[key] += query[key];
        const primitiveCount = starts === null ? page.count / primitiveSize : starts.length;
        const candidateCount = primitiveCount * primitiveSize;
        stats.candidateVertices += candidateCount;
        const removed = page.overlayRemoved.size ? page.overlayRemoved : null;
        const colors = page.colors, positions = page.positions, ids = page.ids;
        let tested = 0;
        // Full fallback stays one flat vertex loop. Most pages have no logical
        // removals, so avoid a Set lookup for every live point in those pages.
        for (let ordinal = 0; ordinal < candidateCount; ordinal++) {
            const i = starts === null ? ordinal : starts[Math.floor(ordinal / primitiveSize)] + ordinal % primitiveSize;
            if (colors[i * 4 + 3] === 0 || (removed && removed.has(i))) continue;
            if (kind === 'points' && this._frame.lodStride > 1 && i % this._frame.lodStride !== 0 &&
                !(this.riskPreservation && isAlert(colors, i))) continue;
            tested++;
            const x = positions[i * 2], y = positions[i * 2 + 1];
            const w = m[3] * x + m[7] * y + m[15];
            if (w <= 0) continue;
            const sx = ((m[0] * x + m[4] * y + m[12]) / w + 1) * this.width / 2;
            const sy = (1 - (m[1] * x + m[5] * y + m[13]) / w) * this.height / 2;
            const d = (sx - px) ** 2 + (sy - py) ** 2;
            if (d < distance) {
              distance = d;
              best = { id: ids[i], kind, x, y, alert: isAlert(colors, i) };
            }
        }
        stats.testedVertices += tested;
      }
    }
    this._lastPickStats = stats;
    this._emitInteraction('pick', { ...(best || {}), hit: Boolean(best), pixel: { x: px, y: py } });
  }

  setLayers(layers) {
    for (const kind of KINDS) if (Object.prototype.hasOwnProperty.call(layers || {}, kind)) this.layers[kind] = Boolean(layers[kind]);
    this._requestRender('layers');
  }

  setPointSize(value) {
    if (!Number.isFinite(value)) throw new TypeError('点大小需要有限数值。');
    this.pointSize = clamp(value, 1, 24);
    this._requestRender('point-size');
  }

  setAdaptive(value) {
    this.adaptive = Boolean(value);
    this._requestRender('lod');
  }

  /** Runtime A/B controls; geometry and GPU pages remain intact. */
  setOptimizationOptions(options = {}) {
    const allowed = new Set(Object.keys(this.optimization));
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => !allowed.has(key))) throw new TypeError('未知优化选项。');
    const next = {...this.optimization, ...options};
    if (typeof next.spatial !== 'boolean' || typeof next.spatialRetainOnDisable !== 'boolean' ||
        !['eager', 'lazy'].includes(next.spatialBuildPolicy) || !['ranges', 'envelope'].includes(next.dirtyMode) ||
        !['density', 'legacy', 'accumulator'].includes(next.colorUploadPolicy) ||
        !['progressive', 'synchronous'].includes(next.spatialBuildExecution) ||
        !['always', 'settled'].includes(next.spatialPolicy)) throw new TypeError('优化模式无效。');
    for (const [key, min, max] of [['leafSize', 8, 65535], ['maxDepth', 1, 32],
      ['mergeGapBytes', 0, 262140], ['maxDirtyRanges', 1, 4096], ['settleFrames', 1, 60]]) {
      if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new RangeError(key + ' 超出允许范围。');
    }
    if (!Number.isFinite(next.minExtent) || next.minExtent < 0) throw new RangeError('minExtent 必须为非负数。');
    if (!Number.isFinite(next.spatialBuildBudgetMs) || next.spatialBuildBudgetMs <= 0 || next.spatialBuildBudgetMs > 20) {
      throw new RangeError('spatialBuildBudgetMs 须在 (0,20]。');
    }
    if (!Number.isInteger(next.spatialBuildChunkPrimitives) || next.spatialBuildChunkPrimitives < 1 || next.spatialBuildChunkPrimitives > 4096) {
      throw new RangeError('spatialBuildChunkPrimitives 须在 [1,4096]。');
    }
    if (!Number.isFinite(next.maxCandidateRatio) || next.maxCandidateRatio <= 0 || next.maxCandidateRatio > 1) throw new RangeError('maxCandidateRatio 须在 (0,1]。');
    if (!Number.isFinite(next.selectionReuseSlack) || next.selectionReuseSlack < 1 || next.selectionReuseSlack > 2) {
      throw new RangeError('selectionReuseSlack 须在 [1,2]。');
    }
    if (typeof next.spatialPicking !== 'boolean') throw new TypeError('spatialPicking 须为布尔值。');
    if (!['runs', 'ranges', 'binding-runs'].includes(next.positionDirtyPolicy)) throw new TypeError('positionDirtyPolicy 无效。');
    if (typeof next.liveBounds !== 'boolean' || typeof next.movedFilter !== 'boolean') throw new TypeError('liveBounds/movedFilter 须为布尔值。');
    if (![32, 64, 128, 256].includes(next.liveBoundsBlockSize)) throw new RangeError('liveBoundsBlockSize 无效。');
    if (!Number.isFinite(next.liveBoundsBudgetMs) || next.liveBoundsBudgetMs <= 0 || next.liveBoundsBudgetMs > 20) throw new RangeError('liveBoundsBudgetMs 须在 (0,20]。');
    if (!Number.isInteger(next.liveBoundsChunkPrimitives) || next.liveBoundsChunkPrimitives < 1 || next.liveBoundsChunkPrimitives > 65535) throw new RangeError('liveBoundsChunkPrimitives 须在 [1,65535]。');
    if (typeof next.coarseCandidates !== 'boolean') throw new TypeError('coarseCandidates 须为布尔值。');
    if (typeof next.spatialQueryWorker !== 'boolean') throw new TypeError('spatialQueryWorker 须为布尔值。');
    const rebuild = ['leafSize', 'minExtent', 'maxDepth'].some(key => next[key] !== this.optimization[key]);
    const toggled = next.spatial !== this.optimization.spatial;
    const workerToggled = next.spatialQueryWorker !== this.optimization.spatialQueryWorker;
    if (next.colorUploadPolicy !== this.optimization.colorUploadPolicy) {
      for (const kind of KINDS) for (const page of this.pages[kind]) {
        if (this.optimization.colorUploadPolicy === 'accumulator' && page.colorDirtyState?.pendingUniqueVertices) {
          const plan = page.colorDirtyState.peekPlan({ bufferBytes: page.uploaded * 4, mergeGapBytes: 0, maxRanges: page.capacity });
          page.colorDirtyRanges.push(...plan.ranges);
          page.colorDirtyState.reset();
        }
        if (next.colorUploadPolicy === 'accumulator' && page.colorDirtyRanges.length) {
          const state = page.colorDirtyState ||= new ColorDirtyState({ capacity: page.capacity });
          for (const [start, end] of page.colorDirtyRanges) for (let slot = start / 4; slot < Math.min(end / 4, page.uploaded); slot++) state.mark(slot);
          page.colorDirtyRanges.length = 0;
        }
      }
    }
    const coarseChanged = next.coarseCandidates !== this.optimization.coarseCandidates;
    const boundsChanged = next.liveBounds !== this.optimization.liveBounds || next.liveBoundsBlockSize !== this.optimization.liveBoundsBlockSize;
    const movedChanged = next.movedFilter !== this.optimization.movedFilter;
    this.optimization = next;
    if (workerToggled) {
      if (next.spatialQueryWorker) this._spatialQueryFailure = null;
      else {
        const client = this._spatialQueryClient;
        this._spatialQueryClient = null;
        client?.dispose();
      }
    }
    if (boundsChanged) for (const kind of KINDS) for (const page of this.pages[kind]) {
      if (next.liveBounds) this._createLiveBounds(page);
      else {
        page.liveBoundsIndex?.destroy(); page.liveBoundsIndex = null; this._liveBoundsPending.delete(page);
        // Disabling must also cover later restores of currently removed slots.
        page.liveBoundsEmpty = false;
        page.minX = Infinity; page.minY = Infinity; page.maxX = -Infinity; page.maxY = -Infinity;
        for (let v = 0; v < page.count; v++) {
          const x = page.positions[v * 2], y = page.positions[v * 2 + 1];
          page.minX = Math.min(page.minX, x); page.minY = Math.min(page.minY, y);
          page.maxX = Math.max(page.maxX, x); page.maxY = Math.max(page.maxY, y);
        }
      }
    }
    if (movedChanged || boundsChanged) for (const kind of KINDS) for (const page of this.pages[kind]) this._invalidateSelection(page);
    if (coarseChanged) for (const kind of KINDS) for (const page of this.pages[kind]) {
      if (next.coarseCandidates && page.coarse.referenceCapacity === null) {
        const began = performance.now();
        page.coarse = new CoarseSpatialIndex({ primitiveSize: PRIMITIVE_SIZE[kind], referenceCapacity: page.capacity / PRIMITIVE_SIZE[kind] });
        page.coarse.append(page.positions, 0, page.count); page.coarseIndexedUntil = page.count;
        this._coarseBuildMs += performance.now() - began;
      }
      page.selection = null; page.indexStride = 0;
    }
    if (rebuild || (!next.spatial && !next.spatialRetainOnDisable)) this.clearSpatialIndexes({ fineOnly: true });
    else if (toggled) for (const kind of KINDS) for (const page of this.pages[kind]) {
      page.selection = null; page.indexStride = 0;
    }
    this._requestRender('optimization');
    return {...next};
  }

  _ensureSpatialIndex(page) {
    const retained = Boolean(page.spatial);
    if (retained && page.spatialIndexedUntil === page.count) {
      // Reuse includes existing-tree count queries and cached selection hits.
      this._spatialLifecycle.fineReuseCount++;
      return true;
    }
    const began = performance.now();
    if (!page.spatial) {
      page.spatial = new PrimitiveSpatialIndex({ primitiveSize: PRIMITIVE_SIZE[page.kind], ...this.optimization,
        // A late distant point must not cause a single enormous degenerate
        // leaf sort in the interactive builder. Keeping a larger leaf is
        // conservative; it may trigger density fallback instead of filtering.
        maxSplitEntries: this.optimization.spatialBuildExecution === 'progressive' ? 256 : Infinity });
      page.spatialIndexedUntil = 0;
      this._spatialLifecycle.fineBuildCount++;
    }
    if (!page.spatialTask) {
      if (retained) this._spatialLifecycle.fineAppendCount++;
      page.spatialTask = { requestedAt: began, initialCount: page.spatialIndexedUntil, targetCount: page.count };
      this._spatialBuildQueue.push(page);
    } else page.spatialTask.targetCount = page.count;
    if (this.optimization.spatialBuildExecution === 'progressive') return false;
    const chunkStarted = performance.now();
    page.spatial.append(page.positions, page.spatialIndexedUntil, page.count);
    page.spatialIndexedUntil = page.count;
    const cpuMs = performance.now() - chunkStarted;
    this._spatialBuildMs += cpuMs;
    this._spatialBuildProgress.spatialBuildSynchronousCount++;
    if (this._inRender) {
      this._spatialBuildProgress.spatialBuildCpuMs += cpuMs;
      this._spatialBuildProgress.spatialBuildSliceMaxMs = Math.max(this._spatialBuildProgress.spatialBuildSliceMaxMs, cpuMs);
      this._spatialBuildProgress.spatialBuildMaxFrameMs = Math.max(this._spatialBuildProgress.spatialBuildMaxFrameMs, this._spatialBuildProgress.spatialBuildCpuMs);
    }
    this._spatialBuildProgress.spatialBuildMaxSliceMs = Math.max(this._spatialBuildProgress.spatialBuildMaxSliceMs, cpuMs);
    this._completeSpatialBuild(page);
    return true;
  }

  _completeSpatialBuild(page) {
    const task = page.spatialTask;
    if (!task) return;
    const wallMs = performance.now() - task.requestedAt;
    this._spatialBuildProgress.spatialBuildCompletedCount++;
    this._spatialBuildProgress.spatialBuildLastReadyWallMs = wallMs;
    this._spatialBuildProgress.spatialBuildMaxReadyWallMs = Math.max(this._spatialBuildProgress.spatialBuildMaxReadyWallMs, wallMs);
    page.spatialTask = null;
    // The next frame may use the now complete tree; the frame that built it
    // has already submitted all geometry. No GL commitment is inferred here.
    page.selection = null;
    page.indexStride = 0;
    this._requestRender('spatial-ready');
  }

  _pumpSpatialBuilds() {
    const metrics = this._spatialBuildProgress;
    this._spatialBuildQueue = this._spatialBuildQueue.filter(page => page.spatialTask);
    if (!this.optimization.spatial || this.optimization.spatialBuildExecution !== 'progressive' ||
        this._stableCameraFrames < this.optimization.settleFrames || !this._spatialBuildQueue.length) return;
    const began = performance.now(), deadline = began + this.optimization.spatialBuildBudgetMs;
    let attempted = false;
    // Round robin prevents the first 65k-vertex page from owning every frame.
    while (this._spatialBuildQueue.length && (!attempted || performance.now() < deadline)) {
      this._spatialBuildCursor %= this._spatialBuildQueue.length;
      const page = this._spatialBuildQueue[this._spatialBuildCursor];
      if (!page.spatialTask) {
        this._spatialBuildQueue.splice(this._spatialBuildCursor, 1);
        continue;
      }
      const primitiveSize = PRIMITIVE_SIZE[page.kind];
      page.spatialTask.targetCount = page.count;
      const end = Math.min(page.count, page.spatialIndexedUntil + primitiveSize * this.optimization.spatialBuildChunkPrimitives);
      const sliceStarted = performance.now();
      page.spatial.append(page.positions, page.spatialIndexedUntil, end);
      page.spatialIndexedUntil = end;
      const sliceMs = performance.now() - sliceStarted;
      this._spatialBuildMs += sliceMs;
      metrics.spatialBuildChunks++;
      metrics.spatialBuildMaxSliceMs = Math.max(metrics.spatialBuildMaxSliceMs, sliceMs);
      metrics.spatialBuildSliceMaxMs = Math.max(metrics.spatialBuildSliceMaxMs, sliceMs);
      attempted = true;
      if (end === page.count) {
        this._completeSpatialBuild(page);
        this._spatialBuildQueue.splice(this._spatialBuildCursor, 1);
      } else this._spatialBuildCursor++;
    }
    metrics.spatialBuildCpuMs += performance.now() - began;
    metrics.spatialBuildMaxFrameMs = Math.max(metrics.spatialBuildMaxFrameMs, metrics.spatialBuildCpuMs);
  }

  // Explicit cold-test boundary. Geometry, GL buffers, subscriptions, revisions,
  // and the default coarse summaries remain intact; no rendering ACK is forged.
  clearSpatialIndexes({ fineOnly = true } = {}) {
    if (typeof fineOnly !== 'boolean') throw new TypeError('fineOnly must be boolean');
    this._spatialBuildQueue.length = 0;
    this._spatialBuildCursor = 0;
    for (const kind of KINDS) for (const page of this.pages[kind]) {
      page.spatial = null; page.spatialIndexedUntil = 0; page.spatialTask = null;
      page.selection = null; page.indexStride = 0;
      if (!fineOnly) {
        const began = performance.now();
        page.coarse = new CoarseSpatialIndex({ primitiveSize: PRIMITIVE_SIZE[kind],
        referenceCapacity: this.optimization.coarseCandidates ? Math.floor(PAGE_VERTICES / PRIMITIVE_SIZE[kind]) : null });
        page.coarse.append(page.positions, 0, page.count);
        page.coarseIndexedUntil = page.count;
        this._coarseBuildMs += performance.now() - began;
      }
    }
    this._requestRender('spatial-clear');
  }

  /** false: uniform LOD; true (default): retain all color-classified alert points. */
  setRiskPreservation(enabled) {
    const next = Boolean(enabled);
    if (next === this.riskPreservation) return;
    this.riskPreservation = next;
    for (const page of this.pages.points) page.indexStride = 0;
    this._requestRender('risk');
  }

  focus(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('focus 需要局部米制 xy。');
    this.camera.x = x; this.camera.y = y;
    if (this.mode === 'baidu' && this._layer && this._map) {
      const point = this._layer.unprojectFromLayer([x, y]);
      this._map.panTo(new window.BMap.Point(point[0], point[1]));
    }
    this._emitInteraction('focus');
  }

  resetView() {
    this._resize();
    this.camera = { x: 0, y: 0, scale: this._defaultScale, heading: 0 };
    if (this.mode === 'baidu' && this._map) {
      this._map.centerAndZoom(new window.BMap.Point(CENTER.lng, CENTER.lat), 12);
      this._map.setHeading(0);
      this._map.setTilt(0);
    }
    this._emitInteraction('focus');
    return true;
  }

  zoomBy(factor) {
    if (!Number.isFinite(factor) || factor <= 0) throw new TypeError('缩放因子必须为正数。');
    if (this.mode === 'baidu' && this._map) this._map.setZoom(clamp(this._map.getZoom() + Math.log2(factor), 3, 21));
    else this.camera.scale = clamp(this.camera.scale * factor, 0.0005, 16);
    this._emitInteraction('zoom');
    return true;
  }

  animateView(seconds) {
    if (!Number.isFinite(seconds)) throw new TypeError('动画时间必须为有限秒数。');
    if (this.mode !== 'sandbox') return false;
    this.camera.x = Math.sin(seconds * 0.35) * 1800;
    this.camera.y = Math.sin(seconds * 0.23) * 1300;
    this.camera.scale = this._defaultScale * Math.pow(2, 0.7 + Math.sin(seconds * 0.27) * 1.3);
    this.camera.heading = Math.sin(seconds * 0.16) * 0.55;
    this._emitInteraction('animate');
    return true;
  }

  rotateBy(degrees) {
    if(!Number.isFinite(degrees))throw new TypeError('旋转角度须为有限数值。');
    let heading;
    if(this.mode==='baidu'&&this._map) {
      heading=((this._map.getHeading()+degrees)%360+360)%360;
      this._map.setHeading(heading);
      this._layer?.triggerRepaint();
    } else {
      this.camera.heading=((this.camera.heading+degrees*Math.PI/180)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
      heading=this.camera.heading*180/Math.PI;
    }
    this._emitInteraction('rotate',{heading});
    return true;
  }

  reset() {
    this._pulseActive = false;
    this._settlePending = false;
    for (const kind of KINDS) for (const page of this.pages[kind]) page.spatialTask = null;
    this._rejectCommitWaiters(new DOMException('实验重置，未完成的 GL 提交已取消。', 'AbortError'));
    this._commitError = null;
    // Revisions remain monotonic so tokens from a previous run cannot match new data.
    this._minimumRevision = ++this._stagingRevision;
    this._committedRevision = this._stagingRevision;
    this._glUploadSubmissionMs = 0;
    this._spatialBuildMs = 0;
    this._coarseBuildMs = 0;
    this._spatialLifecycle = { fineBuildCount: 0, fineAppendCount: 0, fineReuseCount: 0, coarseDensityGuardCount: 0 };
    this._spatialBuildQueue.length = 0;
    this._spatialBuildCursor = 0;
    this._spatialBuildProgress = { spatialBuildChunks: 0, spatialBuildCpuMs: 0, spatialBuildSliceMaxMs: 0,
      spatialBuildMaxSliceMs: 0, spatialBuildMaxFrameMs: 0, spatialBuildCompletedCount: 0,
      spatialBuildLastReadyWallMs: 0, spatialBuildMaxReadyWallMs: 0, spatialBuildSynchronousCount: 0 };
    this._deleteGPU();
    for (const kind of KINDS) for (const page of this.pages[kind]) page.liveBoundsIndex?.destroy();
    this._liveBoundsPending.clear();
    this._liveBoundsCpu = { liveBoundsMutationCpuMs: 0, liveBoundsMaintenanceCpuMs: 0 };
    this._movedFilterStats = { movedPrimitivesTested: 0, movedPrimitivesRejected: 0, movedBaseCandidatesSkipped: 0 };
    this.pages = { points: [], lines: [], polygons: [] };
    this._dirtyGeometryPages.clear();
    this._geometrySubmission = { queuedPagesVisited: 0, pagesSubmitted: 0, cleanPagesSkipped: 0 };
    // The worker mirrors the old pages; drop it rather than leak their copies.
    this._spatialQueryClient?.dispose();
    this._spatialQueryClient = null;
    this._spatialQueryFailure = null;
    this._spatialQueryFailureCount = 0;
    this._spatialQueryApplied = { pages: 0, denseFallbacks: 0, staleSkips: 0, misses: 0, lastTransportMs: null };
    this._classifierStats = createClassifierStats();
    this._featureBindings.clear();
    this._featureOverlay.clear();
    this._removedFeatureMoves.clear();
    this._overlayStats = { positionUpdates: 0, removals: 0, restorations: 0, tombstoned: 0 };
    this._updateQueue.clear();
    this._totals = { vertices: 0, features: 0, points: 0, pointAlerts: 0, cpuBytes: 0, gpuBytes: 0, uploadedBytes: 0 };
    this._frame = { ...this._frame, vertices: 0, pointsSubmitted: 0, pointAlertsDrawn: 0, drawCalls: 0, geometryDrawCalls: 0, culledPages: 0, visiblePages: 0, lodStride: 1,
      frameTelemetryCpuMs: 0, frameTotalCpuMs: 0, previousFrameTelemetryCpuMs: 0, previousFrameTotalCpuMs: 0 };
    this._lastFrameTime = 0;
    this._fpsSamples.length = 0;
    this.resetView();
    if (this.mode === 'sandbox') this._startSandbox();
  }

  getGraphicsInfo() {
    const gl=this._gl || this._localGL;
    if(!gl || gl.isContextLost())return {available:false};
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    return {available:true,version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),unmaskedVendor:info?gl.getParameter(info.UNMASKED_VENDOR_WEBGL):null,unmaskedRenderer:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null};
  }

  subscribeFrames(listener) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (typeof listener !== 'function') throw new TypeError('帧观察者必须为函数。');
    this._frameListeners.add(listener);
    return () => this._frameListeners.delete(listener);
  }

  getBaiduMap() { return this.mode === 'baidu' ? this._map : null; }

  unprojectLocalPoint(point) {
    if (this.mode !== 'baidu' || !this._layer || typeof this._layer.unprojectFromLayer !== 'function') {
      throw new Error('请先连接百度地图后转换局部米制坐标。');
    }
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      throw new RangeError('需要有效的局部米制 xy 数组。');
    }
    const geographic = this._layer.unprojectFromLayer(point);
    if (!geographic || !Number.isFinite(geographic[0]) || !Number.isFinite(geographic[1]) ||
        geographic[0] < -180 || geographic[0] > 180 || geographic[1] < -90 || geographic[1] > 90) {
      throw new Error('百度地图未返回有效的 BD-09 经纬度。');
    }
    return [geographic[0], geographic[1]];
  }

  projectGeographicPoint(point) {
    if (this.mode !== 'baidu' || !this._layer) throw new Error('请先连接百度地图后投影真实地理坐标。');
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
        point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) {
      throw new RangeError('需要有效的 BD-09 经度、纬度数组。');
    }
    const projected = this._layer.projectToLayer(point);
    if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
      throw new Error('百度地图未返回有效的局部米制坐标。');
    }
    return [projected[0], projected[1]];
  }

  getViewState() {
    if (this.mode === 'baidu' && this._map) {
      const center = this._map.getCenter();
      return { mode: 'baidu', center: { lng: center.lng, lat: center.lat },
        zoom: this._map.getZoom(), heading: this._map.getHeading(), tilt: this._map.getTilt() };
    }
    return { mode: 'sandbox', ...this.camera };
  }

  /** Replays a camera pose without layering an SDK easing animation on the trace. */
  setViewState(view) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (!view || typeof view !== 'object' || Array.isArray(view)) throw new TypeError('视角必须为对象。');
    const current = this.getViewState(), next = { ...current, ...view };
    if (next.mode !== current.mode) throw new Error('视角模式必须与当前地图一致。');
    if (next.mode === 'baidu') {
      next.center = { ...current.center, ...view.center };
      if (![next.center.lng, next.center.lat, next.zoom, next.heading, next.tilt].every(Number.isFinite) ||
          next.center.lng < -180 || next.center.lng > 180 || next.center.lat < -90 || next.center.lat > 90 ||
          next.zoom < 3 || next.zoom > 21 || next.tilt < 0 || next.tilt > 73) {
        throw new RangeError('百度地图视角的坐标、缩放、角度必须有效。');
      }
      next.heading = ((next.heading % 360) + 360) % 360;
      const options = { noAnimation: true };
      if (next.center.lng !== current.center.lng || next.center.lat !== current.center.lat) {
        this._map.setCenter(new window.BMap.Point(next.center.lng, next.center.lat), options);
      }
      if (next.zoom !== current.zoom) this._map.setZoom(next.zoom, options);
      if (next.heading !== current.heading) this._map.setHeading(next.heading, options);
      if (next.tilt !== current.tilt) this._map.setTilt(next.tilt, options);
    } else {
      if (![next.x, next.y, next.scale, next.heading].every(Number.isFinite) || next.scale < 0.0005 || next.scale > 16) {
        throw new RangeError('沙盒视角的坐标、比例与角度必须有效。');
      }
      this.camera = { x: next.x, y: next.y, scale: next.scale, heading: next.heading };
    }
    this._requestRender('camera-state');
    return this.getViewState();
  }

  getTrackedFeatureIds() { return Array.from(this._trackedFeatureIds); }

  /** Selects ordinary point IDs for a sparse-update trial and subscribes them once. */
  getColorUpdateTargets(count = 2) {
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new RangeError('更新试验目标数须为 1–8。');
    const candidates = [], seen = new Set();
    for (const [pageIndex, page] of this.pages.points.entries()) {
      // Endpoints maximize separation inside an arrival-order GPU page.
      for (let step = 0; step < page.count && candidates.length < count; step++) {
        const vertexIndex = step % 2 === 0 ? step / 2 : page.count - 1 - (step - 1) / 2;
        const id = page.ids[vertexIndex];
        if (seen.has(id) || isAlert(page.colors, vertexIndex)) continue;
        if (!this._trackedFeatureIds.has(id) && this._trackedFeatureIds.size + candidates.filter(v => !this._trackedFeatureIds.has(v.id)).length >= MAX_TRACKED_FEATURES) continue;
        seen.add(id);
        candidates.push({ id, color: Array.from(page.colors.subarray(vertexIndex * 4, vertexIndex * 4 + 4)), pageIndex, vertexIndex });
      }
      if (candidates.length >= count) break;
    }
    this.trackFeatures([...new Set([...this._trackedFeatureIds, ...candidates.map(v => v.id)])]);
    return candidates.filter(({ id, color }) => this._featureBindings.get(id)?.every(({ page, start, end }) => {
      if (page.kind !== 'points') return false;
      for (let i = start; i < end; i++) {
        if (isAlert(page.colors, i) || !color.every((v, channel) => v === page.colors[i * 4 + channel])) return false;
      }
      return true;
    }));
  }

  /** Constant-time staging/GL-submission receipts for the streaming hot path. */
  getCommitStats() {
    return { stagingRevision: this._stagingRevision, committedRevision: this._committedRevision,
      glUploadSubmissionMs: this._glUploadSubmissionMs,
      features: this._totals.features, totalVertices: this._totals.vertices, pointVertices: this._totals.points,
      cpuBytes: this._totals.cpuBytes, gpuBytes: this._totals.gpuBytes, uploadedBytes: this._totals.uploadedBytes,
      pendingGeometryPages: this._dirtyGeometryPages.size,
      contextLost: this.contextLost, lastError: this._lastError || null };
  }

  getStats() {
    const spatial = { liveBoundsTypedBytes: 0, liveBoundsPendingBlocks: 0, liveBoundsScannedPrimitives: 0,
      liveBoundsCaptureTypedBytes: 0, liveBoundsCapturePeakTypedBytes: 0,
      spatialFinePages: 0, spatialCoarsePages: 0, spatialIndexedPrimitives: 0,
      spatialReadyPages: 0, spatialPendingPages: 0, spatialPendingPrimitives: 0,
      spatialBuildTargetPrimitives: 0, spatialSplitLimitedLeaves: 0,
      colorDirtyStateBytes: 0, colorDirtyUniqueVertices: 0, coarseReferenceBytes: 0, coarseOwnedBytes: 0, fineOwnedBytes: 0, spatialEstimatedBytes: 0 };
    for (const kind of KINDS) for (const page of this.pages[kind]) {
      if (page.liveBoundsIndex) {
        const stats = page.liveBoundsIndex.getStats();
        spatial.liveBoundsTypedBytes += stats.typedArrayBytes;
        spatial.liveBoundsPendingBlocks += stats.pendingBlocks;
        spatial.liveBoundsScannedPrimitives += stats.rescanPrimitives;
        spatial.liveBoundsCaptureTypedBytes += stats.captureTypedArrayBytes;
        spatial.liveBoundsCapturePeakTypedBytes += stats.capturePeakTypedArrayBytes;
      }
      if (page.colorDirtyState) {
        const stats = page.colorDirtyState.getStats();
        spatial.colorDirtyStateBytes += stats.memoryBytes; spatial.colorDirtyUniqueVertices += stats.pendingUniqueVertices;
      }
      if (page.coarse) {
        const stats = page.coarse.getStats();
        spatial.spatialCoarsePages++;
        spatial.coarseOwnedBytes += stats.typedArrayBytes;
        spatial.coarseReferenceBytes += stats.referenceBytes;
        spatial.spatialEstimatedBytes += stats.estimatedBytes;
      }
      if (page.spatial) {
        const stats = page.spatial.getStats();
        spatial.spatialFinePages++;
        spatial.spatialIndexedPrimitives += stats.primitives;
        spatial.fineOwnedBytes += stats.typedArrayBytes;
        spatial.spatialEstimatedBytes += stats.estimatedBytes;
        spatial.spatialSplitLimitedLeaves += page.spatial.splitLimitedLeaves || 0;
        spatial.spatialBuildTargetPrimitives += page.count / PRIMITIVE_SIZE[kind];
        if (page.spatialIndexedUntil === page.count) spatial.spatialReadyPages++;
      }
      if (page.spatialTask) {
        spatial.spatialPendingPages++;
        spatial.spatialPendingPrimitives += (page.count - page.spatialIndexedUntil) / PRIMITIVE_SIZE[kind];
      }
    }
    return {
      ...this._frame,
      renderPolicy: this.renderPolicy, renderScheduling: this._renderSchedulingStats(),
      features: this._totals.features, totalVertices: this._totals.vertices,
      pointVertices: this._totals.points, cpuBytes: this._totals.cpuBytes,
      // Total covers all CPU point data; drawn/submitted describe GL payloads
      // in the latest frame, including submitted points outside the viewport.
      pointAlertsTotal: this._totals.pointAlerts,
      pointLodStride: this._frame.lodStride, riskPreservation: this.riskPreservation,
      gpuBytes: this._totals.gpuBytes, uploadedBytes: this._totals.uploadedBytes,
      stagingRevision: this._stagingRevision, committedRevision: this._committedRevision,
      glUploadSubmissionMs: this._glUploadSubmissionMs,
      geometrySubmission: { ...this._geometrySubmission, pendingPages: this._dirtyGeometryPages.size,
        interpretation: 'CPU page-enumeration counters and issued GL submissions; not GPU execution or completion.' },
      spatialBuildMs: this._spatialBuildMs, coarseBuildMs: this._coarseBuildMs,
      ...this._spatialLifecycle, ...this._spatialBuildProgress, ...spatial, ...this._liveBoundsCpu, ...this._movedFilterStats,
      spatialBuildProgress: spatial.spatialBuildTargetPrimitives ? spatial.spatialIndexedPrimitives / spatial.spatialBuildTargetPrimitives : 1,
      optimization: {...this.optimization},
      selectionReuse: { exact: this._selectionMetrics?.exactReuses ?? 0, incremental: this._selectionMetrics?.incrementalReuses ?? 0,
        worldBoxMisses: this._selectionMetrics?.worldBoxMisses ?? 0, cacheHits: this._selectionMetrics?.cacheHits ?? 0,
        classifier: {...this._classifierStats} },
      spatialQueryWorker: { enabled: Boolean(this.optimization.spatialQueryWorker),
        active: Boolean(this._spatialQueryClient), ...this._spatialQueryApplied,
        failedForRun: Boolean(this._spatialQueryFailure), failureReason: this._spatialQueryFailure,
        failures: this._spatialQueryFailureCount,
        workerStats: this._spatialQueryClient ? {...this._spatialQueryClient.stats} : null },
      featureOverlay: { ...this._featureOverlay.snapshot(), ...this._overlayStats },
      updateQueue: this._updateQueue.snapshot(),
      selectionScratchBytes: this._candidateScratch?.byteLength || 0,
      colorPlannerScratchBytes: this._densityUploadPlanner ? DENSITY_SCRATCH_BYTES : 0,
      pages: KINDS.reduce((sum, kind) => sum + this.pages[kind].length, 0),
      pageCapacity: PAGE_VERTICES, mode: this.mode, adaptive: this.adaptive,
      zoom: this.mode === 'baidu' && this._map ? this._map.getZoom() : 12 + Math.log2(this.camera.scale / this._defaultScale),
      heading: this.mode === 'baidu' && this._map ? this._map.getHeading() : this.camera.heading * 180 / Math.PI,
      pointSize: this.pointSize, pixelRatio: this.pixelRatio,
      contextLost: this.contextLost, lastError: this._lastError || null,
      referenceCenter: { ...CENTER }, rendererDiagnostics: this._sharedDiagnostics || null
    };
  }

  async connectBaidu(ak) {
    if (this.destroyed) throw new Error('渲染器已销毁。');
    if (typeof ak !== 'string' || !ak.trim()) throw new Error('请输入百度地图浏览器端 AK；当前仍为本地 WebGL 沙盒。');
    if (this.mode === 'baidu') return true;
    if (this._connecting) return this._connecting;
    const token = ++this._connectToken;
    const commitErrorBeforeConnect = this._commitError;
    const attempt = async () => {
      const BMap = await loadBaiduSDK(ak.trim());
      if (this.destroyed || token !== this._connectToken) throw new Error('地图连接已取消。');
      const host = document.createElement('div');
      host.id = 'geo-pulse-map-' + (++sequence);
      host.className = 'baidu-map-host';
      Object.assign(host.style, { position: 'absolute', inset: '0', opacity: '0', pointerEvents: 'none' });
      this._mapHost = host;
      this.container.appendChild(host);
      try {
        this._map = new BMap.Map(host.id, {
          center: new BMap.Point(CENTER.lng, CENTER.lat), zoom: 12, heading: 0, tilt: 0
        });
        this._map.enableScrollWheelZoom();
        this._map.enableRotate();
        this._map.enableTilt();
        if (typeof this._map.setTheme === 'function') this._map.setTheme('dark');
        if (typeof this._map.setMapStyle === 'function') this._map.setMapStyle({
          styleJson: [
            { featureType: 'land', elementType: 'geometry', stylers: { color: '#091825ff' } },
            { featureType: 'water', elementType: 'geometry', stylers: { color: '#06121eff' } },
            { featureType: 'green', elementType: 'geometry', stylers: { color: '#102b31ff' } },
            { featureType: 'road', elementType: 'geometry.fill', stylers: { color: '#1b354aff' } },
            { featureType: 'road', elementType: 'geometry.stroke', stylers: { color: '#28445aff' } }
          ]
        });
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this._connectCancel = null;
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(() => finish(new Error('百度地图自定义图层未在10秒内完成首帧，请检查 AK 鉴权与 WebGL 支持。')), 10000);
          this._connectCancel = () => finish(new Error('地图连接已取消。'));
          this._layer = new BMap.WebGLCustomLayer({
            referCenter: new BMap.Point(CENTER.lng, CENTER.lat),
            vertexShader: VS, fragmentShader: FS,
            unsafeGL: true, animation: this.renderPolicy === 'continuous',
            renderStage: 'poi', zIndex: 100,
            renderState: { blend: 'normal', depthTest: false, depthWrite: false, cullFace: 'none' },
            onRender: (ctx) => {
              if (this.destroyed || token !== this._connectToken) return;
              try {
                if (ctx.gl.isContextLost()) return;
                this.contextLost = false;
                this.matrix.set(ctx.getMVPMatrix());
                this._render(ctx.gl, this.matrix, {
                  time: performance.now(), unitsPerPixel: ctx.getUnitsPerPixel(),
                  pixelRatio: ctx.getPixelRatio(), shared: true
                });
                if (!settled) {
                  this.mode = 'baidu';
                  if (this._raf) cancelAnimationFrame(this._raf);
                  this._raf = 0;
                  this.canvas.remove();
                  host.style.opacity = '1';
                  host.style.pointerEvents = 'auto';
                  this._lastFrameTime = 0;
                  this._fpsSamples.length = 0;
                  finish();
                }
              } catch (error) {
                if (!settled) finish(error);
                else {
                  this._stopRenderSchedule();
                  this._notifyError(error);
                }
              }
            },
            onError: (error) => {
              const reason = error instanceof Error ? error : new Error('百度地图自定义图层错误：' + String(error));
              if (!settled) finish(reason);
              else this._notifyError(reason);
            }
          });
          this._sdkAnimationLayer = this._layer;
          this._sdkAnimating = this.renderPolicy === 'continuous';
          this._repaintPending = false;
          this._map.addLayer(this._layer);
          this._requestRender('sdk-connect');
        });
        if (this.destroyed || token !== this._connectToken) throw new Error('地图连接已取消。');
        for (const [name, type] of [['dragend', 'pan'], ['zoomend', 'zoom']]) {
          this._map.addEventListener(name, () => this._emitInteraction(type));
        }
        this._map.addEventListener('click', (event) => {
          if (event.pixel) this._pickScreen(event.pixel.x, event.pixel.y);
        });
        return true;
      } catch (error) {
        // Only recover a new draw failure owned by this SDK connection attempt.
        // Notify before clearing the latch so consumers fail/terminate the old run;
        // already rejected commit promises remain rejected and are never retried.
        const recoverSDKRender = !commitErrorBeforeConnect && this._commitError === error &&
          this._gl && this._gl !== this._localGL && this._activeContextCanvas !== this.canvas;
        if (recoverSDKRender) this._notifyError(error);
        this._cleanupMap();
        if (!this.destroyed) {
          this.mode = 'sandbox';
          if (!this.canvas.isConnected) this.container.appendChild(this.canvas);
          // A consumer may have raised another error while handling the failure.
          if (recoverSDKRender && this._commitError === error) this._commitError = null;
          this._startSandbox();
        }
        throw error;
      }
    };
    this._connecting = attempt();
    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  _cleanupMap() {
    this._stopRenderSchedule();
    // Detach before SDK remove/destroy can emit events on a retiring canvas.
    for (const canvas of this._contextCanvases.keys()) if (canvas !== this.canvas) this._unbindContextEvents(canvas);
    this._activeContextCanvas = this.canvas;
    this._deleteGPU();
    if (this._layer) {
      try { this._layer.remove(); } catch (_) { /* Map may already be destroyed. */ }
    }
    if (this._map) {
      try { this._map.destroy(); } catch (_) { /* Keep sandbox usable on SDK failure. */ }
    }
    this._layer = null;
    this._sdkAnimationLayer = null;
    this._sdkAnimating = false;
    this._activeContextCanvas = this.canvas;
    this._map = null;
    if (this._mapHost) this._mapHost.remove();
    this._mapHost = null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopRenderSchedule();
    this._spatialQueryClient?.dispose();
    this._spatialQueryClient = null;
    this._spatialBuildQueue.length = 0;
    this._densityUploadPlanner = null;
    for (const kind of KINDS) for (const page of this.pages[kind]) page.spatialTask = null;
    this._rejectCommitWaiters(new DOMException('渲染器销毁，未完成的 GL 提交已取消。', 'AbortError'));
    this._connectToken++;
    if (this._connectCancel) this._connectCancel();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._resizeObserver.disconnect();
    this._listeners.forEach((remove) => remove());
    this._listeners.length = 0;
    for (const canvas of this._contextCanvases.keys()) this._unbindContextEvents(canvas);
    this._cleanupMap();
    this.canvas.remove();
    for (const kind of KINDS) for (const page of this.pages[kind]) page.liveBoundsIndex?.destroy();
    this._liveBoundsPending.clear();
    this._liveBoundsCpu = { liveBoundsMutationCpuMs: 0, liveBoundsMaintenanceCpuMs: 0 };
    this._movedFilterStats = { movedPrimitivesTested: 0, movedPrimitivesRejected: 0, movedBaseCandidatesSkipped: 0 };
    this.pages = { points: [], lines: [], polygons: [] };
    this._dirtyGeometryPages.clear();
    this._featureBindings.clear();
    this._trackedFeatureIds.clear();
    this._removedFeatureMoves.clear();
    this._featureOverlay.clear();
    this._frameListeners.clear();
    this._totals.cpuBytes = 0;
    this._totals.gpuBytes = 0;
    const loseContext = this._localGL.getExtension('WEBGL_lose_context');
    if (loseContext) loseContext.loseContext();
  }
}
