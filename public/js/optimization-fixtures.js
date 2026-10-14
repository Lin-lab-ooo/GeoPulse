export const EXPERIMENT_SEED = 20261009;
export const SPATIAL_VARIANTS = [
  {name: 'input-pages', spatial: false, spatialPolicy: 'always', leafSize: 256, maxCandidateRatio: 1},
  ...[64, 256, 1024].map(leafSize => ({name: `tree-${leafSize}`, spatial: true, spatialPolicy: 'always', leafSize, maxCandidateRatio: 1})),
  {name: 'hybrid-64', spatial: true, spatialPolicy: 'settled', leafSize: 64, maxCandidateRatio: .15},
  {name: 'hybrid-64-ratio35', spatial: true, spatialPolicy: 'settled', leafSize: 64, maxCandidateRatio: .35},
  {name: 'hybrid-64-ratio100', spatial: true, spatialPolicy: 'settled', leafSize: 64, maxCandidateRatio: 1}
];

export function makeOptimizationData(count, distribution) {
  let state = EXPERIMENT_SEED;
  const random = () => {
    state += 0x6D2B79F5;
    let v = Math.imul(state ^ state >>> 15, state | 1);
    v ^= v + Math.imul(v ^ v >>> 7, v | 61);
    return ((v ^ v >>> 14) >>> 0) / 4294967296;
  };
  const positions = new Float32Array(count * 2), colors = new Uint8Array(count * 4), ids = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    let x, y;
    if (distribution === 'alternating-ab') {
      const c = i % 2 ? 3000 : -3000;
      x = c + (random() - .5) * 200; y = c + (random() - .5) * 200;
    } else if (distribution === 'corridor') {
      x = (random() - .5) * 9000; y = .3 * x + (random() - .5) * 70;
    } else if (distribution === 'dense-outliers' && random() < .95) {
      x = 500 + (random() - .5) * 300; y = -400 + (random() - .5) * 300;
    } else {
      x = (random() - .5) * 10000; y = (random() - .5) * 10000;
    }
    positions.set([x, y], i * 2);
    colors.set(i % 28 === 0 ? [255, 70, 90, 245] : [82, 212, 200, 255], i * 4);
    ids[i] = i + 1;
  }
  return {groups: [{kind: 'points', positions, colors, ids, featureCount: count}], featureCount: count};
}

export function optimizationCameraTrace(distribution) {
  const cluster = distribution === 'dense-outliers' ? {x: 500, y: -400} : {x: -3000, y: -3000};
  return [
    {name: 'overview', x: 0, y: 0, scale: .045, heading: 0},
    {name: 'center', x: 0, y: 0, scale: .65, heading: 0},
    {name: 'cluster', ...cluster, scale: .85, heading: 0},
    ...Array.from({length: 8}, (_, i) => {
      const x = -3500 + i * 1000;
      return {name: `pan-rotate-${i}`, x, y: distribution === 'corridor' ? .3 * x : x,
        scale: .18 + i * .03, heading: i * .13};
    })
  ];
}
