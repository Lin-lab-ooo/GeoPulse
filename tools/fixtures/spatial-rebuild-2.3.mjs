/** Research-only reference ordering. Original geometry and vertex offsets stay intact. */
import { PrimitiveSpatialIndex } from './research-2.2/public/js/spatial-index.js';
export const REBUILD_STRATEGIES = ['arrival','arrival-bounded','bit-reversal','middle-bfs','sample64-bit-reversal','sample64-middle-bfs'];
const now=()=>performance.now();
export function createRebuildPlan({count,primitiveSize=1,strategy='sample64-bit-reversal',chunkPrimitives=128,sampleCount=64}={}) {
  if(!Number.isSafeInteger(count)||count<0)throw new RangeError('count must be nonnegative');
  if(![1,2,3].includes(primitiveSize))throw new RangeError('complete point/line/triangle size required');
  if(!REBUILD_STRATEGIES.includes(strategy))throw new RangeError('unknown rebuild strategy');
  if(!Number.isSafeInteger(chunkPrimitives)||chunkPrimitives<1||chunkPrimitives>256)throw new RangeError('bounded chunk required');
  if(!Number.isSafeInteger(sampleCount)||sampleCount<0||sampleCount>256)throw new RangeError('bounded sample required');
  const began=now(),blockCount=Math.ceil(count/chunkPrimitives),blocks=[],sampled=strategy.startsWith('sample64-'),sampleN=sampled?Math.min(count,sampleCount):0;
  const samples=new Uint32Array(sampleN);
  for(let i=0;i<sampleN;i++)samples[i]=sampleN===1?0:Math.floor(i*(count-1)/(sampleN-1));
  if(strategy.endsWith('bit-reversal')) {
    const bits=Math.ceil(Math.log2(Math.max(1,blockCount))),capacity=2**bits;
    for(let i=0;i<capacity;i++) {let reverse=0,n=i;for(let bit=0;bit<bits;bit++){reverse=reverse*2+(n&1);n>>>=1;}if(reverse<blockCount)blocks.push(reverse);}
  } else if(strategy.endsWith('middle-bfs')) {
    const queue=blockCount?[[0,blockCount]]:[];for(let i=0;i<queue.length;i++){const[lo,hi]=queue[i],mid=(lo+hi)>>1;blocks.push(mid);if(lo<mid)queue.push([lo,mid]);if(mid+1<hi)queue.push([mid+1,hi]);}
  } else for(let block=0;block<blockCount;block++)blocks.push(block);
  const ranges=[];
  for(const sample of samples)ranges.push(sample*primitiveSize,(sample+1)*primitiveSize);
  const firstSampleAt=value=>{let lo=0,hi=samples.length;while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid]<value)lo=mid+1;else hi=mid;}return lo;};
  for(const block of blocks) {
    let at=block*chunkPrimitives;const end=Math.min(count,at+chunkPrimitives);let sampleAt=firstSampleAt(at);
    while(sampleAt<samples.length&&samples[sampleAt]<end) { const sample=samples[sampleAt++];if(at<sample)ranges.push(at*primitiveSize,sample*primitiveSize);at=sample+1; }
    if(at<end)ranges.push(at*primitiveSize,end*primitiveSize);
  }
  const packed=Uint32Array.from(ranges),blockOrder=Uint32Array.from(blocks);
  return {strategy,count,primitiveSize,chunkPrimitives,sampleCount:sampleN,ranges:packed,samples,blockOrder,
    planMs:now()-began,planTypedArrayBytes:packed.byteLength+samples.byteLength+blockOrder.byteLength,
    // Temporary JS arrays also exist during packing; no engine-specific heap claim.
    temporaryNumericSlots:ranges.length+blocks.length+(strategy.endsWith('middle-bfs')?blockCount*2:0),
    // BFS interval pairs and temporary packing arrays are tracked as numeric
    // slots; JS array/object headers and engine capacities remain unmeasured.
    temporaryBfsIntervalNumericSlots:strategy.endsWith('middle-bfs')?blockCount*2:0,rangeCount:packed.length/2};
}
export function treeShape(index) {
  const stack=index._root?[index._root]:[],result={maxDepth:0,leafCount:0,largestLeaf:0,depthLimitLeaves:0,depthLimitPrimitives:0,splitLimitedLeaves:0};
  while(stack.length) {const node=stack.pop();result.maxDepth=Math.max(result.maxDepth,node.depth);if(node.entries){result.leafCount++;result.largestLeaf=Math.max(result.largestLeaf,node.entries.length);
    if(node.depth>=index.maxDepth){result.depthLimitLeaves++;result.depthLimitPrimitives+=node.entries.length;}if(node.splitLimited)result.splitLimitedLeaves++;
  }else stack.push(node.left,node.right);}
  return result;
}
export function buildReorderedIndex(positions,{primitiveSize=1,strategy='sample64-bit-reversal',chunkPrimitives=128,sampleCount=64,
  leafSize=64,minExtent=8,maxDepth=16,maxSplitEntries=256,copyGeometry=true}={}) {
  if(!(positions instanceof Float32Array)||positions.length%(primitiveSize*2))throw new RangeError('complete Float32 geometry required');
  const count=positions.length/(primitiveSize*2),began=now(),plan=createRebuildPlan({count,primitiveSize,strategy,chunkPrimitives,sampleCount});
  const copyBegan=now(),geometry=copyGeometry?positions.slice():positions,geometryCopyMs=now()-copyBegan;
  const index=new PrimitiveSpatialIndex({primitiveSize,leafSize,minExtent,maxDepth,maxSplitEntries}),slices=[];
  const buildBegan=now();
  for(let at=0;at<plan.ranges.length;at+=2) {const before=now(),inserted=index.append(geometry,plan.ranges[at],plan.ranges[at+1]);slices.push({primitives:inserted,ms:now()-before});}
  const appendMs=now()-buildBegan;
  return {index,plan,slices,geometryCopyMs,geometryCopyBytes:copyGeometry?geometry.byteLength:0,appendMs,totalPrepareBuildMs:now()-began,indexStats:index.getStats(),treeShape:treeShape(index),
    coordinateOrderUnchanged:true,geometryCopyRetainedByIndex:false};
}
