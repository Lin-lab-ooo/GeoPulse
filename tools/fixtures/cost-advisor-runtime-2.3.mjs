/** Research runtime for held-out CPU index-slice policies. No rendering control. */
export class SliceCostAdvisor {
  constructor(model, kind = 'mlp') {
    if (!['mlp','ridge'].includes(kind)) throw new RangeError('advisor kind');
    if(model.featureNames.length!==12||model.actions.length!==4||model.inputMean.length!==16||model.inputStd.length!==16||model.inputStd.some(x=>!Number.isFinite(x)||x<=0))throw new TypeError('model dimensions');
    this.model=model;this.kind=kind;this.input=new Float64Array(16);this.h1=new Float64Array(16);this.h2=new Float64Array(8);
    this.weights=Object.fromEntries(Object.entries(model.mlp.weights).map(([k,v])=>[k,Float32Array.from(v.values)]));
  }
  _normalize(features,action){
    for(let i=0;i<16;i++){const raw=i<12?features[i]:(this.model.actions[i-12]===action?1:0);this.input[i]=Math.max(-16,Math.min(16,(raw-this.model.inputMean[i])/this.model.inputStd[i]));}
  }
  _decode(z){return Math.max(0,Math.expm1(Math.max(-20,Math.min(20,z*this.model.targetLogStd+this.model.targetLogMean))));}
  predict(features,action){
    if(features.length!==12||!features.every(Number.isFinite)||!this.model.actions.includes(action))throw new TypeError('invalid advisor input');
    this._normalize(features,action);
    if(this.kind==='ridge'){
      const c=this.model.ridge.coefficients;let z=c[0];for(let i=0;i<16;i++)z+=this.input[i]*c[i+1];
      return{meanMs:this._decode(z),upperMs:Math.max(this._decode(z),Math.max(0,Math.expm1(Math.min(20,z*this.model.targetLogStd+this.model.targetLogMean+this.model.ridge.validationLogMarginP90))))};
    }
    const w=this.weights;
    for(let j=0;j<16;j++){let s=w.b1[j];for(let i=0;i<16;i++)s+=this.input[i]*w.w1[i*16+j];this.h1[j]=Math.max(0,s);}
    for(let j=0;j<8;j++){let s=w.b2[j];for(let i=0;i<16;i++)s+=this.h1[i]*w.w2[i*8+j];this.h2[j]=Math.max(0,s);}
    let loc=w.b3[0],quantile=w.b3[1];for(let i=0;i<8;i++){loc+=this.h2[i]*w.w3[i*2];quantile+=this.h2[i]*w.w3[i*2+1];}
    const meanMs=this._decode(loc),calibrated=Math.max(0,Math.expm1(Math.min(20,loc*this.model.targetLogStd+this.model.targetLogMean+this.model.mlp.validationLogMarginP90)));
    return{meanMs,upperMs:Math.max(meanMs,this._decode(quantile),calibrated)};
  }
  staticPageGate(pagePrimitives){
    const m=this.model;if(pagePrimitives<m.gates.minimumPagePrimitives)return 'small-page';
    if(Math.abs((pagePrimitives-m.inputMean[3])/m.inputStd[3])>m.gates.maximumAbsoluteFeatureZ)return 'page-out-of-training-domain';
    return null;
  }
  choose(features,budgetMs){
    if(!Number.isFinite(budgetMs)||budgetMs<=0)throw new RangeError('positive CPU budget required');
    const m=this.model;
    if(features.length!==12||!features.every(Number.isFinite))return{action:m.gates.fallbackAction,fallback:'nonfinite-input',evaluations:0};
    const staticGate=this.staticPageGate(features[3]);if(staticGate)return{action:m.gates.fallbackAction,fallback:staticGate,evaluations:0};
    if(features.some((x,i)=>Math.abs((x-m.inputMean[i])/m.inputStd[i])>m.gates.maximumAbsoluteFeatureZ))return{action:m.gates.fallbackAction,fallback:'feature-out-of-training-domain',evaluations:0};
    let action=m.actions[0],evaluations=0,fits=false,selected=null;for(const a of m.actions){const p=this.predict(features,a);evaluations++;if(selected===null)selected=p;if(p.upperMs<=budgetMs){action=a;selected=p;fits=true;}}
    return{action,fallback:fits?null:'no-action-fits-budget',evaluations,predictedCpuMs:selected.meanMs,predictedUpperMs:selected.upperMs};
  }
}
export function chooseEmaAction(rateMsPerPrimitive,budgetMs,actions=[32,64,128,256]){
  if(!Number.isFinite(rateMsPerPrimitive)||rateMsPerPrimitive<=0)return{action:128,fallback:'cold-ema'};
  let action=actions[0];for(const a of actions)if(a*rateMsPerPrimitive*1.5<=budgetMs)action=a;
  return{action,fallback:null};
}
