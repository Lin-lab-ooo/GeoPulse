import test from 'node:test';
import assert from 'node:assert/strict';
import {captureReportSaveReceipt} from '../tools/report-save-receipt-2.6.mjs';
function fixture(text,status=201) {
 const calls=[],bytes=Buffer.from(text),response={body:async()=>{calls.push(['body']);return bytes;},status:()=>status,dispose:async()=>calls.push(['dispose'])};
 const route={fetch:async options=>{calls.push(['fetch',options]);return response;},fulfill:async options=>calls.push(['fulfill',options]),continue:async()=>{throw Error('Duplicate original request prohibited');}};
 return {calls,bytes,response,route};
}
test('report response forwarded once, complete body and status unchanged',async()=>{
 const f=fixture('{"ok":true,"absolutePath":"a.json"}'),seen=[];
 const result=await captureReportSaveReceipt({route:f.route,body:'{"runs":[1,2,3]}',onReceipt:r=>seen.push(r)});
 assert.equal(f.calls.filter(c=>c[0]==='fetch').length,1);assert.equal(f.calls[0][1].postData,'{"runs":[1,2,3]}');
 assert.equal(f.calls[0][1].maxRetries,0);assert.equal(f.calls[0][1].maxRedirects,0);
 const forwarded=f.calls.find(c=>c[0]==='fulfill')[1];assert.strictEqual(forwarded.body,f.bytes);assert.strictEqual(forwarded.response,f.response);
 assert.equal(result.status,201);assert.equal(result.receipt.ok,true);assert.strictEqual(result,seen[0]);assert.equal(f.calls.at(-1)[0],'dispose');
});
test('non-JSON failure is observed but exact server response still reaches UI',async()=>{
 const f=fixture('broken response',503);const r=await captureReportSaveReceipt({route:f.route,body:'{}'});
 assert.equal(r.status,503);assert.equal(r.receipt.ok,false);assert.equal(r.receipt.kind,'invalid-report-response-json');
 assert.strictEqual(f.calls.find(c=>c[0]==='fulfill')[1].body,f.bytes);assert.equal(f.calls.at(-1)[0],'dispose');
});
test('fulfill failure releases APIResponse without retrying POST',async()=>{
 const f=fixture('{"ok":true}');f.route.fulfill=async()=>{throw Error('client disconnected');};
 await assert.rejects(captureReportSaveReceipt({route:f.route,body:'{}'}),/client disconnected/);
 assert.equal(f.calls.filter(c=>c[0]==='fetch').length,1);assert.equal(f.calls.at(-1)[0],'dispose');
});
