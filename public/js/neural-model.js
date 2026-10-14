// CPU-only inference for the exported, actually trained NumPy window MLP AE.
// Weights are row-major [inputSize, outputSize]. Labels never enter inference.
export function validateModel(model) {
  if (model?.schemaVersion !== 1 || !Number.isInteger(model.windowSize) || model.windowSize < 1 || model.windowSize > 256) throw new Error('Unsupported neural model schema/window');
  const channels = model.channels?.length;
  if (channels !== 8 || !Number.isFinite(model.threshold) || model.threshold < 0) throw new Error('Invalid model channels/threshold');
  for (const [name, values] of Object.entries(model.normalization || {})) {
    if (!['mean', 'std'].includes(name) || values.length !== channels || !values.every(Number.isFinite)) throw new Error('Invalid normalization');
  }
  if (!model.normalization?.mean || !model.normalization?.std || !model.normalization.std.every(v => v > 0)) throw new Error('Invalid normalization scale');
  let width = model.windowSize * channels;
  if (!Array.isArray(model.layers) || !model.layers.length) throw new Error('Missing network layers');
  for (const layer of model.layers) {
    if (layer.inputSize !== width || !Number.isInteger(layer.outputSize) || layer.outputSize < 1 || layer.outputSize > 2048 || !['tanh', 'linear'].includes(layer.activation)) throw new Error('Invalid network dimensions');
    if (layer.weights?.length !== layer.inputSize * layer.outputSize || layer.bias?.length !== layer.outputSize || !layer.weights.every(Number.isFinite) || !layer.bias.every(Number.isFinite)) throw new Error('Invalid network weights');
    width = layer.outputSize;
  }
  if (width !== model.windowSize * channels) throw new Error('Reconstruction output size mismatch');
  return model;
}

export function inferWindow(model, readings) {
  const count = model.channels.length;
  if (readings.length !== model.windowSize) throw new Error('Inference requires one complete window');
  const input = new Float64Array(model.windowSize * count);
  for (let t = 0; t < readings.length; t++) {
    if (readings[t].length !== count) throw new Error('Invalid sensor channel count');
    for (let c = 0; c < count; c++) {
      const value = readings[t][c];
      if (!Number.isFinite(value)) throw new Error('Sensor values must be finite');
      input[t * count + c] = (value - model.normalization.mean[c]) / model.normalization.std[c];
    }
  }
  let activation = input;
  for (const layer of model.layers) {
    const next = Float64Array.from(layer.bias);
    for (let i = 0; i < layer.inputSize; i++) {
      const v = activation[i], offset = i * layer.outputSize;
      for (let j = 0; j < layer.outputSize; j++) next[j] += v * layer.weights[offset + j];
    }
    if (layer.activation === 'tanh') for (let j = 0; j < next.length; j++) next[j] = Math.tanh(next[j]);
    activation = next;
  }
  const channelResiduals = [];
  const start = input.length - count;
  for (let c = 0; c < count; c++) channelResiduals.push((activation[start + c] - input[start + c]) ** 2);
  const score = channelResiduals.reduce((a, b) => a + b, 0) / count;
  if (!Number.isFinite(score)) throw new Error('Non-finite neural score');
  return { score, threshold: model.threshold, status: score > model.threshold ? 'anomaly' : 'normal', channelResiduals };
}
