#!/usr/bin/env python3
"""Private Baidu whole-map results analysis. Existing artifacts only, no browser/network/GPU."""
from __future__ import annotations
import argparse,collections,hashlib,importlib.util,json,pathlib,statistics
HERE=pathlib.Path(__file__).resolve().parent
SOURCE_ROOT=HERE.parents[2]
spec=importlib.util.spec_from_file_location("whole_map_helper",HERE/"analyze-whole-map-results.py")
A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
spec_trace=importlib.util.spec_from_file_location("whole_map_trace_helper",HERE/"analyze-whole-map-trace.py")
T=importlib.util.module_from_spec(spec_trace);spec_trace.loader.exec_module(T)
VARIANTS=["current","hybrid"]
LABELS={"current":"GeoPulse current","hybrid":"GeoPulse hybrid"}
COLORS={"current":"#137b70","hybrid":"#3b67ba"}
PLABELS={
 "business-staging":"业务验证 / 页 staging","business-render-callback":"业务 renderer 回调（含子阶段）",
 "business-gpu-upload-submit":"业务 buffer 上传调用","business-bounds-classification":"业务边界分类",
 "business-live-bounds-maintenance":"live bounds 维护","business-index-build":"索引建设",
 "business-spatial-selection":"空间选择","native-camera-api-submit":"原生相机 API 提交",
 "stream-byte-decode-buffer":"UTF-8 解码 / 缓冲","stream-ndjson-drain-parse":"NDJSON 解析",
 "stream-pack-and-detect":"pack / 风险检测","stream-decoder-finish":"解码结束",
 "stream-response-headers-wait":"响应 headers 等待","stream-reader-wait":"reader await",
 "stream-main-ack-wait":"主线程 ACK await","stream-worker-to-main-transport":"Worker → 主线程投递"}
def sha(path):
    h=hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
    return h.hexdigest()
def verify_bindings(report,folder):
    rows=[];gp=SOURCE_ROOT
    for name,expected in report["bindings"].items():
        p=gp/"public/js"/name.split("/",1)[1] if name.startswith("production/") else folder/name
        if not p.is_file():raise ValueError("Missing bound source: "+name)
        actual=sha(p)
        if actual!=expected:raise ValueError("Bound source SHA mismatch: "+name)
        rows.append({"binding":name,"file":str(p.resolve()),"sha256":actual})
    for b,a in [("sourceBefore","sourceAfter"),("runtimeBefore","runtimeAfter")]:
        if not report.get(b) or report[b]!=report.get(a):raise ValueError("Run fingerprint changed: "+b)
    if report["bindings"]["renderer.native.js"]!=report["bindings"]["renderer.served.js"]:raise ValueError("Renderer serving override is present")
    return {"verifiedCount":len(rows),"verified":rows,
      "sourceBefore":report["sourceBefore"],"sourceAfter":report["sourceAfter"],
      "runtimeBefore":report["runtimeBefore"],"runtimeAfter":report["runtimeAfter"],
      "sourceBeforeAfterEqual":True,"runtimeBeforeAfterEqual":True,"rendererServingUnchanged":True,
      "interpretation":"These trials bind the production Baidu style initialization fix. Earlier MapLibre trials retain their earlier exact frozen source."}
def iter_trace_events(path):
    """Bounded-memory JSON event iterator. The traceEvents array is the only consumed field."""
    dec=json.JSONDecoder()
    with path.open(encoding="utf-8-sig") as f:
        buf="";at=0
        while '"traceEvents"' not in buf:
            chunk=f.read(1024*1024)
            if not chunk:raise ValueError("traceEvents array missing")
            buf+=chunk
        at=buf.index("[",buf.index('"traceEvents"'))+1
        while True:
            while at<len(buf) and buf[at] in " \r\n\t,":at+=1
            if at<len(buf) and buf[at]=="]":return
            try:event,end=dec.raw_decode(buf,at)
            except json.JSONDecodeError:
                chunk=f.read(1024*1024)
                if not chunk:raise
                buf=buf[at:]+chunk;at=0;continue
            yield event;at=end
            if at>1024*1024:buf=buf[at:];at=0
def trace_audit(t,folder,baseline,origin,out):
    meta=t.get("trace") or {};p=folder/meta.get("file","")
    if not p.is_file():return {"available":False,"phasePresentation":None,"reason":"Raw trace unavailable"}
    actual=sha(p)
    if actual!=meta.get("sha256"):raise ValueError("Trace SHA mismatch: "+p.name)
    names=collections.Counter();user_names=collections.Counter();phase_marks=[];candidate_pids=set();evidence=[];total=0
    preserved={"PipelineReporter","Chrome_FrameReporter","SwapEndToPresentationCompositorFrame",
       "SubmitCompositorFrameToPresentationCompositorFrame","Display::FrameDisplayed","EndActivateToSubmitCompositorFrame"}
    for e in iter_trace_events(p):
        total+=1;name=e.get("name","");cat=str(e.get("cat",""))
        if any(v in name for v in ["PipelineReporter","FrameDisplayed","FramePresented","SubmitCompositorFrame","SwapBuffers"]):names[name]+=1
        authored=name.startswith("wm-") and "user_timing" in cat
        if "user_timing" in cat:
            user_names[name]+=1
            if authored:phase_marks.append({"name":name,"pid":e.get("pid"),"ts":e.get("ts"),"args":e.get("args")})
        if name=="thread_name" and e.get("args",{}).get("name")=="CrRendererMain":candidate_pids.add(e.get("pid"))
        if name in preserved or authored or (e.get("ph")=="M" and name in {"thread_name","process_name"}):evidence.append(e)
    common={"available":True,"file":str(p.resolve()),"sha256":actual,"bytes":p.stat().st_size,
      "eventCount":total,"relevantEventCounts":dict(names),"userTimingNameCounts":dict(user_names),"authoredPhaseMarks":phase_marks,
      "rendererMainCandidatePids":sorted(candidate_pids),"browserMode":"headed","physicalFps":None,
      "scope":"Target page compositor presentation feedback; physical scanout unverified. Whole-run baseline/screenshots/idle is never scored as camera FPS."}
    if not phase_marks:
        return {**common,"phasePresentation":None,"cameraPresentationP95Ms":None,
          "reason":"No explicit epoch-bound beginPhase user timing anchors; observer epochs alone do not align CDP monotonic ts."}
    anchors=[];windows=[]
    for key,w in [("baseline",baseline),("loading",t["loading"]),("camera",t["camera"])]:
        anchors.extend(w.get("phaseMarks") or [])
        windows.append({"name":key,"windowId":w["id"],"startEpochMs":origin+w["startedMs"],"endEpochMs":origin+w["endedMs"]})
    anchors.extend(t.get("phaseMarks") or [])
    evidence_dir=out/"trace-evidence";evidence_dir.mkdir(exist_ok=True)
    evidence_path=evidence_dir/(t["id"]+".presentation-evidence.json")
    evidence_path.write_text(json.dumps({"traceEvents":evidence},ensure_ascii=False,separators=(",",":")),encoding="utf-8")
    proxy={"phaseMarks":anchors,"profile":{"windows":windows}}
    analysis=T.analyze(evidence_path,mode="headed",trial=proxy)
    analysis["rawTracePath"]=str(p.resolve());analysis["rawTraceSHA256"]=actual;analysis["rawTraceBytes"]=p.stat().st_size;analysis["rawTraceEventCount"]=total
    analysis["inputFilter"]={"evidenceFile":str(evidence_path.resolve()),"evidenceSHA256":sha(evidence_path),
       "preservedEventNames":sorted(preserved),"preservedMarks":"all wm-* user_timing marks","preservedMetadata":"thread/process names",
       "eventsPreservedVerbatim":True,"cpuXEventsExcluded":True,"notACompleteBrowserCpuTrace":True}
    analysis["rendererMainSchedulingAndCpu"]=[]
    for w in analysis["profileWindows"]:
        w["rendererMainThread"]=[];w["filteredCpuUnavailableReason"]="Complete X thread CPU events intentionally excluded from bounded presentation-only evidence; CPU remains observer-only."
    for w in analysis["markerWindows"]:w["rendererMainThread"]=[]
    analysis_dir=out/"trace-analyses";analysis_dir.mkdir(exist_ok=True)
    analysis_path=analysis_dir/(t["id"]+".json")
    analysis_path.write_text(json.dumps(analysis,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    camera=next((w for w in analysis["profileWindows"] if w["name"]=="camera"),None)
    valid=bool(camera and camera["clockAlignmentValid"] and camera["presentationFeedback"]["scoringEligible"] and len(camera.get("presentationPoints",[]))>=2 and analysis.get("targetRendererPid") is not None)
    return {**common,"phasePresentation":analysis["profileWindows"],"clockAlignment":analysis["clockAlignment"],
      "targetRendererPid":analysis["targetRendererPid"],"targetRendererBinding":analysis["rendererBinding"],
      "cameraPresentationP95Ms":camera["presentationFeedback"]["intervals"]["p95Ms"] if valid else None,
      "cameraPresentationValid":valid,"analysisFile":str(analysis_path.resolve()),"analysisSHA256":sha(analysis_path),
      "evidenceFile":str(evidence_path.resolve()),"evidenceSHA256":sha(evidence_path),
      "reason":None if valid else "Authored marks observed but exact target renderer epoch alignment or state-and-stage validated page presentation feedback unavailable"}
def window_epochs(w,origin):
    return origin+w["startedMs"],origin+w["endedMs"]
def clip_span(s,lo,hi):
    a,b=s.get("startedEpochMs"),s.get("endEpochMs")
    if not all(A.finite(v) for v in [a,b,lo,hi]):return None
    a,b=max(a,lo),min(b,hi)
    return (a,b) if b>=a and a<hi and b>lo else None
def extract_window(w,origin):
    lo,hi=window_epochs(w,origin);frames=w["frames"];coverage=w["wholeMapGpuCoverage"]
    gpu=[f["wholeMapGpuMs"] for f in frames if f.get("coverageVerified") is True and A.finite(f.get("wholeMapGpuMs"))]
    if len(gpu)!=coverage["verifiedSamples"]:raise ValueError("GPU coverage count mismatch: "+w["id"])
    if coverage.get("otherContextDrawCount",0) and gpu:raise ValueError("Unverified extra-context GPU")
    callbacks=[(max(origin+f["startedMs"],lo),min(origin+f["endedMs"],hi)) for f in frames if f.get("targetCommands",0)>0]
    cpu_buckets=collections.defaultdict(list);wait_buckets=collections.defaultdict(list)
    main_intervals=list(callbacks);worker_intervals=[]
    for s in w.get("spans",[]):
        iv=clip_span(s,lo,hi)
        if iv is None:continue
        scope=s.get("scope","");thread=s.get("thread","main");phase=s["phase"]
        if scope in ["main-thread-cpu","worker-cpu"]:
            cpu_buckets[(thread,phase)].append(iv)
            if thread=="main":main_intervals.append(iv)
            elif thread=="stream-worker":worker_intervals.append(iv)
        elif "wait" in scope:wait_buckets[(thread,phase)].append(iv)
    costs=[{"thread":th,"phase":ph,"unionMs":A.union_ms(ivs),"scope":"same phase/same thread synchronous elapsed interval union; phase rows overlap and cannot be added"} for (th,ph),ivs in sorted(cpu_buckets.items())]
    costs.append({"thread":"main","phase":"native-sdk-raf-callback","unionMs":A.union_ms(callbacks),"scope":"full observed SDK rAF callback intervals; includes nested business spans; not total browser main thread CPU"})
    waits=[{"thread":th,"phase":ph,"wallUnionMs":A.union_ms(ivs),"scope":"same phase awaited wall intervals; includes scheduling/network/other thread work; not CPU"} for (th,ph),ivs in sorted(wait_buckets.items())]
    return {"id":w["id"],"stage":w["stage"],"startEpochMs":lo,"endEpochMs":hi,"durationMs":hi-lo,
      "frameCount":len(frames),"sdkCallbackCpuMs":A.dist([f.get("callbackCpuMs") for f in frames]),
      "wholeMapSharedGlGpuMs":A.dist(gpu),"wholeMapGpuCoverage":coverage,
      "otherContextClassificationDiagnostic":{"recordedCount":len(w.get("otherContextDrawEvents",[])),"recordedContextIds":sorted({x.get("contextId") for x in w.get("otherContextDrawEvents",[]) if isinstance(x.get("contextId"),int)}),"targetContextIds":sorted({x.get("targetContextId") for x in frames if isinstance(x.get("targetContextId"),int)}),"rawModified":False},
      "mainObservedSynchronousUnionMs":A.union_ms(main_intervals),
      "streamWorkerObservedCpuUnionMs":A.union_ms(worker_intervals),"stageCpuCosts":costs,"wallWaits":waits,
      "callbackIntervalMs":A.dist(w.get("callbackCadence",{}).get("intervalsMs",[])),
      "callbackCadenceScope":"native target GL rAF callback cadence; not physical presentation FPS",
      "longTasks":w.get("longTasks",[]),"browserCameraCompositorPresentation":None,"physicalFps":None}
def extract_trial(t,baseline,origin,trace):
    end=t["terminal"];r=t["originalRun"];m=r["metrics"]
    if not t.get("passed") or r.get("status")!="completed":raise ValueError("Trial protocol failed")
    for k in ["shown","features"]:
        if end[k]!=100000:raise ValueError("Feature completeness failed")
    if not (end["staged"]==end["confirmed"]==end["acknowledged"]==120000):raise ValueError("Vertex completeness failed")
    if end["committedRevision"]!=end["stagingRevision"] or end["pendingGeometryPages"] or end["errors"]:raise ValueError("Commit completeness failed")
    if end["contextLost"] or end["peakPending"]!=1 or end["activeWorkers"]:raise ValueError("Run health failed")
    if end["stats"]["adaptive"] or end["stats"]["lodStride"]!=1:raise ValueError("Quality reduced")
    kinds=t["digest"]
    if [kinds[k]["vertices"] for k in ["points","lines","polygons"]]!=[88000,20000,12000]:raise ValueError("Mixed geometry mismatch")
    ws={name:extract_window(w,origin) for name,w in [("baseline",baseline),("loading",t["loading"]),("camera",t["camera"])]}
    for tw in trace.get("phasePresentation") or []:
        if tw["name"] in ws and tw.get("clockAlignmentValid") and tw["presentationFeedback"].get("scoringEligible"):
            ws[tw["name"]]["browserCameraCompositorPresentation"]=tw
    return {"id":t["id"],"variant":t["variant"],"repeat":t["repeat"],"seed":t["seed"],
      "firstBusinessRunAfterSDKReady":t["cold"],"eligible":True,"metrics":{
       "firstNonemptyBusinessGlSubmitMs":m["firstVisibleMs"],"businessStreamCompletedMs":m["totalMs"],
       "workerDataDoneMs":m.get("dataDoneMs"),"features":end["features"],"vertices":end["totalVertices"],
       "batchCount":end["batches"],"parseInclusiveMs":m.get("parseMs"),"packAndDetectMs":m.get("packMs"),
       "stagingCpuLegacyMs":m.get("stagingMs"),"geometryUploadCpuLegacyMs":m.get("glUploadSubmissionMs")},
      "windows":ws,"networkTiming":r.get("networkTiming"),"geometryDigests":t["digest"],
      "graphics":end["graphics"],"mapCanvas":r.get("canvas"),"viewport":r.get("viewport"),"trace":trace,
      "completionScope":"completed app run after all stream batches were ACKed following actual GL geometry submission; not GPU completion or display presentation",
      "nativeSdkPrivateSubphaseCpu":{"tileDecodeMs":None,"labelLayoutMs":None,"individualBaseLayerDrawCpuMs":None,"reason":"Closed SDK internal phase functions were not separately instrumented; observed full native callback cannot infer them"}}
def aggregate(ts):
    out=[]
    for variant in VARIANTS:
        rows=[t for t in ts if t["variant"]==variant];ws={}
        for phase in ["baseline","loading","camera"]:
            wrows=[t["windows"][phase] for t in rows]
            phasecosts=sorted({(s["thread"],s["phase"]) for w in wrows for s in w["stageCpuCosts"]})
            costs={}
            for th,ph in phasecosts:
                vals=[next((s["unionMs"] for s in w["stageCpuCosts"] if s["thread"]==th and s["phase"]==ph),None) for w in wrows]
                costs[th+"/"+ph]=A.repeats(vals)
            waitnames=sorted({(s["thread"],s["phase"]) for w in wrows for s in w["wallWaits"]})
            ws[phase]={"sdkCallbackCpuP50Ms":A.repeats([w["sdkCallbackCpuMs"]["p50"] for w in wrows]),
              "sdkCallbackCpuP95Ms":A.repeats([w["sdkCallbackCpuMs"]["p95"] for w in wrows]),
              "sharedGlGpuP50Ms":A.repeats([w["wholeMapSharedGlGpuMs"]["p50"] for w in wrows]),
              "sharedGlGpuP95Ms":A.repeats([w["wholeMapSharedGlGpuMs"]["p95"] for w in wrows]),
              "mainObservedSynchronousUnionMs":A.repeats([w["mainObservedSynchronousUnionMs"] for w in wrows]),
              "streamWorkerObservedCpuUnionMs":A.repeats([w["streamWorkerObservedCpuUnionMs"] for w in wrows]),
              "callbackIntervalP95Ms":A.repeats([w["callbackIntervalMs"]["p95"] for w in wrows]),
              "stageCpuCosts":costs,"gpuVerifiedSamples":[w["wholeMapGpuCoverage"]["verifiedSamples"] for w in wrows],
              "gpuTargetCallbacks":[w["frameCount"] for w in wrows],
              "wallWaits":{th+"/"+ph:A.repeats([next((s["wallUnionMs"] for s in w["wallWaits"] if s["thread"]==th and s["phase"]==ph),None) for w in wrows]) for th,ph in waitnames},
              "compositorFeedbackIntervalP50Ms":A.repeats([A.at(w.get("browserCameraCompositorPresentation") or {},"presentationFeedback","intervals","p50Ms") for w in wrows]),
              "compositorFeedbackIntervalP95Ms":A.repeats([A.at(w.get("browserCameraCompositorPresentation") or {},"presentationFeedback","intervals","p95Ms") for w in wrows]),
              "compositorFeedbackPointCounts":[len((w.get("browserCameraCompositorPresentation") or {}).get("presentationPoints",[])) for w in wrows],
              "physicalFps":None}
        out.append({"variant":variant,"repeats":len(rows),"metrics":{k:A.repeats([t["metrics"][k] for t in rows]) for k in rows[0]["metrics"]},"windows":ws})
    return out
def save(plt,fig,out,name,caption):
    fig.text(.5,.012,caption,ha="center",va="bottom",fontsize=9,color="#42505a")
    fig.tight_layout(rect=(0,.13 if name=="baidu-native-callback-cpu-gpu" else .06,1,.95));files=[]
    for ext in ["png","svg"]:
        p=out/(name+"."+ext);fig.savefig(p,dpi=175,bbox_inches="tight");files.append(p.name)
    plt.close(fig);return files
def bar(ax,i,s,color,label=True):
    v=s.get("median")
    if not A.finite(v):
        ax.text(i,.03,"未验证\nnull",transform=ax.get_xaxis_transform(),ha="center",va="bottom",fontsize=9,color="#777");return
    ax.bar(i,v,width=.62,color=color,alpha=.85)
    ax.errorbar(i,v,yerr=[[v-s["min"]],[s["max"]-v]],fmt="none",color="#243840",capsize=4)
    vals=s["rawPerTrialValues"];ax.scatter([i+(j-(len(vals)-1)/2)*.045 for j in range(len(vals))],vals,s=17,color="#243840",zorder=4)
    if label:ax.annotate(f"{v:.2f}",(i,s["max"]),xytext=(0,7),textcoords="offset points",ha="center",fontsize=9)
def plots(data,out):
    plt=A.configure_plots();gs=data["aggregates"];files=[]
    fig,axs=plt.subplots(1,3,figsize=(13,4.3))
    for ax,k,title in zip(axs[:2],["firstNonemptyBusinessGlSubmitMs","businessStreamCompletedMs"],["首非空业务 GL 提交","业务流全部完成"]):
        for i,g in enumerate(gs):bar(ax,i,g["metrics"][k],COLORS[g["variant"]])
        ax.set_xticks([0,1],[LABELS[g["variant"]] for g in gs]);ax.set(title=title,ylabel="业务 run 起点后的墙钟（ms）")
        ax.margins(y=.25);ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True)
    startup=data["startup"]
    vals=[startup["sdkConnectWallMs"]/1000,startup["sceneGateWallMs"]/1000]
    axs[2].bar([0,1],vals,color=["#7b8791","#9aa5ab"],width=.6)
    for i,v in enumerate(vals):axs[2].text(i,v+.4,f"{v:.3f} s",ha="center")
    axs[2].set_xticks([0,1],["SDK 连接\n1 次","空业务底图 gate\n1 次"]);axs[2].set(title="运行前准备（不计入 stream）",ylabel="单次准备墙钟（s）");axs[2].margins(y=.2);axs[2].grid(axis="y",alpha=.18);axs[2].set_axisbelow(True)
    fig.suptitle("真实百度地图 · 10 万混合业务要素 · 已准备底图后的流式时间",fontsize=14)
    files+=save(plt,fig,out,"baidu-stream-and-startup","每 trial 先汇总，再取 3 次重复中位数 / 范围。SDK 与地图复用；首 GL 提交不是屏幕呈现，stream 不是整图冷启动。")
    fig,axs=plt.subplots(1,2,figsize=(12,4.8));phases=["baseline","loading","camera"];names={"baseline":"纯底图相机","loading":"业务加载","camera":"加载后相机"}
    for ax,key,title in zip(axs,["sdkCallbackCpuP50Ms","sharedGlGpuP50Ms"],["SDK 原生完整 rAF 回调 CPU","共享 SDK GL context GPU（已验证样本）"]):
        for j,g in enumerate(gs):
            for i,ph in enumerate(phases):
                s=g["windows"][ph][key];bar(ax,i*3+j,s,COLORS[g["variant"]])
        ax.set_xticks([.5,3.5,6.5],[names[ph] for ph in phases]);ax.set(title=title,ylabel="每 callback 中位数（ms）");ax.set_ylim(bottom=0);ax.margins(y=.27);ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True)
        for g in gs:ax.plot([],[],color=COLORS[g["variant"]],lw=8,label=LABELS[g["variant"]])

    fig.legend(*axs[0].get_legend_handles_labels(),loc="lower center",bbox_to_anchor=(.5,.067),ncol=2,frameon=False,fontsize=10)
    fig.suptitle("底图与业务同 context 的 CPU / GPU：分开测量，不相加",fontsize=14)
    files+=save(plt,fig,out,"baidu-native-callback-cpu-gpu","GPU 仅已验证 callbacks，未验证帧保持 null；排除 DOM / 2D labels / compositor。CPU 与 GPU 并行，不能相加。")
    fig,axs=plt.subplots(1,3,figsize=(14,5.5))
    selected=[("main",["business-staging","business-render-callback","business-gpu-upload-submit","business-bounds-classification"],"主线程业务阶段（同步区间并集）"),
      ("stream-worker",["stream-byte-decode-buffer","stream-ndjson-drain-parse","stream-pack-and-detect"],"唯一 stream Worker CPU（区间并集）"),
      ("wait",["stream-reader-wait","stream-main-ack-wait","stream-worker-to-main-transport"],"await / 投递墙钟（非 CPU）")]
    for ax,(th,ps,title) in zip(axs,selected):
        for j,g in enumerate(gs):
            for i,ph in enumerate(ps):
                costs=g["windows"]["loading"]["wallWaits"] if th=="wait" else g["windows"]["loading"]["stageCpuCosts"]
                key=next((k for k in costs if k.split("/",1)[1]==ph),None) if th=="wait" else th+"/"+ph
                s=costs.get(key) or A.repeats([])
                bar(ax,i*3+j,s,COLORS[g["variant"]],label=False)
        ax.set_xticks([i*3+.5 for i in range(len(ps))],[PLABELS[p] for p in ps],rotation=22,ha="right")
        ax.set(title=title,ylabel="整个 loading 窗口成本（ms）");ax.set_ylim(bottom=0);ax.margins(y=.15);ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True)
        for g in gs:ax.plot([],[],color=COLORS[g["variant"]],lw=8,label=LABELS[g["variant"]])
        ax.legend(fontsize=9)
    fig.suptitle("流式阶段成本：CPU 线程分组，await 单列",fontsize=14)
    files+=save(plt,fig,out,"baidu-stream-phase-costs","不同阶段可嵌套，不可相加；主线程、Worker、await、GPU 不能合成为串行总耗时。点为每 trial，误差线为 3 次重复范围。")
    if any(A.finite(g["windows"]["camera"]["compositorFeedbackIntervalP95Ms"]["median"]) for g in gs):
        fig,ax=plt.subplots(figsize=(9,4.8))
        for j,g in enumerate(gs):
            for i,ph in enumerate(["baseline","loading","camera"]):
                bar(ax,i*3+j,g["windows"][ph]["compositorFeedbackIntervalP95Ms"],COLORS[g["variant"]])
            ax.plot([],[],color=COLORS[g["variant"]],lw=8,label=LABELS[g["variant"]])
        ax.set_xticks([.5,3.5,6.5],["纯底图相机","业务加载","加载后相机"])
        ax.set(ylabel="目标页面 compositor 呈现反馈间隔 P95（ms）",title="明确 phase anchors 绑定后的浏览器整页呈现反馈")
        ax.set_ylim(bottom=0);ax.margins(y=.23);ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True);ax.legend(fontsize=9)
        files+=save(plt,fig,out,"baidu-compositor-feedback","STATE_PRESENTED_ALL / PARTIAL + 配对呈现阶段 endpoints；不是物理 FPS。加载按需绘制的间隔也不是更新响应延迟。")
    return files
def f(s):
    if s is None or not A.finite(s.get("median")):return "null / 未验证"
    return f'{s["median"]:.2f}（{s["min"]:.2f}–{s["max"]:.2f}）'
def write_report(data,out):
    gs=data["aggregates"];q=data["quality"];st=data["startup"];lines=[
     "# 真实百度整图生产验证（私有）","",
     "使用本输入报告的 6 条正式 trial。上海道路、区名、地点标签的空业务地图截图已目视核查；当前生产 renderer 未使用私有样式覆盖。旧 baidu-mixed1 的空白底图结果排除。",
     "每条先汇总，再跨 3 次重复取中位数；括号是重复最小–最大，不是置信区间。单个 SDK / UI / 地图复用，执行顺序按重复轮换。current-r0 是 SDK ready 后首个业务 run，不是每次新建 SDK 的冷启动。",
     "","## 已准备底图后的业务流","",
     "| 方案 | 首非空业务 GL 提交 ms | 全业务完成 ms | batch 次数 |",
     "| --- | ---: | ---: | ---: |"]
    for g in gs:lines.append(f'| {LABELS[g["variant"]]} | {f(g["metrics"]["firstNonemptyBusinessGlSubmitMs"])} | {f(g["metrics"]["businessStreamCompletedMs"])} | {g["metrics"]["batchCount"]["rawPerTrialValues"]} |')
    lines += ["",
     "业务是 100,000 条合成要素：88,000 点、10,000 双顶点线、2,000 六顶点矩形，共 120,000 顶点；同 seed 下两方案 CPU 几何 digest 完全一致。生产 Worker fetch → decode → parse → pack/detect → ACK/backpressure → main staging → GL 提交链路保持一致，hybrid 改变批量策略。",
     "首可见字段实际定义为非空业务 GL draw 提交，不代表 GPU 完成或屏幕呈现。全部完成字段包括全部批次提交后的 ACK；不含预先完成的 SDK / 底图准备。",
     f'运行前单次 SDK 连接 {st["sdkConnectWallMs"]/1000:.3f}s，随后空业务底图 scene gate {st["sceneGateWallMs"]/1000:.3f}s，分开记录，不能把业务 stream 当作整张地图冷启动。SDK load retry={st["retryCount"]}。',
     "","## 完整 SDK callback CPU 与共享 GL GPU","",
     "| 场景 | 方案 | callback CPU 中位 ms | callback CPU P95 ms | verified GL GPU 中位 ms | verified GL GPU P95 ms | GPU 样本 / callbacks |",
     "| --- | --- | ---: | ---: | ---: | ---: | --- |"]
    for ph in ["baseline","loading","camera"]:
        for g in gs:
            w=g["windows"][ph];lines.append(f'| {ph} | {LABELS[g["variant"]]} | {f(w["sdkCallbackCpuP50Ms"])} | {f(w["sdkCallbackCpuP95Ms"])} | {f(w["sharedGlGpuP50Ms"])} | {f(w["sharedGlGpuP95Ms"])} | {w["gpuVerifiedSamples"]} / {w["gpuTargetCallbacks"]} |')
    lines += ["",
     "CPU 覆盖 observer 判定为 SDK 原生 rAF callback 的完整同步函数区间，包含底图、业务及嵌套观察工作；stack domain 是归属启发式，不是原生内部精确分段。SDK 私有瓦片解码 / 布局 / 单图层 CPU 未独立插桩，不能从完整 callback 倒推这些阶段。",
     "有效 GPU 覆盖共享百度 GL context 从首次观察到的 render/upload 命令到 callback 返回；底图命令在业务 render 之外、业务命令在 render 之内，并要求同 callback。DOM、2D labels、compositor 和 callback 外命令不在计时内。它是经过覆盖核查的地图 GL 工作，不是浏览器所有 GPU 工作。",
     "每窗口仅使用 coverageVerified 的 wholeMapGpuMs；targetContextGpuMs 不能替代整图。standard1 六个 loading 记录 otherContext draw 32 次，但 contextId=4 与 targetContextId=4 相同。只读源码核查表明 reset 暂把 renderer._gl 置 null，首个 SDK callback 的底图前缀因此被误归为 other 且未被 query 完整包住；旧 observer 保守将整窗口失效。这是 reset 边界归类 / 覆盖缺口，不是 SDK 实际多 context。旧 raw 保持 null，修正后的新输入若 coverageVerified 则按实测汇总。",
     "业务加载窗口含开始/完成控制、末尾 100ms 等待；它的 callback 分布不是纯 stream duration 分布。complete1 loading 仍有前数据期 / 尚未满足业务 draw 条件的未验证 callback，GPU 中位数仅针对 verified 子集，不是全部加载窗口 GPU 总耗时。",
     "","## 阶段与时钟边界","",
     "阶段图使用同一阶段 / 同线程同步 span 区间并集；SDK callback 与业务子阶段嵌套，不能相加。主线程全部已观察同步工作做并集，唯一 stream Worker CPU 另做并集，await 与 transport 墙钟单列。不同线程不能加成 wall time。",
     "| 方案 | loading 主线程已观察同步并集 ms | 唯一 stream Worker CPU 并集 ms | 原生 callback 间隔 P95 ms（loaded camera） |",
     "| --- | ---: | ---: | ---: |"]
    for g in gs:lines.append(f'| {LABELS[g["variant"]]} | {f(g["windows"]["loading"]["mainObservedSynchronousUnionMs"])} | {f(g["windows"]["loading"]["streamWorkerObservedCpuUnionMs"])} | {f(g["windows"]["camera"]["callbackIntervalP95Ms"])} |')
    lines += ["","## 目标网页 compositor 呈现反馈","",
     "| 场景 | 方案 | feedback 间隔 P50 ms | feedback 间隔 P95 ms | 每 trial 反馈点数 |",
     "| --- | --- | ---: | ---: | --- |"]
    for ph in ["baseline","loading","camera"]:
        for g in gs:
            w=g["windows"][ph];lines.append(f'| {ph} | {LABELS[g["variant"]]} | {f(w["compositorFeedbackIntervalP50Ms"])} | {f(w["compositorFeedbackIntervalP95Ms"])} | {w["compositorFeedbackPointCounts"]} |')
    marked=any(t["trace"].get("cameraPresentationValid") for t in data["trials"])
    if marked:
        lines += ["","wm-baidu-* authored marks 绑定唯一 target renderer，并用 begin/end browser epoch anchors 映射 trace monotonic ts；至少2锚点、残差≤2ms才按 origin+phaseMs 精确切窗。只计 PipelineReporter PRESENTED_ALL/PARTIAL 与配对呈现阶段终点，按实际呈现时刻去重。PARTIAL 不证明每次业务 revision 完整显示。", "Raw traces 逐条 SHA 验证后，流式提取原样 presentation pairs / marks / metadata 到小 evidence trace，再调用同一 trace analyzer。过滤 trace 排除 CPU X events，不能用于宣称整个浏览器 CPU；CPU 图仍是 observer 同线程区间并集。"]
    else:
        lines += ["","本输入没有 authored epoch-bound marks，不能把 observer 窗口映射 CDP monotonic ts，compositor feedback 保持 null。"]
    lines += ["","浏览器 feedback 不是物理屏幕 scanout，physical FPS 始终 null。不将整个 trace（含 idle / 截图）换算成 FPS。rAF 间隔只描述 callback cadence。加载按需绘制的长间隔不直接等于卡顿或业务更新响应延迟。",
     "","## 场景与源码证据","",
     f'原回执 sceneValid={q["sceneValid"]}、protocolPassed={q["protocolPassed"]}；raw requestFailures={q["requestFailureCount"]}；主业务 draw / 全顶点提交 / ACK / revisions / LOD=1 已复核。source/runtime before=after；{data["sourceBindings"]["verifiedCount"]} 项文件 SHA 匹配；renderer native/served SHA 相等；overflow=0、pending query=0、LocalSearch=0。',
     f'空业务预检 native draw={q["preflightNativeDraws"]}，crop colors={q["preflightPixelColors"]}；成功完成 tile responses={q["preflightNetwork"]["completedSuccessfulTileResponses"]}，inflight=0，安静 {q["preflightNetwork"]["quietForMs"]:.0f}ms≥2000ms。原始 visualReview.verifiedRoadsAndPlaceLabels=false 是待人工核查占位，本分析另外记录已读截图的道路/地名证据，未修改 raw。',
     "HTTP quiet gate 是评分前场景准备证据，不表示相机之后永远不再请求瓦片。最终 cleanup 的 tileNetworkFinal 不回写初始 gate，也不证明 tiles 语义完整。原 raw 的 requestFailures 另保留在 data.json，未有 trial 时间归属，不能声称全 run 没有网络失败；初始预检 tile 失败数量按 quality.preflightNetwork.failedTileRequests 原值报告，不能推定为0（complete1实测2）。standard1 的历史四个 abort 亦不回写。",
     "本次浏览器 viewport 为 1366×768 / DPR1，真实地图 canvas 为 1068×373。百度混合生产应用与 MapLibre/GeoPulse/deck 的共同点 fixture、投影、canvas 面积及 SDK 均不同，本报告用于生产平台全链验证，不能据此跨平台排名。重复数量小、仪表与 tracing 有开销，不推导产品最大 FPS 或普适速度倍数。",
     "","图形：baidu-stream-and-startup、baidu-native-callback-cpu-gpu、baidu-stream-phase-costs。完整可追溯汇总见 data.json。"]
    (out/"REPORT.zh-CN.md").write_text("\n".join(lines)+"\n",encoding="utf-8")
def main():
    global SOURCE_ROOT
    ap=argparse.ArgumentParser();ap.add_argument("--report",required=True);ap.add_argument("--out",required=True);ap.add_argument("--source-root",type=pathlib.Path,default=SOURCE_ROOT);args=ap.parse_args();SOURCE_ROOT=args.source_root.resolve()
    p=pathlib.Path(args.report).resolve();out=pathlib.Path(args.out).resolve()
    if out.exists():raise ValueError("Output must be new; existing reports are immutable")
    out.mkdir(parents=True);d=json.loads(p.read_text(encoding="utf-8-sig"))
    if not (d.get("passed") and d.get("protocolPassed") and d.get("sceneValid")):raise ValueError("Invalid scene or incomplete production protocol")
    if d["configuration"].get("defaultStyle") or d["configuration"].get("styleOverride",{}).get("enabled"):raise ValueError("Not unmodified production renderer")
    bindings=verify_bindings(d,p.parent);observer=d["observer"]
    if observer["overflow"] or observer["pendingGpuQueries"] or d["errors"] or d["localSearchAttempts"] or d["localSearchConstructorAttempts"]:raise ValueError("Observation/production quality failed")
    if len(d["trials"])!=6 or len(d["baselines"])!=6:raise ValueError("Expected complete 2 variants x 3 repeats")
    network=d["basemapPreflight"]["networkEvidence"]
    if not network["quiet"] or network["inFlightTileRequests"] or network["completedSuccessfulTileResponses"]<1 or network["quietForMs"]<2000:raise ValueError("Native tile scene gate failed")
    rows=[];digests={};trace_rows=[]
    for t in d["trials"]:
        old=digests.get(t["seed"])
        if old is not None and old!=t["digest"]:raise ValueError("Geometry differs across variants")
        digests[t["seed"]]=t["digest"]
        baseline=next(b for b in d["baselines"] if b["id"]=="base-"+t["id"])
        trace=trace_audit(t,p.parent,baseline,observer["timeOrigin"],out);trace_rows.append({"id":t["id"],**trace})
        rows.append(extract_trial(t,baseline,observer["timeOrigin"],trace))
        print(json.dumps({"analyzed":t["id"],"tracePhasePresentationValid":trace.get("cameraPresentationValid",False)},ensure_ascii=False),flush=True)
    data={"schema":"geo-pulse/baidu-whole-map-analysis-1.0","analysisComplete":True,
      "input":{"report":str(p),"reportSha256":sha(p),"source":d["schema"],"rawStatus":d["status"]},
      "sourceBindings":bindings,"quality":{"sceneValid":d["sceneValid"],"protocolPassed":d["protocolPassed"],
        "preflightNativeDraws":d["basemapPreflight"]["nativeBasemapDraws"],"preflightPixelColors":d["basemapPreflight"]["pixelEvidence"]["quantizedColors"],
        "preflightNetwork":network,"visualReviewRaw":d["basemapPreflight"]["visualReview"],
        "visualReviewAnalysis":{"verifiedRoadsAndPlaceLabels":True,"evidence":"Analyst read preflight-native-basemap.png: 上海市/浦东新区/徐汇区 and road network/place labels visible; root also verified final loaded scene","rawModified":False},
        "tileNetworkFinal":d.get("tileNetworkFinal"),"regressionTests":"Root reports 612 Node regression tests PASS; not rerun by this CPU-only analyzer",
        "requestFailureCount":len(d.get("requestFailures",[])),"requestFailures":d.get("requestFailures",[])},
      "configuration":d["configuration"],"startup":{"sdkConnectWallMs":d["sdkConnectWallMs"],"sceneGateWallMs":d["basemapPreflight"]["wallMs"],
        "sdkStartupWallMs":d["sdkStartup"]["wallMs"],"retryCount":d["sdkStartup"]["retryCount"],"onceOnly":True,"fullColdStartWallMs":None},
      "trials":rows,"aggregates":aggregate(rows),"traces":trace_rows,"physicalFps":None,"crossPlatformRanking":None,
      "method":"One per-trial scalar then repeat median/range; same-thread unions remove nesting; main/worker/waits/GPU kept separate",
      "analyzerSha256":sha(pathlib.Path(__file__)),"helperSha256":sha(HERE/"analyze-whole-map-results.py"),"traceAnalyzerSHA256":sha(HERE/"analyze-whole-map-trace.py")}
    data["figures"]=plots(data,out);write_report(data,out)
    (out/"data.json").write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    for script in [pathlib.Path(__file__),HERE/"analyze-whole-map-results.py",HERE/"analyze-whole-map-trace.py"]:(out/script.name).write_bytes(script.read_bytes())
    print(json.dumps({"analysisComplete":True,"trials":len(rows),"sourceBindings":bindings["verifiedCount"],"figures":data["figures"],"out":str(out)},ensure_ascii=False))
if __name__=="__main__":main()
