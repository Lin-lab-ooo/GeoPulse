#!/usr/bin/env python3
"""Derive public allowlisted whole-map measurements. No network or browser access.
Usage: python tools/whole-map-public-evidence.py --source PRIVATE_RESULTS --output measurements
"""
import argparse, collections, gzip, hashlib, json, math, pathlib, re, statistics
SCHEMA='geopulse/public-whole-map-evidence-1.0'
GROUPS={'formal-realmap1':27,'matched-policy1':9,'minimal-policy1':9,'native-coalesced1':3,'baidu-production-complete1':6}
F={
 'frame':'frameId window contextId nativeRafTimestampMs startEpochMs endEpochMs cpuMs renderCpuMs gpuMs gpuStatus gpuUnavailableReason intervalMs instrumentationSetupCpuMs gpuAvailableEpochMs',
 'upload':'calls cpuMs bufferCalls textureCalls uploadBytes allocationBytes unknownByteCalls baseCalls businessCalls unattributedCalls',
 'span':'spanId parentSpanId frameId window phase kind thread startEpochMs endEpochMs durationMs status scope partial layerId layerType renderPass sourceId',
 'workerSpan':'type phase startedEpochMs endEpochMs durationMs scope batchId',
 'window':'windowId name startEpochMs endEpochMs durationMs',
 'mark':'name epochMs atMs phaseId edge',
 'batch':'batchId points received revision receivedEpochMs ackEpochMs stageAndCommitMs stageAndEnqueueMs confirmation queuedOnly',
 'businessFrame':'engine atMs revision instances inputPoints nativeBusinessDraw nativeBusinessDrawCalls epochMs window',
 'pose':'atMs epochMs apiCpuMs u x y scale center zoom bearing pitch visible focused',
 'raf':'atMs epochMs intervalMs window',
 'bframe':'callbackId timestamp startedMs endedMs callbackCpuMs window scheduledBy attribution targetCommands basemapDraws businessDraws otherContextDraws wholeMapGpuMs targetContextGpuMs targetContextId queryAttempted firstTargetCommandMs coverageVerified gpuScope coverage',
 'bspan':'phase window startedEpochMs endEpochMs durationMs thread scope inclusive',
 'bworker':'window atMs type runId featureCount',
 'presentation':'traceTsUs browserEpochMs reporterCount stateCounts hasPresentedAll displayTraceIds',
 'anchor':'name traceTsUs browserEpochMs offsetMs',
 'longtask':'name entryType startTime duration epochMs window',
 'countSample':'atMs shown bytes batchSize',
 'frameSample':'atMs intervalMs',
}
F={k:v.split() for k,v in F.items()}
METRIC=('bytes parseMs packMs parsed delivered maxParsedNotDelivered maxParserDrainRecords maxReaderChunkBytes maxParserBufferedTextCodeUnits batches fetchMs firstBatchMs expected maxPendingBatches mode elapsedMs').split()
NETWORK=('schemaVersion clockBasis mainClockAvailable responseHeadersAtMs firstByteAtMs firstByteWorkerElapsedMs responseBodyEofAtMs responseBodyEofWorkerElapsedMs workerDoneAtMs readerWaitMs readerReadCalls ackWaitMs ackWaitCount maxAckWaitMs').split()
TRANSPORT='contentEncoding decodedResponseBytes encodedBodyBytes resourceTimingDecodedBytes complete byteScope'.split()
RECEIPT=('revision stagingRevision committedRevision updated unchanged ignored updatedPoints received features totalVertices pointVertices cpuBytes gpuBytes uploadedBytes pendingGeometryPages contextLost glUploadSubmissionMs nativeBusinessDraw nativeBusinessDrawCalls queuedOnly confirmation renderedAtMs firstNativeBusinessFrameAtMs firstConfirmedBusinessAtMs firstNativeBusinessFrameMs firstNativeBusinessFrameOrigin wallMs startedEpochMs proof').split()
BIZMETRICS=('firstVisibleMs totalMs dataDoneMs features vertices stagedVertices confirmedVertices fullyAcknowledgedVertices unacknowledgedConfirmedVertices networkBytes decodedResponseBytes encodedBodyBytes featuresPerSecond fpsMean frameP95 frameP99 maxFrameMs longTasks longTaskTotalMs sampledMaxHeapBytes gpuBytes cpuGeometryBytes stagingMs glUploadSubmissionMs stagingRevision committedRevision parseMs packMs drawCalls pages lodStride').split()
SCHEDULING='wakeRequests coalescedWakeRequests repaintRequests businessFrames drawCalls verticesSubmitted renderCpuMs animationStarts animationStops sandboxFrameRequests reentrantCallbacks policy lastWakeReason pulseActive pendingFrame sdkAnimating sandboxFramePending sleeping interpretation'.split()
COVERAGE='verifiedSamples targetCallbacks available partial unframedTargetCommandCount otherContextDrawCount scope'.split()
STAT=('time fps frameMs frameInterval drawCalls geometryDrawCalls vertices pointsSubmitted pointAlertsDrawn culledPages visiblePages lodStride unitsPerPixel queryMs indexMs indexUploadSubmissionMs coarseQueryMs coarseBucketsTested coarseDensityGuardPages coarseEmptyPages coarseCandidatePages coarseCandidatePrimitives indexUploadedBytes nodesTested cacheHits spatialDenseFallbackPages spatialPendingFallbackPages exactReuses incrementalReuses worldBoxMisses matrixChanged previousFrameTelemetryCpuMs previousFrameTotalCpuMs spatialSettled frameTelemetryCpuMs frameTotalCpuMs features totalVertices pointVertices cpuBytes pointAlertsTotal pointLodStride gpuBytes uploadedBytes stagingRevision committedRevision glUploadSubmissionMs spatialBuildMs coarseBuildMs fineBuildCount fineAppendCount fineReuseCount coarseDensityGuardCount spatialBuildChunks spatialBuildCpuMs spatialBuildSliceMaxMs spatialBuildMaxSliceMs spatialBuildMaxFrameMs spatialBuildCompletedCount spatialBuildLastReadyWallMs spatialBuildMaxReadyWallMs spatialBuildSynchronousCount liveBoundsTypedBytes liveBoundsPendingBlocks liveBoundsScannedPrimitives liveBoundsCaptureTypedBytes liveBoundsCapturePeakTypedBytes spatialFinePages spatialCoarsePages spatialIndexedPrimitives spatialReadyPages spatialPendingPages spatialPendingPrimitives spatialBuildTargetPrimitives spatialSplitLimitedLeaves colorDirtyStateBytes colorDirtyUniqueVertices coarseReferenceBytes coarseOwnedBytes fineOwnedBytes spatialEstimatedBytes liveBoundsMutationCpuMs liveBoundsMaintenanceCpuMs movedPrimitivesTested movedPrimitivesRejected movedBaseCandidatesSkipped spatialBuildProgress selectionScratchBytes colorPlannerScratchBytes pages pageCapacity mode adaptive zoom heading pointSize pixelRatio contextLost received revision committedRevision frames sharedCanvas sharedContext').split()
STRING_DENY=re.compile(r'(?i)(?:[a-z]:[\\/]|\\\\|/Users/|/home/|[?&](?:ak|key|token|secret|access_token)=|https?://|authorization|bearer\s)')

def scalar(v):
 if v is None or isinstance(v,(bool,int)):return v
 if isinstance(v,float):return v if math.isfinite(v) else None
 if isinstance(v,str):return v if len(v)<=500 and not STRING_DENY.search(v) else None
 return None

def pick(o,fields):return {k:scalar(o.get(k)) for k in fields} if isinstance(o,dict) else {}

def table(rows,name):
 fields=F[name];out=[]
 for o in rows or []:
  row=[]
  for k in fields:
   v=o.get(k)
   if k=='center' and isinstance(v,list):v=[scalar(x) for x in v[:2]]
   elif k=='displayTraceIds' and isinstance(v,list):v=[scalar(x) for x in v]
   elif k=='stateCounts' and isinstance(v,dict):v={s:scalar(v.get(s)) for s in ['STATE_PRESENTED_ALL','STATE_PRESENTED_PARTIAL','STATE_DROPPED','STATE_NO_UPDATE_DESIRED'] if s in v}
   else:v=scalar(v)
   row.append(v)
  out.append(row)
 constants={}
 if len(out)>64:
  constant_indices=[i for i,k in enumerate(fields) if all(row[i]==out[0][i] for row in out)]
  constants={fields[i]:out[0][i] for i in constant_indices}
  keep=[i for i in range(len(fields)) if i not in constant_indices]
  fields=[fields[i] for i in keep];out=[[row[i] for i in keep] for row in out]
 dictionaries={}
 if len(out)>64:
  for i,k in enumerate(fields):
   if k not in {'window','phase','kind','thread','status','scope','gpuStatus','gpuUnavailableReason','engine','type','scheduledBy','attribution','gpuScope','coverage','visible','confirmation','layerId','layerType','renderPass','sourceId'}:continue
   values={row[i] for row in out if isinstance(row[i],str)}
   if not values or len(values)>256:continue
   pool=sorted(values);lookup={value:index for index,value in enumerate(pool)};dictionaries[k]=pool
   for row in out:
    if row[i] is not None:row[i]=lookup[row[i]]
 return {'columns':fields,'rows':out,'dictionaries':dictionaries,'constants':constants}

def expand(t):
 dictionaries=t.get('dictionaries',{})
 return [{**t.get('constants',{}),**{key:(dictionaries[key][value] if key in dictionaries and value is not None else value) for key,value in zip(t['columns'],row)}} for row in t['rows']]
def metrics(o):
 o=o or {};p=pick(o,METRIC);p['networkTiming']=pick(o.get('networkTiming'),NETWORK);p['transport']=pick(o.get('transport'),TRANSPORT)
 p['detector']=pick(o.get('detector'),'mode observations regions warmedRegions warmup'.split());return p

def receipt(o):
 p=pick(o,RECEIPT)
 if isinstance(o,dict) and isinstance(o.get('overlay'),dict):p['overlay']=pick(o['overlay'],'moved removed positionUpdates moves removals removalsOfMoved restorations reverts rejects'.split())
 return p

def hashfile(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for part in iter(lambda:f.read(4*1024*1024),b''):h.update(part)
 return h.hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf-8-sig'))
def identity(p,expected=None):
 sha=hashfile(p)
 if expected and sha!=expected:raise ValueError('Source SHA mismatch: '+p.name)
 return {'name':p.name,'sha256':sha,'bytes':p.stat().st_size,'expectedShaVerified':bool(expected)}
def finite(v):return isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
def dist(values):
 v=sorted(x for x in values if finite(x))
 def q(t):
  if not v:return None
  x=(len(v)-1)*t;a=math.floor(x);b=math.ceil(x);return v[a]+(v[b]-v[a])*(x-a)
 return {'n':len(v),'p50':q(.5),'p95':q(.95),'p99':q(.99),'mean':statistics.mean(v) if v else None,'min':v[0] if v else None,'max':v[-1] if v else None}
def union(intervals):
 iv=sorted((a,b) for a,b in intervals if finite(a) and finite(b) and b>=a)
 if not iv:return None
 a,b=iv[0];total=0
 for c,d in iv[1:]:
  if c<=b:b=max(b,d)
  else:total+=b-a;a,b=c,d
 return total+b-a

def compare(actual,expected,label,checks):
 for k in ['n','p50','p95','p99','mean','min','max']:
  a,b=actual.get(k),expected.get(k)
  ok=(a is None and b is None) or (finite(a) and finite(b) and abs(a-b)<=max(1e-7,abs(b)*1e-10))
  checks.append({'test':label+'.'+k,'passed':ok,'actual':a,'expected':b})
  if not ok:raise ValueError('Recomputed statistic differs: '+label+'.'+k)

def trace_data(p):
 if p is None:return None
 a=read(p);clock=a.get('clockAlignment',{});windows=[]
 for w in a.get('profileWindows',[]):
  out=pick(w,'name windowId startEpochMs endEpochMs durationMs startTraceTsUs endTraceTsUs clockAlignmentValid scoringEligible unavailableReason physicalPresentationFps'.split())
  pf=w.get('presentationFeedback',{});out['presentationFeedback']=pick(pf,'scope uniqueTimestampCount firstTraceTsUs lastTraceTsUs observedSpanMs physicalPresentationFps browserFeedbackCadenceHz scoringEligible'.split())
  out['presentationFeedback']['intervals']=pick(pf.get('intervals'),['n','minMs','p50Ms','p95Ms','p99Ms','maxMs'])
  windows.append(out)
 return {'source':identity(p),'traceIdentity':{'sha256':a.get('rawTraceSHA256') or a.get('traceSHA256'),'bytes':a.get('rawTraceBytes') or a.get('traceBytes')},
 'browserMode':scalar(a.get('browserMode')),'targetRendererPid':a.get('targetRendererPid'),'rendererBinding':scalar(a.get('rendererBinding')),
 'clockAlignment':{**pick(clock,'status traceClock mapping anchorOffsetMs anchorCount maxAnchorOffsetResidualMs unavailableReason systemClockWasNotUsed'.split()),'anchors':table(clock.get('anchors',[]),'anchor')},
 'browserPresentationPoints':table(a.get('presentationPoints',[]),'presentation'),'profileWindows':windows,'physicalPresentationFps':None,'physicalPresentationLatencyMs':None,
 'physicalUnavailableReason':scalar(a.get('physicalUnavailableReason')),'analyzerSHA256':a.get('analyzerSHA256')}

def bindings(r):
 out=[]
 for name,v in (r.get('bindings') or {}).items():
  if isinstance(v,dict):
   safe=pick(v,'sha256 bytes count seed'.split());safe['name']=scalar(pathlib.PurePosixPath(str(name).replace('\\','/')).name);out.append(safe)
 return out

def verify_map(t,published,expected,checks):
 p=published['profile'];frames=expand(p['frames']);windows=expand(p['windows']);marks=expand(published['phaseMarks']);derived={'windows':[]}
 start=next((m.get('epochMs') for m in marks if str(m.get('name','')).endswith('-load-real-basemap')),None)
 stream=next((w for w in windows if w['name']=='streaming'),{})
 derived['wholeMapAndBusinessReadyWallMs']=stream.get('endEpochMs')-start if finite(start) and finite(stream.get('endEpochMs')) else None
 for w in windows:
  if 'quality' in w['name'] or 'preflight' in w['name']:continue
  fs=[f for f in frames if finite(f.get('startEpochMs')) and w['startEpochMs']<=f['startEpochMs']<w['endEpochMs']]
  cpu=dist(f.get('renderCpuMs') if f.get('renderCpuMs') is not None else f.get('cpuMs') for f in fs)
  gpu=dist(f.get('gpuMs') for f in fs if not p.get('gpuTraceInvalid') and f.get('gpuStatus')=='measured')
  derived['windows'].append({'name':w['name'],'frameCount':len(fs),'renderCpuMs':cpu,'wholeMapGpuMs':gpu})
  if expected and 'windows' in expected:
   ew=next((e for e in expected['windows'] if e.get('name')==w['name']),None)
   if ew:compare(cpu,ew['renderCpuMs'],published['id']+'.'+w['name']+'.cpu',checks);compare(gpu,ew['wholeMapGpuMs'],published['id']+'.'+w['name']+'.gpu',checks)
  if expected and w['name']=='camera' and 'cameraCpuMs' in expected:compare(cpu,expected['cameraCpuMs'],published['id']+'.camera.cpu',checks);compare(gpu,expected['cameraGpuMs'],published['id']+'.camera.gpu',checks)
 if expected:
  scalar_expected=expected.get('wholeMapAndBusinessReadyWallMs',expected.get('metrics',{}).get('wholeMapAndBusinessReadyWallMs'))
  compare({'p50':derived['wholeMapAndBusinessReadyWallMs']},{'p50':scalar_expected},published['id']+'.ready',checks)
 if published['nativeCoalesce']:
  d=published['streamDrain'];ok=d.get('queuedOnly') is False and d.get('received')==published['count'] and d.get('nativeBusinessDraw') is True and (d.get('committedRevision') or 0)>=(d.get('revision') or 1) and (d.get('nativeBusinessDrawCalls') or 0)>0
  checks.append({'test':published['id']+'.final-native-render-proof','passed':ok})
  if not ok:raise ValueError('Coalesced draw proof missing')
 return derived

def map_trial(t,source,tr,expected,checks):
 pr=t.get('profile') or {};out=pick(t,'engine count rep seed runId minimal nativeCoalesce streamPolicy streamMode streamCommitPolicy streamCompletion initialBatchSize feedbackBatchSize actualMaxBatch createMapCpuMs basemapReadyMs adapterCreateMs streamMs firstConfirmedBusinessMs nativeRenderedCount passed'.split());out['id']=source['name'].removesuffix('.trial.json');out['source']=source
 out['viewport']=pick(t.get('viewport'),['width','height','dpr']);out['instrumentation']=scalar(t.get('instrumentation') if not isinstance(t.get('instrumentation'),dict) else t['instrumentation'].get('mode')) or ('minimal' if t.get('minimal') else 'full')
 out['streamMetrics']=metrics(t.get('streamMetrics'));out['batches']=table(t.get('batches',[]),'batch');out['batchWorkerMetrics']=[metrics(b.get('workerMetrics')) for b in t.get('batches',[])]
 out['workerSpans']=table(t.get('workerSpans',[]),'workerSpan');out['businessFrames']=table(t.get('businessFrames',[]),'businessFrame');out['poses']=table(t.get('poses',[]),'pose');out['phaseMarks']=table(t.get('phaseMarks',[]),'mark')
 out['updates']=[{**pick(u,['label','ids','wallMs']),'receipt':receipt(u.get('receipt'))} for u in t.get('updates',[])];out['streamDrain']=receipt(t.get('streamDrain'));out['firstConfirmedBusinessEvidence']=scalar(t.get('firstConfirmedBusinessEvidence'))
 out['verification']=pick(t.get('verification'),['checked','passed','source']);out['qualityWitnessCount']=len(t.get('witness',[]));out['graphics']=pick(t.get('graphics'),'renderer version sharedContext'.split());out['stats']=pick(t.get('stats'),STAT)
 out['profile']={**pick(pr,'schema instrumentation startedEpochMs clockOriginMs stopped clockBasis gpuTraceInvalid pendingGpuQueries pollCpuMs coverageComplete'.split()),'frames':table(pr.get('frames',[]),'frame'),'uploads':table([f.get('uploads',{}) for f in pr.get('frames',[])],'upload'),'spans':table(pr.get('spans',[]),'span'),'windows':table(pr.get('windows',[]),'window'),'rafCallbacks':table(pr.get('rafCallbacks',[]),'raf'),'longTasks':table(pr.get('longTasks',[]),'longtask'),'errorCount':len(pr.get('errors',[])),'capabilities':pick(pr.get('capabilities'),'nativeRenderHook styleUpdate sourceUpdate placement painterRender renderLayer tilePreparation sourceWorkerUpdate sourceLoadTile glUploadHooks gpuTimer gpuReason longTask longAnimationFrame'.split())}
 out['browserTrace']=tr;out['independentlyRecomputed']=verify_map(t,out,expected,checks);return out

def bwindow(w,origin,expected,checks,label):
 out=pick(w,'id stage startedMs endedMs expectBusiness'.split());out['startEpochMs']=origin+w['startedMs'];out['endEpochMs']=origin+w['endedMs'];out['frames']=table(w.get('frames',[]),'bframe');out['spans']=table(w.get('spans',[]),'bspan');out['workerEvents']=table(w.get('workerEvents',[]),'bworker');out['phaseMarks']=table(w.get('phaseMarks',[]),'mark');out['wholeMapGpuCoverage']=pick(w.get('wholeMapGpuCoverage'),COVERAGE)
 cadence=w.get('callbackCadence',{});out['callbackCadence']=pick(cadence,['uniqueRafTimestamps','callbacksPerSecond','scope']);out['callbackCadence']['intervalsMs']=[scalar(x) for x in cadence.get('intervalsMs',[])]
 fs=expand(out['frames']);cpu=dist(f.get('callbackCpuMs') for f in fs);gpu=dist(f.get('wholeMapGpuMs') for f in fs if f.get('coverageVerified') is True)
 if expected:compare(cpu,expected['sdkCallbackCpuMs'],label+'.cpu',checks);compare(gpu,expected['wholeMapSharedGlGpuMs'],label+'.gpu',checks)
 out['independentlyRecomputed']={'sdkCallbackCpuMs':cpu,'wholeMapSharedGlGpuMs':gpu,'callbackIntervalMs':dist(out['callbackCadence']['intervalsMs'])};return out

def baidu_trial(t,baseline,r,report_identity,tr,expected,checks):
 origin=r['observer']['timeOrigin'];run=t.get('originalRun',{});out=pick(t,'id variant repeat seed cold runId wholeMapGpuAvailable passed'.split());out['sourceReport']=report_identity;out['clockOriginMs']=origin;out['browserTrace']=tr
 out['terminal']={**pick(t.get('terminal'),'status shown staged confirmed acknowledged batches activeWorkers peakPending stagingRevision committedRevision glUploadSubmissionMs features totalVertices pointVertices cpuBytes gpuBytes uploadedBytes pendingGeometryPages contextLost mode'.split()),'stats':pick(t.get('terminal',{}).get('stats'),STAT)}
 out['metrics']=pick(run.get('metrics'),BIZMETRICS);out['protocol']=metrics(run.get('protocol'));out['countSamples']=table(run.get('countSamples',[]),'countSample');out['frameSamples']=table(run.get('frameSamples',[]),'frameSample');out['networkTiming']=pick(run.get('networkTiming'),NETWORK);out['renderScheduling']=pick(run.get('renderScheduling'),SCHEDULING)
 out['viewport']=pick(run.get('viewport'),['width','height','dpr']);out['canvas']=pick(run.get('canvas'),'width height cssWidth cssHeight'.split());out['graphics']=pick(run.get('graphics'),'available version vendor renderer unmaskedVendor unmaskedRenderer'.split());out['geometryDigests']={k:pick(t.get('digest',{}).get(k),'vertices positions colors ids'.split()) for k in ['points','lines','polygons']}
 out['windows']={key:bwindow(w,origin,expected.get('windows',{}).get(key) if expected else None,checks,t['id']+'.'+key) for key,w in [('baseline',baseline),('loading',t['loading']),('camera',t['camera'])]};out['physicalPresentationFps']=None;return out

def update_checks(out,expected,checks):
 fs=expand(out['businessFrames'])
 for op in expected.get('operations',[]):
  us=[u for u in out['updates'] if u['label']==op['label']];compare(dist(u['wallMs'] for u in us),op['wallDistributionMs'],out['id']+'.'+op['label']+'.update-wall',checks)
  actual=[]
  for u in us:
   rev=u['receipt'].get('revision');actual.append(any((f.get('revision') or -1)>=rev and f.get('nativeBusinessDraw') is True and (f.get('instances') or 0)>0 for f in fs) if finite(rev) else False)
  wanted=[x.get('actualNativeDrawEvidence') for x in op.get('operationReceipts',[])]
  checks.append({'test':out['id']+'.'+op['label']+'.draw-revision-evidence','passed':actual==wanted,'actual':actual,'expected':wanted})
  if actual!=wanted:raise ValueError('Update actual draw proof differs')

def run(source,out):
 out.mkdir(parents=True,exist_ok=True);script=pathlib.Path(__file__);extractor=identity(script);checks=[];files=[];source_files=[]
 primary_path=source/'formal-realmap1/analysis-primary1/data.json';matched_path=source/'analysis-matched1/data.json';update_path=source/'analysis-update-matched1/data.json';baidu_path=source/'baidu-production-complete1/analysis-final1/data.json'
 primary=read(primary_path);matched=read(matched_path);updates=read(update_path);baidu=read(baidu_path)
 expected={('formal-realmap1',t['engine'],t['count'],t['rep']):t for t in primary['trials']}
 labels={'matched-policy1':'matched-full','minimal-policy1':'matched-minimal','native-coalesced1':'native-coalesced'}
 for group,label in labels.items():
  for t in matched['trials']:
   if t['label']==label:expected[(group,t['engine'],t['count'],t['rep'])]=t
 for p in [primary_path,matched_path,update_path,baidu_path]:source_files.append(identity(p))
 report_expected={'formal-realmap1':primary.get('inputReportSHA256'),'baidu-production-complete1':baidu.get('input',{}).get('reportSha256')}
 for info in matched.get('identities',[]):
  group=next((g for g,label in labels.items() if info.get('label')==label),None)
  if group:report_expected[group]=info.get('sha256')
 for group,n in GROUPS.items():
  folder=source/group;rpath=folder/'report.json';r=read(rpath);rid=identity(rpath,report_expected.get(group));source_files.append({'group':group,**rid});path=out/(group+'.ndjson.gz');uncompressed_sha=hashlib.sha256();raw_bytes=0;counts=collections.Counter();done=0
  header={'record':'group','schema':SCHEMA,'group':group,'trialCount':n,'sourceReport':rid,'extractorSHA256':extractor['sha256'],'browserVersion':scalar(r.get('browserVersion')),'sourceBindings':bindings(r),'dataSourceIdentities':[pick(x,'sha256 bytes count seed written'.split()) for x in r.get('serverRuns',[])],'passed':r.get('passed'),'errorsCount':len(r.get('errors',[])),'requestsCount':len(r.get('requests',[])),'physicalPresentationFps':None}
  if group=='baidu-production-complete1':header['quality']={**pick(r,'sceneValid protocolPassed localSearchAttempts localSearchConstructorAttempts'.split()),'tileNetworkFinal':pick(r.get('tileNetworkFinal'),'requestedTileRequests responseHeaders finishedTileRequests failedTileRequests completedSuccessfulTileResponses inFlightTileRequests maxInFlightTileRequests quiet requiredQuietMs quietForMs'.split()),'requestFailureCount':len(r.get('requestFailures',[])),'baselineCount':len(r.get('baselines',[]))};header['resourceResponses']=[pick(x,'atEpochMs trial resourceType nativeTileCandidate endpoint status contentType contentLength'.split()) for x in r.get('responses',[])];header['configuration']=pick(r.get('configuration'),'count repeats cameraMs baselineMs deadlineMs headed dpr compression delay chunk nativeCamera noPOI defaultStyle styleOverride emptyOverlayHidden sceneGateDeadlineMs tileQuietMs'.split())
  with path.open('wb') as raw:
   with gzip.GzipFile(filename='',mode='wb',fileobj=raw,compresslevel=9,mtime=0) as zipped:
    def emit(record):
     nonlocal raw_bytes
     content=(json.dumps(record,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode('utf-8');uncompressed_sha.update(content);raw_bytes+=len(content);zipped.write(content)
    emit(header)
    for summary in r['trials']:
     check_begin=len(checks)
     if group=='baidu-production-complete1':
      t=summary;tid=t['id'];base=next(x for x in r['baselines'] if x['variant']==t['variant'] and x['repeat']==t['repeat']);tp=folder/'analysis-final1/trace-analyses'/(tid+'.json');tr=trace_data(tp);bt=next(x for x in baidu['trials'] if x['id']==tid);record=baidu_trial(t,base,r,rid,tr,bt,checks)
     else:
      p=folder/pathlib.Path(summary['trialFile']).name;t=read(p);sid=identity(p,summary.get('trialSha256'));source_files.append({'group':group,**sid});tid=p.name.removesuffix('.trial.json')
      tp=(folder/'analysis-primary1/trace-analyses'/(tid+'.json')) if group=='formal-realmap1' else (source/'analysis-matched1/trace-analyses'/(tid+'.json') if group=='native-coalesced1' else None)
      tr=trace_data(tp) if tp is not None and tp.exists() else None
      record=map_trial(t,sid,tr,expected.get((group,t['engine'],t['count'],t['rep'])),checks)
      if group in ['matched-policy1','native-coalesced1']:
       e=next((x for x in updates['trials'] if x['engine']==t['engine'] and x['rep']==t['rep'] and x['sourceLabel']==group),None)
       if e:update_checks(record,e,checks)
     trace=t.get('trace',{})
     if trace.get('file'):
      tracepath=folder/pathlib.Path(str(trace['file']).replace('\\','/')).name
      trace_id=identity(tracepath,trace.get('sha256'));source_files.append({'group':group,**trace_id});record['rawTraceIdentity']=trace_id
     for check in checks[check_begin:]:check['group']=group
     record['record']='trial';emit(record);done+=1
     pr=record.get('profile',{});counts['frames']+=len(pr.get('frames',{}).get('rows',[]));counts['spans']+=len(pr.get('spans',{}).get('rows',[]));counts['batches']+=len(record.get('batches',{}).get('rows',[]));counts['businessFrames']+=len(record.get('businessFrames',{}).get('rows',[]));counts['updates']+=len(record.get('updates',[]))
     for w in record.get('windows',{}).values() if isinstance(record.get('windows'),dict) else []:counts['frames']+=len(w['frames']['rows']);counts['spans']+=len(w['spans']['rows'])
     if record.get('browserTrace'):counts['browserPresentationPoints']+=len(record['browserTrace']['browserPresentationPoints']['rows'])
     print(group,tid,done,flush=True);del t,record
  if done!=n:raise ValueError('Unexpected trial coverage')
  files.append({'group':group,'file':path.name,'trialCount':done,'gzip':identity(path),'ndjsonSha256':uncompressed_sha.hexdigest(),'ndjsonBytes':raw_bytes,'counts':dict(counts)})
  print('GROUP DONE',group,'gzip bytes',path.stat().st_size,flush=True)
 manifest={'schema':SCHEMA,'coverage':{'publishedTrialCount':sum(f['trialCount'] for f in files),'expectedTrialCount':sum(GROUPS.values()),'groups':GROUPS,'allRequestedTrialsPublished':True,'excluded':'Earlier Baidu standard/diagnostic/smoke/preflight runs; no complete CDP/HAR or SDK/tile source bytes'},'extractor':extractor,'tableEncoding':'Categorical integer values index per-column dictionaries; constants apply to every row; null and numeric values preserved losslessly','allowlist':{'tables':F,'streamMetrics':METRIC,'networkTiming':NETWORK,'transport':TRANSPORT,'receipt':RECEIPT,'baiduBusinessMetrics':BIZMETRICS,'renderScheduling':SCHEDULING,'gpuCoverage':COVERAGE,'stats':STAT},'files':files,'sourceIdentities':source_files,'compressedBytes':sum(f['gzip']['bytes'] for f in files),'verification':{'checkCount':len(checks),'passed':all(x['passed'] for x in checks),'checksFile':'verification.json'},'physicalPresentationFps':None}
 (out/'verification.json').write_text(json.dumps({'schema':SCHEMA,'checks':checks,'passed':all(x['passed'] for x in checks)},ensure_ascii=False,indent=2)+'\n',encoding='utf-8');manifest['verification']['fileIdentity']=identity(out/'verification.json');(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print('COMPLETE',manifest['compressedBytes'],len(checks),flush=True)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();run(a.source,a.output)
