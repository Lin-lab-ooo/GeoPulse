/** Pure JSON export planning. No requests, downloads, renderer access, or sample removal. */
export const REPORT_MAX_RUNS = 100;
export const REPORT_MAX_BYTES = 160 * 1024 * 1024;
const encoder = new TextEncoder();
const byteLength = text => encoder.encode(text).byteLength;
const jsonSnapshot = value => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Report evidence must be JSON serializable');
  return {value:JSON.parse(serialized),bytes:byteLength(serialized)};
};
const arrayBytes = units => 2 + units.reduce((sum,unit)=>sum+unit.bytes,0) + Math.max(0,units.length-1);

/**
 * Snapshot each evidence unit separately; never retain every serialized part string.
 * Public part descriptors contain source ordinals, not copies of raw sample arrays.
 * Paired run chunks/map groups avoid a Cartesian product. Extra map-only parts use
 * original run ordinal 0 as an explicit anchor to satisfy the existing server.
 */
export function planReportExport({common,runs,mapRecords=[],exportId,maxRuns=REPORT_MAX_RUNS,maxBytes=REPORT_MAX_BYTES}) {
  if (!common || typeof common!=='object' || Array.isArray(common)) throw new TypeError('Common report metadata must be an object');
  if (!Array.isArray(runs)||!Array.isArray(mapRecords)) throw new TypeError('Run and map evidence must be arrays');
  if (typeof exportId!=='string'||!exportId) throw new TypeError('Export ID is required');
  if (!Number.isSafeInteger(maxRuns)||maxRuns<1||maxRuns>REPORT_MAX_RUNS) throw new RangeError('Run limit must be between 1 and 100');
  if (!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>REPORT_MAX_BYTES) throw new RangeError('Byte limit must be positive and at most 160 MiB');
  for(const key of ['runs','mapFrameAblation','exportBundle'])if(Object.hasOwn(common,key))throw new TypeError(`Common metadata cannot replace ${key}`);
  const metadata=jsonSnapshot(common),runUnits=runs.map(jsonSnapshot);
  if (!metadata.value || typeof metadata.value!=='object' || Array.isArray(metadata.value)) throw new TypeError('Common JSON metadata must remain an object');
  for(const key of ['runs','mapFrameAblation','exportBundle'])if(Object.hasOwn(metadata.value,key))throw new TypeError(`Common JSON metadata cannot replace ${key}`);
  const preparationOnly=Array.isArray(metadata.value.loadingProtocols)&&metadata.value.loadingProtocols.length>0&&metadata.value.loadingProtocols.every(protocol=>
    protocol?.kind==='loading-interaction-comparison'&&['failed','cancelled'].includes(protocol.status)&&Array.isArray(protocol.attempts)&&protocol.attempts.length>0&&protocol.attempts.every(attempt=>['failed','cancelled'].includes(attempt?.status)));
  if(!runUnits.length&&!preparationOnly)throw new RangeError('An export needs a measured run or failed/cancelled preparation evidence');
  const groups=[],groupByKey=new Map();
  for(const [ordinal,record] of mapRecords.entries()){
    const unit=jsonSnapshot(record),key=unit.value.runId||'unidentified';
    if(!groupByKey.has(key)){groupByKey.set(key,groups.length);groups.push({key,units:[],ordinals:[]});}
    groups[groupByKey.get(key)].units.push(unit);groups[groupByKey.get(key)].ordinals.push(ordinal);
  }
  for(const group of groups)group.bytes=arrayBytes(group.units);
  const descriptors=[];
  const bundleFor=(descriptor,partCount,bound=false)=>({
    schemaVersion:'1.0',exportId,commonEvidenceId:exportId+'/common',
    partIndex:bound?Number.MAX_SAFE_INTEGER:descriptor.index+1,partCount:bound?Number.MAX_SAFE_INTEGER:partCount,
    totalRuns:runUnits.length,totalMapGroups:groups.length,
    runOrdinals:descriptor.ordinals,repeatedRunOrdinals:descriptor.anchor?[0]:[],anchorOnly:descriptor.anchor,
    mapRecordOrdinals:descriptor.groupIndex===null?[]:groups[descriptor.groupIndex].ordinals,
    mapGroupIndex:descriptor.groupIndex,mapGroupKey:descriptor.groupIndex===null?null:groups[descriptor.groupIndex].key,
    commonEvidenceRepeated:descriptor.index>0,
    reconstruction:'Run identity is exportId + original zero-based ordinal. Anchor runs and common evidence repeat by design; retain each map group once by its index. Raw samples are never split or filtered.',
  });
  const estimate=(descriptor,bound=true,partCount=0)=>{
    const envelope=byteLength(JSON.stringify({runs:[],mapFrameAblation:[],exportBundle:bundleFor(descriptor,partCount,bound)}));
    const commonInterior=metadata.bytes-2;
    const groupBytes=descriptor.groupIndex===null?2:groups[descriptor.groupIndex].bytes;
    const runsBytes=arrayBytes(descriptor.ordinals.map(index=>runUnits[index]));
    return envelope+(commonInterior?commonInterior+1:0)+(runsBytes-2)+(groupBytes-2);
  };
  const fit=descriptor=>estimate(descriptor)<=maxBytes;
  let cursor=0;
  while(cursor<runUnits.length||descriptors.length<groups.length||descriptors.length===0){
    const index=descriptors.length,groupIndex=index<groups.length?index:null;
    const descriptor={index,groupIndex,ordinals:[],anchor:false};
    while(cursor<runUnits.length&&descriptor.ordinals.length<maxRuns){
      descriptor.ordinals.push(cursor);
      if(!fit(descriptor)){descriptor.ordinals.pop();break;}
      cursor++;
    }
    if(!descriptor.ordinals.length&&runUnits.length){
      if(groupIndex!==null){
        // Also covers a large map group that cannot share a part with the next
        // primary run but still fits with the mandatory original anchor.
        descriptor.ordinals=[0];descriptor.anchor=true;
        if(!fit(descriptor))throw new RangeError(`Map evidence group ${groupIndex+1}, common evidence and anchor run exceed ${maxBytes} bytes; no samples were removed`);
      } else throw new RangeError(`Run ordinal ${cursor} plus common evidence exceeds ${maxBytes} bytes; raw samples cannot be split automatically`);
    }
    if(!fit(descriptor))throw new RangeError(`Common/preparation evidence exceeds ${maxBytes} bytes; no evidence was removed`);
    descriptors.push(descriptor);
  }
  const payloadFor=descriptor=>({...metadata.value,
    runs:descriptor.ordinals.map(index=>runUnits[index].value),
    mapFrameAblation:descriptor.groupIndex===null?[]:groups[descriptor.groupIndex].units.map(unit=>unit.value),
    exportBundle:bundleFor(descriptor,descriptors.length),
  });
  // Full, exact UTF-8 preflight before the caller can save any part. Each string
  // becomes unreachable after its part; only immutable snapshots/byte counts stay.
  for(const descriptor of descriptors){
    const actual=byteLength(JSON.stringify(payloadFor(descriptor)));
    if(actual!==estimate(descriptor,false,descriptors.length))throw new Error('Report byte accounting mismatch');
    if(actual>maxBytes)throw new RangeError(`Report part ${descriptor.index+1} exceeds the byte limit`);
    descriptor.bytes=actual;
    Object.freeze(descriptor.ordinals);Object.freeze(descriptor);
  }
  return Object.freeze({
    exportId,totalRuns:runUnits.length,totalMapGroups:groups.length,partCount:descriptors.length,
    parts:Object.freeze(descriptors.map(descriptor=>Object.freeze({index:descriptor.index,runOrdinals:descriptor.ordinals,anchorOnly:descriptor.anchor,mapGroupIndex:descriptor.groupIndex,bytes:descriptor.bytes}))),
    serializePart(index){
      if(!Number.isSafeInteger(index)||index<0||index>=descriptors.length)throw new RangeError('Invalid report part index');
      const body=JSON.stringify(payloadFor(descriptors[index]));
      const bytes=byteLength(body);
      if(bytes!==descriptors[index].bytes||bytes>maxBytes)throw new Error('Report snapshot changed after preflight');
      return {body,bytes,index};
    },
  });
}


/** Retains successful receipts on failure; retries only the unfinished snapshot. */
export function createReportExportSession(plan) {
  const receipts=new Map();let active=false;
  return Object.freeze({
    plan,
    get completed(){return receipts.size===plan.partCount;},
    get receipts(){return [...receipts].sort((a,b)=>a[0]-b[0]).map(([index,value])=>({index,value}));},
    async saveRemaining(postPart,onProgress=()=>{}){
      if(active)throw new Error('This report snapshot is already being saved');
      active=true;
      try {
        for(const descriptor of plan.parts){
          if(receipts.has(descriptor.index))continue;
          onProgress({index:descriptor.index,total:plan.partCount,saved:receipts.size});
          // Only one serialized request body is live at a time. Receipts never
          // enter report payloads; paths are chosen and returned by the server.
          const part=plan.serializePart(descriptor.index);
          const receipt=await postPart(part);
          receipts.set(descriptor.index,receipt);
        }
        return this.receipts;
      } finally {active=false;}
    },
  });
}
