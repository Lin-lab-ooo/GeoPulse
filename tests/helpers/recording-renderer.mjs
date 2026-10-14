import { GeoRenderer } from '../../public/js/renderer.js';

// A WebGL API recorder, not a renderer. It performs no rasterization, GPU work,
// buffer copy, asynchronous scheduling, or browser compositing. This deliberate
// choice avoids making large fake GPU memcpy costs part of CPU comparisons.
export class RecordingGL {
  constructor(canvas) {
    this.canvas = canvas;
    this.bindings = {};
    this.attributes = {};
    this.nextBuffer = 0;
    const constants = ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS',
      'ALIASED_POINT_SIZE_RANGE', 'ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'DYNAMIC_DRAW',
      'DEPTH_TEST', 'CULL_FACE', 'BLEND', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA',
      'COLOR_BUFFER_BIT', 'FLOAT', 'UNSIGNED_BYTE', 'POINTS', 'LINES', 'TRIANGLES',
      'UNSIGNED_SHORT'];
    constants.forEach((name, index) => { this[name] = index + 1; });
    this.resetMeasurements();
  }
  resetMeasurements() {
    this.uploads = [];
    this.draws = [];
    this.allocations = [];
  }
  createShader(type) { return { type }; }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  deleteShader() {}
  createProgram() { return {}; }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return true; }
  getProgramInfoLog() { return ''; }
  deleteProgram() {}
  getUniformLocation(_program, name) { return name; }
  getAttribLocation(_program, name) { return name === 'a_position' ? 0 : 1; }
  getParameter() { return [1, 64]; }
  getExtension() { return null; }
  isContextLost() { return false; }
  createBuffer() { return { id: ++this.nextBuffer }; }
  deleteBuffer() {}
  bindBuffer(target, buffer) { this.bindings[target] = buffer; }
  bufferData(target, byteLength) {
    if (typeof byteLength !== 'number') throw new TypeError('Expected fixed byte allocation.');
    this.bindings[target].byteLength = byteLength;
    this.allocations.push({ target, byteLength });
  }
  bufferSubData(target, offset, data) {
    const buffer = this.bindings[target];
    if (offset < 0 || offset + data.byteLength > buffer.byteLength) throw new RangeError('Upload exceeds allocation.');
    this.uploads.push({ target, buffer, offset, byteLength: data.byteLength });
  }
  viewport() {}
  disable() {}
  enable() {}
  blendFunc() {}
  clearColor() {}
  clear() {}
  useProgram() {}
  uniformMatrix4fv() {}
  uniform1f() {}
  enableVertexAttribArray() {}
  vertexAttribPointer(location) { this.attributes[location] = this.bindings[this.ARRAY_BUFFER]; }
  drawArrays(mode, first, count) { this.draws.push({ mode, first, count, indexed: false, buffer: this.attributes[0] }); }
  drawElements(mode, count, type, offset) {
    if (type !== this.UNSIGNED_SHORT || offset + count * 2 > this.bindings[this.ELEMENT_ARRAY_BUFFER].byteLength) {
      throw new RangeError('Invalid uint16 indexed draw.');
    }
    this.draws.push({ mode, count, indexed: true, buffer: this.attributes[0] });
  }
}

class Element {
  constructor(tag) { this.tagName = tag; this.style = {}; this.children = []; this.events = {}; }
  appendChild(element) { this.children.push(element); element.parent = this; element.isConnected = true; return element; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.isConnected = false; }
  setAttribute() {}
  addEventListener(type, listener) { this.events[type] = listener; }
  removeEventListener(type) { delete this.events[type]; }
  getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; }
  getContext() { return this.gl ||= new RecordingGL(this); }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}

export function createRecordingRenderer() {
  const names = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let nextRAF = 0;
  const raf = new Map();
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { createElement: tag => new Element(tag), head: new Element('head') };
  globalThis.requestAnimationFrame = callback => { raf.set(++nextRAF, callback); return nextRAF; };
  globalThis.cancelAnimationFrame = id => raf.delete(id);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const renderer = new GeoRenderer(new Element('div'));
  const gl = renderer._localGL;
  let frameTime = 1000;
  return {
    renderer,
    gl,
    render(camera = null) {
      if (camera) Object.assign(renderer.camera, camera);
      gl.resetMeasurements();
      frameTime += 16.667;
      const started = performance.now();
      renderer._render(gl, renderer._localMatrix(), {
        time: frameTime, unitsPerPixel: 1 / renderer.camera.scale, pixelRatio: 1
      });
      const cpuMs = performance.now() - started;
      const stats = renderer.getStats();
      const colorBuffers = new Set(Object.values(renderer.pages).flat().map(page => page.gpu?.color));
      const uploads = gl.uploads.map(upload => ({
        ...upload, buffer: upload.buffer.id,
        channel: upload.target === gl.ELEMENT_ARRAY_BUFFER ? 'index' : colorBuffers.has(upload.buffer) ? 'color' : 'position'
      }));
      return {
        cpuMs, stats, uploads,
        uploadBytes: uploads.reduce((sum, upload) => sum + upload.byteLength, 0),
        uploadCalls: uploads.length,
        indexUploadBytes: uploads.filter(upload => upload.channel === 'index').reduce((sum, upload) => sum + upload.byteLength, 0),
        colorUploadBytes: uploads.filter(upload => upload.channel === 'color').reduce((sum, upload) => sum + upload.byteLength, 0),
        colorUploadCalls: uploads.filter(upload => upload.channel === 'color').length,
        drawCalls: gl.draws.length,
        submittedVertices: gl.draws.reduce((sum, draw) => sum + draw.count, 0)
      };
    },
    dispose() {
      renderer.destroy();
      for (const name of names) {
        const descriptor = previous.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}
