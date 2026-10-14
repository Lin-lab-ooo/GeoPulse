import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SliceCostAdvisor,chooseEmaAction} from '../tools/fixtures/cost-advisor-runtime-2.3.mjs';
const model=JSON.parse(await readFile(new URL('../ml/spatial-cost-advisor-2.3.json',import.meta.url),'utf8'));
test('trained advisor retains distinct whole-workload training and test manifests',()=>{
 const sets=Object.values(model.splits).map(x=>new Set(x));for(let i=0;i<sets.length;i++)for(let j=i+1;j<sets.length;j++)for(const id of sets[i])assert.ok(!sets[j].has(id));
 assert.equal(model.mlp.parameterCount,426);assert.equal(model.mlp.heads.length,2);
});
test('CPU advisor exposes gate and preserves deterministic fallback for large unseen pages',()=>{
 const a=new SliceCostAdvisor(model);assert.equal(a.staticPageGate(500),'small-page');assert.equal(a.staticPageGate(60000),'page-out-of-training-domain');
 const f=model.inputMean.slice(0,12);f[3]=60000;const choice=a.choose(f,.75);assert.equal(choice.action,128);assert.equal(choice.evaluations,0);assert.ok(choice.fallback);
});
test('malformed or nonfinite features do not reach inference',()=>{
 const a=new SliceCostAdvisor(model);assert.equal(a.choose([NaN],.75).fallback,'nonfinite-input');assert.throws(()=>a.predict(new Array(12).fill(NaN),128),/invalid advisor input/);assert.throws(()=>a.choose(new Array(12).fill(0),0),/positive CPU budget/);
});
test('in-domain neural and linear predictions are finite nonnegative upper bounds',()=>{
 const f=model.inputMean.slice(0,12);for(const kind of ['ridge','mlp']){const a=new SliceCostAdvisor(model,kind);for(const action of model.actions){const p=a.predict(f,action);assert.ok(Number.isFinite(p.meanMs)&&p.meanMs>=0);assert.ok(Number.isFinite(p.upperMs)&&p.upperMs>=p.meanMs);}const c=a.choose(f,.75);assert.ok(model.actions.includes(c.action));assert.equal(c.evaluations,4);}
});
test('minimum slice still makes progress when no estimated slice fits the budget',()=>{
 const a=new SliceCostAdvisor(model);const c=a.choose(model.inputMean.slice(0,12),1e-10);assert.equal(c.action,32);
});
test('EMA starts at fixed128, uses prior rate, and takes only admissible actions',()=>{
 assert.equal(chooseEmaAction(0,.75).action,128);assert.equal(chooseEmaAction(.001,.1).action,64);assert.equal(chooseEmaAction(.001,.75).action,256);assert.equal(chooseEmaAction(.1,.05).action,32);
});
