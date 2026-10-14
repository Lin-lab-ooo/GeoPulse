/** Post-protocol local report forwarding. Never used in a timed loading trial. */
export async function captureReportSaveReceipt({route,body,sanitize=identity=>identity,onReceipt=()=>{},timeout=120000}) {
  // APIResponse owns its body independently of the browser inspector response cache.
  // One explicit request, no retry/redirect; fulfill prevents a second browser POST.
  const response=await route.fetch({postData:body,maxRedirects:0,maxRetries:0,timeout});
  try {
    const bytes=await response.body();
    let receipt;
    try { receipt=sanitize(JSON.parse(bytes.toString('utf8'))); }
    catch(error) { receipt={ok:false,error:sanitize(String(error.message)),kind:'invalid-report-response-json'}; }
    const observed={status:response.status(),receipt,collection:'route.fetch APIResponse body; original bytes fulfilled unchanged',responseBytes:bytes.byteLength};
    onReceipt(observed);
    await route.fulfill({response,body:bytes});
    return observed;
  } finally { await response.dispose(); }
}
