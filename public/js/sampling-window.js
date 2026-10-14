/**
 * End-of-window accounting without inventing a closing callback.
 * A tail is an observed callback-free lower bound, not proof of CPU blocking.
 */
export function samplingWindowCoverage(samples,endMs) {
 if(!Array.isArray(samples))throw new TypeError('Samples must be an array');
 if(!Number.isFinite(endMs)||endMs<0)return {windowMs:null,callbacks:0,callbacksPerSecond:null,lastSampleAtMs:null,unclosedTailMs:null,observedMaxIntervalMs:null,maxObservedOrTailMs:null};
 let count=0,last=null,maximum=null;
 for(const sample of samples){
  if(!Number.isFinite(sample?.atMs)||sample.atMs<0||sample.atMs>endMs)continue;
  count++;last=last===null?sample.atMs:Math.max(last,sample.atMs);
  if(Number.isFinite(sample.intervalMs)&&sample.intervalMs>0)maximum=maximum===null?sample.intervalMs:Math.max(maximum,sample.intervalMs);
 }
 const tail=Math.max(0,endMs-(last??0));
 return {windowMs:endMs,callbacks:count,callbacksPerSecond:endMs>0?count*1000/endMs:null,lastSampleAtMs:last,
  unclosedTailMs:tail,observedMaxIntervalMs:maximum,maxObservedOrTailMs:Math.max(maximum??0,tail)};
}
