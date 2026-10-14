#!/usr/bin/env python3
"""Private whole-map analysis. Reads reports serially; no browser/network/source edits.
python analyze-whole-map-results.py --report results/formal-realmap1/report.json --out results/formal-realmap1/analysis
"""
from __future__ import annotations
import argparse, collections, hashlib, importlib.util, json, math, os, pathlib, statistics
HERE = pathlib.Path(__file__).resolve().parent
ENGINES = ["base","geopulse-current","geopulse-hybrid","deck","maplibre"]
LABELS = {"base":"纯底图参考","geopulse-current":"GeoPulse 当前","geopulse-hybrid":"GeoPulse hybrid","deck":"deck.gl","maplibre":"MapLibre source"}
COLORS = {"base":"#7c858e","geopulse-current":"#137b70","geopulse-hybrid":"#26a99e","deck":"#3b67ba","maplibre":"#bd7540"}
UPDATES = ["small-update","bulk-contiguous","bulk-scattered","continuous-updates"]
ULABELS = {"small-update":"2 点单次更新","bulk-contiguous":"连续 ID 批量","bulk-scattered":"分散 ID 批量","continuous-updates":"持续 2 点更新"}
PLABELS = {"map-style-update":"样式更新","map-source-update":"source 更新","map-placement":"标签布局","map-tile-prepare":"瓦片准备（含上传）",
"buffer-upload-submission":"buffer 上传调用","texture-upload-submission":"texture 上传调用","base-layer-render":"底图图层调用","business-layer-render":"业务图层调用",
"business-append-prepare":"append 准备","business-append-convert-geojson":"追加 → GeoJSON","business-geometry-prepare":"GP 几何准备",
"business-spatial-selection":"GP 空间选择","business-spatial-index-build":"GP 索引建设","stream-byte-decode-buffer":"UTF-8 解码 / 缓冲",
"stream-ndjson-drain-parse":"NDJSON 解析","stream-pack-and-detect":"pack / 检测","worker-tile-parse-sync-prefix":"瓦片 parse 同步前缀",
"worker-geojson-index-update":"GeoJSON index update","worker-geojson-tile-build":"GeoJSON tile build","worker-geojson-vector-encode":"GeoJSON vector encode"}
def finite(v): return isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
def quantile(values,q):
    v=sorted(x for x in values if finite(x))
    if not v:return None
    a=(len(v)-1)*q;lo,hi=math.floor(a),math.ceil(a)
    return v[lo]+(v[hi]-v[lo])*(a-lo)
def dist(values):
    v=[x for x in values if finite(x)]
    return {"n":len(v),"p50":quantile(v,.5),"p95":quantile(v,.95),"p99":quantile(v,.99),
            "min":min(v) if v else None,"max":max(v) if v else None,"mean":statistics.mean(v) if v else None}
def repeats(values):
    v=[x for x in values if finite(x)]
    return {"n":len(v),"median":statistics.median(v) if v else None,"min":min(v) if v else None,"max":max(v) if v else None,
            "rawPerTrialValues":v,"aggregation":"one scalar per trial; repeat median and full range"}
def union_ms(intervals):
    v=sorted((a,b) for a,b in intervals if finite(a) and finite(b) and b>=a)
    if not v:return None
    lo,hi=v[0];total=0.
    for a,b in v[1:]:
        if a<=hi:hi=max(hi,b)
        else:total+=hi-lo;lo,hi=a,b
    return total+hi-lo
def is_cpu(s):
    kind,scope=str(s.get("kind","")),str(s.get("scope",""))
    if s.get("status")!="measured" or "wall" in kind or "wall" in scope or "await" in scope:return False
    return kind in {"cpu","cpu-service"} or "cpu" in scope.lower()
def clip(s,w):
    a,b,lo,hi=s.get("startEpochMs"),s.get("endEpochMs"),w.get("startEpochMs"),w.get("endEpochMs")
    if not all(finite(x) for x in (a,b,lo,hi)):return None
    a,b=max(a,lo),min(b,hi)
    return (a,b) if b>=a and b>lo and a<hi else None
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def at(obj,*keys):
    for k in keys:
        if not isinstance(obj,dict):return None
        obj=obj.get(k)
    return obj if finite(obj) else None
def load_trial(s,root):
    if not s.get("trialFile"):return s,{"inline":True,"file":None,"sha256":None}
    p=(root/s["trialFile"]).resolve()
    if root.resolve() not in p.parents:raise ValueError("Trial path escapes report directory")
    actual=sha(p)
    if s.get("trialSha256") and actual!=s["trialSha256"]:raise ValueError("Trial SHA mismatch: "+p.name)
    return json.loads(p.read_text(encoding="utf-8-sig")),{"file":str(p),"sha256":actual}
def costs(p,w):
    buckets=collections.defaultdict(list)
    for s in p.get("spans",[]):
        interval=clip(s,w) if is_cpu(s) else None
        if interval is not None:buckets[(s.get("thread","main"),s.get("phase","unnamed"))].append((s,interval))
    rows=[]
    for (thread,phase),ss in sorted(buckets.items()):
        if thread=="native-map-worker":
            values=[s.get("durationMs") for s,_ in ss]
            rows.append({"thread":thread,"phase":phase,"metric":"per-call-synchronous-ms","value":quantile(values,.5),
              "callDistribution":dist(values),"partial":any(s.get("partial") for s,_ in ss),
              "scope":"per-trial median native Worker synchronous calls; partial prefixes where declared; no aggregate Worker CPU"})
        else:
            rows.append({"thread":thread,"phase":phase,"metric":"same-phase-interval-union-ms","value":union_ms([v for _,v in ss]),
              "calls":len(ss),"scope":"same-phase synchronous interval union; other phase rows overlap and cannot be added"})
    return rows
def prepare(t,trace=None):
    p=t.get("profile") or {};ws=p.get("windows",[]);by_name={w.get("name"):w for w in ws}
    instrumentation=t.get("instrumentation") or p.get("instrumentation") or "full"
    if isinstance(instrumentation,dict):instrumentation=instrumentation.get("mode","full")
    minimal=instrumentation=="minimal";reasons=[]
    if not t.get("passed"):reasons.append("trial-not-passed")
    if p.get("coverageComplete") is not True and not minimal:reasons.append("raw-profiler-coverage-incomplete")
    if p.get("errors"):reasons.append("profiler-errors")
    if t.get("verification",{}).get("passed") is False:reasons.append("quality-failed")
    if any(isinstance(s.get("sourceId"),(dict,list)) for s in p.get("spans",[]) if s.get("thread")=="native-map-worker"):
        reasons.append("known-invalid-object-sourceId-worker-telemetry")
    engine=t.get("engine")
    if engine!="base" and t.get("graphics",{}).get("sharedContext") is not True:reasons.append("whole-context-not-verified")
    mark=next((m for m in t.get("phaseMarks",[]) if str(m.get("name","")).endswith("-load-real-basemap")),None)
    start=mark.get("epochMs") if mark else None;stream_end=by_name.get("streaming",{}).get("endEpochMs");base_end=by_name.get("basemap-load",{}).get("endEpochMs")
    metrics={name:t.get(name) if finite(t.get(name)) else None for name in ["streamMs","firstConfirmedBusinessMs","basemapReadyMs","createMapCpuMs","adapterCreateMs"]}
    metrics["wholeMapAndBusinessReadyWallMs"]=stream_end-start if finite(stream_end) and finite(start) else None
    metrics["wholeMapOnlyReadyWallMs"]=base_end-start if finite(base_end) and finite(start) else None
    trace_windows={w["name"]:w for w in (trace or {}).get("profileWindows",[])};windows=[]
    for w in ws:
        name=w.get("name","unnamed")
        if "quality" in name or "preflight" in name:continue
        lo,hi=w.get("startEpochMs"),w.get("endEpochMs")
        frames=[f for f in p.get("frames",[]) if finite(f.get("startEpochMs")) and finite(lo) and finite(hi) and lo<=f["startEpochMs"]<hi]
        cpu=[f.get("renderCpuMs",f.get("cpuMs")) for f in frames]
        gpu=[f.get("gpuMs") for f in frames if not p.get("gpuTraceInvalid") and f.get("gpuStatus")=="measured"]
        main=[];stream=[]
        for s in p.get("spans",[]):
            interval=clip(s,w) if is_cpu(s) else None
            if interval is None:continue
            if s.get("thread","main")=="main":main.append(interval)
            elif s.get("thread")=="stream-worker":stream.append(interval)
        tr=trace_windows.get(name)
        windows.append({"name":name,"durationMs":w.get("durationMs"),"frameCount":len(frames),"renderCpuMs":dist(cpu),"wholeMapGpuMs":dist(gpu),
          "mainInstrumentedSpanUnionMs":union_ms(main),"streamWorkerSpanUnionMs":union_ms(stream),"nativeWorkerCpuTotalMs":None,
          "nativeWorkerUnavailableReason":"two native Workers lack distinct identity; nested/parallel CPU not summed","stageCosts":costs(p,w),
          "compositorPresentationP95Ms":at(tr,"presentationFeedback","intervals","p95Ms") if tr else None,
          "compositorFeedbackCadenceHz":at(tr,"presentationFeedback","browserFeedbackCadenceHz") if tr else None,
          "compositorPresentationPointCount":len(tr.get("presentationPoints",[])) if tr else None,
          "compositorClockAlignmentValid":tr.get("clockAlignmentValid") if tr else False,
          "traceCoveredMainCpuMs":sum(x["coveredThreadCpuMs"] for x in tr.get("rendererMainThread",[]) if finite(x.get("coveredThreadCpuMs"))) if tr and tr.get("rendererMainThread") else None,
          "gpuInvalid":p.get("gpuTraceInvalid",False),"sparseFrameCaution":name in UPDATES[:-1] and len(frames)<10})
    updates=[]
    for label in UPDATES:
        us=[u for u in t.get("updates",[]) if u.get("label")==label];win=next((w for w in windows if w["name"]==label),None)
        updates.append({"label":label,"completedCalls":len(us),"requestedIdsPerCall":us[0].get("ids") if us else None,
          "submitToConfirmationWallMs":dist([u.get("wallMs") for u in us]),"mainInstrumentedSpanUnionMs":win.get("mainInstrumentedSpanUnionMs") if win else None,
          "frameCount":win.get("frameCount") if win else None})
    progress=[];stream_start=by_name.get("streaming",{}).get("startEpochMs");count=t.get("count")
    if finite(stream_start) and count and t.get("batches"):
        for i in range(1,21):
            fraction=i/20;b=next((b for b in t["batches"] if b.get("received",0)>=math.ceil(count*fraction)),None);ack=b.get("ackEpochMs") if b else None
            progress.append({"fraction":fraction,"streamAckWallMs":ack-stream_start if finite(ack) else None,
              "wholeMapAckWallMs":ack-start if finite(ack) and finite(start) else None})
    return {"engine":engine,"count":t.get("count"),"rep":t.get("rep"),"seed":t.get("seed"),"runId":t.get("runId"),
      "instrumentation":instrumentation,"streamPolicy":t.get("streamPolicy") or t.get("policy"),"actualMaxBatch":t.get("actualMaxBatch"),
      "eligible":not reasons,"excludedReasons":reasons,"metrics":metrics,"windows":windows,"updates":updates,"ackProgress":progress,
      "batchCount":len(t.get("batches",[])),"completedUpdateCalls":sum(u["completedCalls"] for u in updates),"graphics":t.get("graphics"),
      "quality":{"verification":t.get("verification"),"witnessCount":len(t.get("witness",[]))},
      "stationaryOnlyCoverage":"measured" if any(any(k in w["name"] for k in ["static","stationary","steady"]) for w in windows) else "unavailable-no-explicit-window",
      "measurement":{"wholeMapAndBusinessReady":"load-real-basemap mark -> streaming end; includes map/base/adapter/stream; prior JS bundle load excluded",
        "streamMs":"business stream only; shared HTTP Worker and engine-specific confirmation gates",
        "stageCosts":"same-phase interval union on main/single-stream Worker; rows overlap; native Worker per-call medians"}}
def aggregate(trials):
    buckets=collections.defaultdict(list)
    for t in trials:
        if t["eligible"]:buckets[(t["engine"],t["count"],t["instrumentation"])].append(t)
    groups=[]
    for (engine,count,instrumentation),ts in sorted(buckets.items(),key=lambda x:(x[0][1],ENGINES.index(x[0][0]),x[0][2])):
        metrics={k:repeats([t["metrics"].get(k) for t in ts]) for k in ts[0]["metrics"]};windows={}
        for name in sorted({w["name"] for t in ts for w in t["windows"]}):
            ws=[w for t in ts for w in t["windows"] if w["name"]==name];a={"trialCount":len(ws)}
            for k in ["durationMs","frameCount","mainInstrumentedSpanUnionMs","streamWorkerSpanUnionMs","compositorPresentationP95Ms","compositorFeedbackCadenceHz","compositorPresentationPointCount","traceCoveredMainCpuMs"]:
                a[k]=repeats([w.get(k) for w in ws])
            for k in ["renderCpuMs","wholeMapGpuMs"]:
                a[k]={stat:repeats([w[k].get(stat) for w in ws]) for stat in ["p50","p95","p99","mean"]};a[k]["samplesPerTrial"]=[w[k]["n"] for w in ws]
            stages={}
            for key in sorted({(s["thread"],s["phase"],s["metric"]) for w in ws for s in w["stageCosts"]}):
                stages["/".join(key)]=repeats([s["value"] for w in ws for s in w["stageCosts"] if (s["thread"],s["phase"],s["metric"])==key])
            a["stageCosts"]=stages;windows[name]=a
        updates={}
        for label in UPDATES:
            us=[u for t in ts for u in t["updates"] if u["label"]==label]
            updates[label]={"wallP50":repeats([u["submitToConfirmationWallMs"]["p50"] for u in us]),
             "wallP95":repeats([u["submitToConfirmationWallMs"]["p95"] for u in us]),"mainSpanUnionMs":repeats([u["mainInstrumentedSpanUnionMs"] for u in us]),
             "completedCalls":[u["completedCalls"] for u in us],"requestedIdsPerCall":[u["requestedIdsPerCall"] for u in us]}
        progress=[]
        for i in range(1,21):
            ps=[t["ackProgress"][i-1] for t in ts if len(t["ackProgress"])==20]
            progress.append({"fraction":i/20,"streamAckWallMs":repeats([p["streamAckWallMs"] for p in ps]),"wholeMapAckWallMs":repeats([p["wholeMapAckWallMs"] for p in ps])})
        groups.append({"engine":engine,"count":count,"instrumentation":instrumentation,"trialCount":len(ts),"metrics":metrics,"windows":windows,"updates":updates,"ackProgress":progress})
    return groups
def configure_plots():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    for f in filter(None, [os.environ.get("GEOPULSE_REPORT_FONT")]):
        if pathlib.Path(f).exists():
            font_manager.fontManager.addfont(f);plt.rcParams["font.family"]=font_manager.FontProperties(fname=f).get_name();break
    plt.rcParams.update({"font.size":10,"axes.titlesize":11,"axes.labelsize":10,"axes.spines.top":False,"axes.spines.right":False,
      "axes.unicode_minus":False,"svg.fonttype":"path","figure.facecolor":"white","axes.facecolor":"white"})
    return plt
def savefig(plt,fig,out,name,caption):
    fig.text(.02,.012,caption,fontsize=8,color="#55616b");fig.tight_layout(rect=(0,.07,1,.95));files=[]
    for ext in ["png","svg"]:
        p=out/(name+"."+ext);fig.savefig(p,dpi=180,bbox_inches="tight",facecolor="white");files.append(p.name)
    plt.close(fig);return files
def curve(plt,groups,out,name,title,panels):
    fig,axs=plt.subplots(1,len(panels),figsize=(5.7*len(panels),4),squeeze=False);any_data=False
    for ax,(heading,getter) in zip(axs[0],panels):
        for engine in ENGINES:
            rows=sorted([g for g in groups if g["engine"]==engine],key=lambda g:g["count"])
            ms=[(g["count"],getter(g)) for g in rows if getter(g) and finite(getter(g).get("median"))]
            if not ms:continue
            any_data=True
            if engine=="base":
                s=ms[0][1];ax.axhline(s["median"],ls="--",color=COLORS[engine],label=LABELS[engine]);ax.axhspan(s["min"],s["max"],color=COLORS[engine],alpha=.1);continue
            xs=[x/10000 for x,_ in ms];ys=[s["median"] for _,s in ms];lo=[s["min"] for _,s in ms];hi=[s["max"] for _,s in ms]
            ax.plot(xs,ys,marker="o",lw=1.8,color=COLORS[engine],label=LABELS[engine]);ax.fill_between(xs,lo,hi,color=COLORS[engine],alpha=.12)
            ax.errorbar(xs,ys,yerr=[[a-b for a,b in zip(ys,lo)],[a-b for a,b in zip(hi,ys)]],fmt="none",capsize=3,color=COLORS[engine],alpha=.65)
        ax.set(title=heading,xlabel="业务点数（万）",ylabel="ms");ax.set_ylim(bottom=0);ax.grid(axis="y",alpha=.18)
        ax.set_xticks(sorted({g["count"]/10000 for g in groups if g["engine"]!="base"}))
        if ax.has_data():ax.legend(fontsize=8)
    fig.suptitle(title,fontsize=14,y=.995)
    if not any_data:plt.close(fig);return []
    return savefig(plt,fig,out,name,"先汇总每 trial，再取重复中位数；范围为重复最小–最大。底图线为单规模共同参考；缺失不绘制。")
def progress_plot(plt,groups,out):
    counts=sorted({g["count"] for g in groups if g["engine"]!="base"});fig,axs=plt.subplots(1,max(1,len(counts)),figsize=(5.7*max(1,len(counts)),4.1),squeeze=False);any_data=False
    for ax,count in zip(axs[0],counts):
        for g in groups:
            if g["count"]!=count or g["engine"]=="base":continue
            ps=[p for p in g["ackProgress"] if finite(p["wholeMapAckWallMs"]["median"])]
            if not ps:continue
            any_data=True;xs=[p["fraction"]*100 for p in ps];ys=[p["wholeMapAckWallMs"]["median"] for p in ps]
            ax.plot(xs,ys,lw=1.8,color=COLORS[g["engine"]],label=LABELS[g["engine"]]);ax.fill_between(xs,[p["wholeMapAckWallMs"]["min"] for p in ps],[p["wholeMapAckWallMs"]["max"] for p in ps],color=COLORS[g["engine"]],alpha=.12)
        ax.set(title=f"{count:,} 点",xlabel="完整批确认完成比例（%）",ylabel="整图初始化起算墙钟（ms）");ax.set_ylim(bottom=0);ax.grid(alpha=.18);ax.legend(fontsize=8)
    fig.suptitle("整图 + 业务准备：完整批确认里程碑",fontsize=14,y=.995)
    if not any_data:plt.close(fig);return []
    return savefig(plt,fig,out,"whole-map-ack-progress","起点含底图/adapter/业务流。线连接真实批确认里程碑，不是显示帧曲线；各引擎确认门槛不同。")
def updates_plot(plt,groups,out):
    fig,axs=plt.subplots(2,2,figsize=(11.4,7.3));any_data=False
    for ax,label in zip(axs.flat,UPDATES):
        for engine in ENGINES[1:]:
            rows=sorted([g for g in groups if g["engine"]==engine],key=lambda g:g["count"]);ms=[(g["count"],g["updates"][label]["wallP50"]) for g in rows if finite(g["updates"][label]["wallP50"]["median"])]
            if not ms:continue
            any_data=True;xs=[x/10000 for x,_ in ms];ys=[s["median"] for _,s in ms]
            ax.plot(xs,ys,marker="o",color=COLORS[engine],label=LABELS[engine]);ax.fill_between(xs,[s["min"] for _,s in ms],[s["max"] for _,s in ms],color=COLORS[engine],alpha=.12)
        ax.set(title=ULABELS[label],xlabel="业务点数（万）",ylabel="提交 → 确认墙钟（ms）");ax.set_ylim(bottom=0);ax.grid(alpha=.18);ax.legend(fontsize=8)
    fig.suptitle("更新响应：瞬时 bulk 看操作墙钟，持续更新看每 trial 操作中位数",fontsize=13,y=.995)
    if not any_data:plt.close(fig);return []
    return savefig(plt,fig,out,"update-confirmation-wall","重复先聚合，再取中位数与范围；持续更新完成次数另列。等待/CPU/GPU不可相加。")
def stage_plot(plt,groups,out,window,phases,thread="main",metric="same-phase-interval-union-ms"):
    ps=[p for p in phases if any(finite(g.get("windows",{}).get(window,{}).get("stageCosts",{}).get("/".join([thread,p,metric]),{}).get("median")) for g in groups)]
    if not ps:return []
    rows=math.ceil(len(ps)/3);fig,axs=plt.subplots(rows,3,figsize=(12,3*rows),squeeze=False)
    for ax,p in zip(axs.flat,ps):
        key="/".join([thread,p,metric])
        for engine in ENGINES:
            rows2=sorted([g for g in groups if g["engine"]==engine],key=lambda g:g["count"]);ms=[(g["count"],g.get("windows",{}).get(window,{}).get("stageCosts",{}).get(key)) for g in rows2];ms=[(x,s) for x,s in ms if s and finite(s.get("median"))]
            if not ms:continue
            xs=[x/10000 for x,_ in ms];ys=[s["median"] for _,s in ms]
            if engine=="base":ax.axhline(ys[0],ls="--",color=COLORS[engine],label=LABELS[engine])
            else:ax.plot(xs,ys,marker="o",color=COLORS[engine],label=LABELS[engine]);ax.fill_between(xs,[s["min"] for _,s in ms],[s["max"] for _,s in ms],color=COLORS[engine],alpha=.12)
        ax.set(title=PLABELS.get(p,p),xlabel="点数（万）",ylabel="ms");ax.set_ylim(bottom=0);ax.grid(alpha=.18);ax.legend(fontsize=7)
    for ax in list(axs.flat)[len(ps):]:ax.axis("off")
    fig.suptitle(f"{window} · {thread} 阶段成本",fontsize=14,y=.995)
    scope="同阶段同步区间并集；不同阶段重叠，不可相加" if metric.startswith("same") else "原生 Worker 单次同步调用中位数；前缀是部分 CPU，不是线程总 CPU"
    return savefig(plt,fig,out,f"phase-{window}-{thread}",scope+"。重复中位数与范围；缺失阶段不填 0。")
def fmt(s,digits=2):
    if not s or not finite(s.get("median")):return "未测 / 不适用"
    return f'{s["median"]:.{digits}f} ({s["min"]:.{digits}f}–{s["max"]:.{digits}f})'
def write_report(data,out):
    r=data["inputSummary"];gs=data["aggregates"];ts=data["trials"]
    lines=["# 整张地图性能结果（私有）","",
      f'本报告使用 {len(ts)} 条正式 trial，其中 {sum(t["eligible"] for t in ts)} 条满足分析门禁；原运行 passed={r["passed"]}。未将 smoke/preflight 用于排名。',
      "每 trial 先汇总，再跨重复取中位数；括号为重复最小–最大，不是置信区间。缺失保持 null，不以 0 代替。",
      "同一份本地固定真实城市矢量底图，共享 MapLibre WebGL context，业务是合成点。各方案确认门槛不同：原生 source 等待 source/tile idle，其他臂确认实际业务上传/绘制。",
      "","## 整图与业务准备墙钟","",
      "整图 + 业务准备从 load-real-basemap mark 到 streaming window 结束，包含 style 获取、地图初始化、底图 ready、adapter 与业务流。运行前已经加载的 JS bundle 不在此端点内。纯业务 streamMs 单列。",
      "","| 规模 | 方案 | 重复 | 整图 + 业务 ready ms | 纯业务流 ms | 首完整批确认 ms |","| --- | --- | ---: | ---: | ---: | ---: |"]
    for g in gs:
        if g["engine"]=="base":continue
        m=g["metrics"];lines.append(f'| {g["count"]:,} | {LABELS[g["engine"]]} | {g["trialCount"]} | {fmt(m["wholeMapAndBusinessReadyWallMs"])} | {fmt(m["streamMs"])} | {fmt(m["firstConfirmedBusinessMs"])} |')
    lines+=["","## 相机操作的整图 CPU / GPU","",
      "每格为每 trial 的整图帧中位数，再跨重复汇总。CPU 包含该原生 callback 的底图/业务工作与嵌套观察开销；GPU 是同地图 context 的异步 query，排除 compositor GPU。CPU 与 GPU 并行，不能相加为帧延迟。",
      "","| 规模 | 方案 | 整图 render CPU ms/帧 | 整图 GPU ms/帧 | 呈现反馈间隔 P95 ms |","| --- | --- | ---: | ---: | ---: |"]
    for g in gs:
        w=g["windows"].get("camera")
        if w:lines.append(f'| {g["count"]:,} | {LABELS[g["engine"]]} | {fmt(w["renderCpuMs"]["p50"],3)} | {fmt(w["wholeMapGpuMs"]["p50"],3)} | {fmt(w["compositorPresentationP95Ms"],3)} |')
    lines+=["","CPU/GPU 分图，分别展示中位数与 P95。纯底图只有一个规模标签的实测，用作共同底图参考，不假装处理过 10 万业务点。",
      "呈现反馈按 profile.windows / phaseMarks 绑定的目标 renderer 精确切分，不用包含初始化、idle 和质量检查的全 run FPS。浏览器 feedback 仍不是物理屏幕 scanout。",
      "","## 更新操作","",
      "| 规模 | 方案 | 2 点单次 ms | 连续 ID bulk ms | 分散 ID bulk ms | 持续每次中位数 ms | 持续完成次数 |","| --- | --- | ---: | ---: | ---: | ---: | --- |"]
    for g in gs:
        if g["engine"]=="base":continue
        us=g["updates"];lines.append(f'| {g["count"]:,} | {LABELS[g["engine"]]} | '+" | ".join(fmt(us[n]["wallP50"]) for n in UPDATES)+f' | {us["continuous-updates"]["completedCalls"]} |')
    lines+=["","瞬时 bulk 的帧样本少，使用真实提交 → 确认墙钟及 CPU 区间，不用一两帧的分位数排名。持续更新固定时间内完成次数可能不同，实际次数已保留。",
      "","## 阶段计量与覆盖","",
      "主线程每阶段取同步区间并集。同一行避免重复计数，不同行仍有包含/交叠，不能相加。单个流 Worker 独立列出。两个原生 Worker 缺独立 workerId，只报单次同步调用中位数；tile parse 同步前缀是部分 CPU，不推算 Worker 总 CPU。",
      "trace 的 tts/tdur 取线程时间区间并集；跨窗口边界事件排除，结果是被捕获工作的下界。线程 CPU、主线程服务区间、墙钟等待与 GPU 不相加。",
      "独立静止相机窗口覆盖："+("已测。" if any(t["stationaryOnlyCoverage"]=="measured" for t in ts) else "未测：没有显式 stationary/static/steady window，不用 idle 空隙替代。"),
      "minimal 插桩若存在，仅比较其墙钟/计数；它没有 full 阶段或 GPU 数据，不当成 GPU 覆盖。",
      "","## 结论边界","",
      "数据描述本机、固定地图、给定操作及批次策略下的成本与取舍。只有三次重复，细小差异不能自动解释为统计显著或普遍优势。初始化/adapter/准备成本已单列，不用局部业务 draw/GPU 代替整图结论。",
      "画质门禁含记录/位置校验、共享 context 与有限 witness 像素；不等于不同 shader 的全图逐像素等价证明。原始 trial/trace SHA 与每 trial 聚合保存在 data.json。",
      "","## 输出文件",""]+[f"- {name}" for name in data["figures"]]+["- data.json","- trace-analyses/：逐 trial 窗口呈现统计。",""]
    (out/"REPORT.zh-CN.md").write_text("\n".join(lines),encoding="utf-8",newline="\n")
def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("--report",type=pathlib.Path,required=True);ap.add_argument("--out",type=pathlib.Path)
    ap.add_argument("--check-schema",action="store_true");ap.add_argument("--skip-traces",action="store_true");args=ap.parse_args()
    report_path=args.report.resolve();root=report_path.parent;r=json.loads(report_path.read_text(encoding="utf-8-sig"))
    if args.check_schema:
        checks=[]
        for s in r.get("trials",[]):
            t,identity=load_trial(s,root);checks.append({"engine":t.get("engine"),"count":t.get("count"),"profile":isinstance(t.get("profile"),dict),"phaseMarks":isinstance(t.get("phaseMarks"),list),"identity":identity})
        print(json.dumps({"schemaChecked":True,"trials":checks,"rankingsCalculated":False},ensure_ascii=False));return
    if r.get("preflight") or any(x in str(root).lower() for x in ["smoke","preflight"]):raise ValueError("Smoke/preflight are collector diagnostics and cannot enter rankings")
    if args.out is None:raise ValueError("--out required")
    out=args.out.resolve()
    if out.exists():raise FileExistsError("Refusing existing output directory: "+str(out))
    out.mkdir(parents=True,exist_ok=False);(out/"trace-analyses").mkdir()
    spec=importlib.util.spec_from_file_location("whole_trace",HERE/"analyze-whole-map-trace.py");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    ts=[];identities=[];trace_errors=[];mode="headless" if r.get("config",{}).get("headless") else "headed"
    for i,s in enumerate(r.get("trials",[])):
        t,identity=load_trial(s,root);tr=None;info=t.get("trace") or s.get("trace") or {}
        if info.get("file") and not args.skip_traces:
            p=(root/info["file"]).resolve()
            if root not in p.parents:raise ValueError("Trace escapes report directory")
            actual=sha(p)
            if info.get("sha256") and actual!=info["sha256"]:raise ValueError("Trace SHA mismatch: "+p.name)
            try:
                tr=module.analyze(p,mode=mode,trial=t)
                target=out/"trace-analyses"/f'{t.get("engine")}-{t.get("count")}-r{t.get("rep",i)}.json'
                target.write_text(json.dumps(tr,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8",newline="\n")
            except Exception as error:trace_errors.append({"trace":str(p),"error":str(error)})
            identity["trace"]={"file":str(p),"sha256":actual}
        prepared=prepare(t,tr);ts.append(prepared);identities.append(identity)
        print(json.dumps({"analyzed":i+1,"engine":prepared["engine"],"count":prepared["count"],"eligible":prepared["eligible"]}),flush=True)
        del t,tr
    gs=aggregate(ts);plt=configure_plots();figures=[]
    get=lambda win,field,stat=None:lambda g:(g.get("windows",{}).get(win,{}).get(field,{}) or {}).get(stat) if stat else g.get("windows",{}).get(win,{}).get(field)
    figures+=curve(plt,gs,out,"whole-map-ready-stream-wall","整体准备与纯业务流墙钟",[("整图 + 业务 ready",lambda g:g["metrics"]["wholeMapAndBusinessReadyWallMs"]),("纯业务 streaming",lambda g:g["metrics"]["streamMs"])])
    figures+=progress_plot(plt,gs,out)
    figures+=curve(plt,gs,out,"camera-whole-map-cpu","相机操作：原生整图 render CPU",[("每 trial 帧中位数",get("camera","renderCpuMs","p50")),("每 trial 帧 P95",get("camera","renderCpuMs","p95"))])
    figures+=curve(plt,gs,out,"camera-whole-map-gpu","相机操作：整图 WebGL GPU（非 compositor GPU）",[("每 trial 帧中位数",get("camera","wholeMapGpuMs","p50")),("每 trial 帧 P95",get("camera","wholeMapGpuMs","p95"))])
    figures+=curve(plt,gs,out,"camera-compositor-feedback","相机窗口：浏览器呈现反馈间隔",[("反馈间隔 P95",get("camera","compositorPresentationP95Ms"))])
    figures+=curve(plt,gs,out,"continuous-updates-whole-map-cpu","持续 2 点更新：整图 CPU",[("每 trial 帧中位数",get("continuous-updates","renderCpuMs","p50")),("每 trial 帧 P95",get("continuous-updates","renderCpuMs","p95"))])
    figures+=curve(plt,gs,out,"continuous-updates-whole-map-gpu","持续 2 点更新：整图 WebGL GPU",[("每 trial 帧中位数",get("continuous-updates","wholeMapGpuMs","p50")),("每 trial 帧 P95",get("continuous-updates","wholeMapGpuMs","p95"))])
    figures+=updates_plot(plt,gs,out)
    figures+=stage_plot(plt,gs,out,"streaming",["map-style-update","map-source-update","map-tile-prepare","buffer-upload-submission","texture-upload-submission","business-append-prepare","business-append-convert-geojson","business-geometry-prepare"])
    figures+=stage_plot(plt,gs,out,"camera",["map-style-update","map-source-update","map-placement","map-tile-prepare","base-layer-render","business-layer-render","buffer-upload-submission","business-spatial-selection","business-spatial-index-build"])
    figures+=stage_plot(plt,gs,out,"streaming",["stream-byte-decode-buffer","stream-ndjson-drain-parse","stream-pack-and-detect"],thread="stream-worker")
    figures+=stage_plot(plt,gs,out,"streaming",["worker-tile-parse-sync-prefix","worker-geojson-index-update","worker-geojson-tile-build","worker-geojson-vector-encode"],thread="native-map-worker",metric="per-call-synchronous-ms")
    for win in sorted({w["name"] for t in ts for w in t["windows"] if any(k in w["name"] for k in ["static","stationary","steady"])}):
        figures+=curve(plt,gs,out,win+"-whole-map-cpu",win+" · 整图 CPU",[("每 trial 帧中位数",get(win,"renderCpuMs","p50"))])
        figures+=curve(plt,gs,out,win+"-whole-map-gpu",win+" · 整图 GPU",[("每 trial 帧中位数",get(win,"wholeMapGpuMs","p50"))])
    data={"schema":"geo-pulse/whole-map-results-analysis-1.0","inputReport":str(report_path),"inputReportSHA256":sha(report_path),
      "analyzerSHA256":sha(pathlib.Path(__file__)),"traceAnalyzerSHA256":sha(HERE/"analyze-whole-map-trace.py"),
      "inputSummary":{k:r.get(k) for k in ["schema","createdAt","passed","counts","engines","reps","basemap","config","browserVersion","limitations"]},
      "bindings":r.get("bindings"),"identities":identities,"trials":ts,"aggregates":gs,"figures":figures,"traceErrors":trace_errors,"traceAnalysisSkipped":args.skip_traces,
      "physicalPresentationFps":None,"aggregationPolicy":"per-trial then repeat median/min/max; no pooled-frame pseudo-replication",
      "cpuPolicy":"main/single-stream same-phase union; native Worker per-call medians; no main/Worker/wall/GPU sums",
      "analysisComplete":bool(r.get("passed")) and all(t["eligible"] for t in ts)}
    (out/"data.json").write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8",newline="\n");write_report(data,out)
    print(json.dumps({"out":str(out),"trials":len(ts),"groups":len(gs),"figureFiles":len(figures),"analysisComplete":data["analysisComplete"]},ensure_ascii=False))
if __name__=="__main__":main()
