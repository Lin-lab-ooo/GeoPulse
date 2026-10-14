#!/usr/bin/env python3
"""Private matched-policy supplement: reads existing results, never launches browsers."""
from __future__ import annotations
import argparse, hashlib, importlib.util, json, pathlib
HERE=pathlib.Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location("primary_analysis",HERE/"analyze-whole-map-results.py")
A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
def marker(t,suffix):
    row=next((m for m in t.get("phaseMarks",[]) if str(m.get("name","")).endswith("-"+suffix)),None)
    return row.get("epochMs") if row else None
def extract(t,report,label):
    engine=t["engine"];p=t.get("profile") or {};mode=t.get("instrumentation") or report.get("instrumentation") or report.get("config",{}).get("instrumentation") or "full"
    windows={w.get("name"):w for w in p.get("windows",[])};begin=marker(t,"load-real-basemap");camera=marker(t,"camera-pan-zoom-rotate-tilt")
    stream_end=windows.get("streaming",{}).get("endEpochMs")
    exact=stream_end-begin if A.finite(stream_end) and A.finite(begin) else None
    precamera=camera-begin if A.finite(camera) and A.finite(begin) else None
    poses=t.get("poses",[]);pose_times=[x.get("atMs") for x in poses]
    intervals=[b-a for a,b in zip(pose_times,pose_times[1:]) if A.finite(a) and A.finite(b) and b>a]
    c=windows.get("camera");frames=[f for f in p.get("frames",[]) if c and A.finite(f.get("startEpochMs")) and c["startEpochMs"]<=f["startEpochMs"]<c["endEpochMs"]]
    native_coalesced=t.get("nativeCoalesce") is True or t.get("streamCommitPolicy")=="coalesced-final-render"
    drain=t.get("streamDrain") or {}
    coalesced_proof=(drain.get("queuedOnly") is False and drain.get("received")==t.get("count") and drain.get("nativeBusinessDraw") is True
                     and (drain.get("committedRevision") or 0)>=(drain.get("revision") or 1) and (drain.get("nativeBusinessDrawCalls") or 0)>0)
    batches=t.get("batches",[])
    max_batch=max((b.get("points",0) for b in batches),default=None)
    scalar_source_ids=all(not isinstance(s.get("sourceId"),(dict,list)) for s in p.get("spans",[]) if s.get("thread")=="native-map-worker")
    eligible=bool(t.get("passed")) and t.get("verification",{}).get("passed") is not False and scalar_source_ids and (not native_coalesced or coalesced_proof)
    contract="coalesced-final-render" if native_coalesced else "per-batch-native-render-confirmation"
    return {"engine":engine,"label":label,"instrumentation":mode,"rep":t.get("rep"),"seed":t.get("seed"),"count":t.get("count"),
      "eligible":eligible,"streamPolicy":t.get("streamPolicy") or report.get("config",{}).get("streamPolicy"),"actualMaxBatch":max_batch,
      "initialBatchPoints":batches[0].get("points") if batches else None,"batchCount":len(batches),"streamCommitPolicy":contract,
      "enqueueAckBatchCount":sum(b.get("queuedOnly") is True or b.get("confirmation")=="native-update-enqueue" for b in batches),
      "coalescedFinalRenderProof":coalesced_proof if native_coalesced else None,"streamDrain":drain if native_coalesced else None,
      "streamMs":t.get("streamMs"),"firstConfirmedBusinessMs":t.get("firstConfirmedBusinessMs"),
      "firstConfirmedBusinessEvidence":t.get("firstConfirmedBusinessEvidence") or "matching per-batch adapter confirmation",
      "wholeMapAndBusinessReadyWallMs":exact,"commonPreCameraWholeMapWallMs":precamera,
      "poseIntervalsMs":A.dist(intervals),"poseCount":len(poses),"poseCommandsAllVisible":all(x.get("visible")=="visible" for x in poses),
      "poseScope":"native rAF camera command callback intervals; not native map or physical presentation FPS",
      "cameraCpuMs":A.dist([f.get("renderCpuMs",f.get("cpuMs")) for f in frames]),
      "cameraGpuMs":A.dist([f.get("gpuMs") for f in frames if f.get("gpuStatus")=="measured" and not p.get("gpuTraceInvalid")]),
      "minimalGpuCoverage":False if mode=="minimal" else None,
      "nativeRenderedCount":t.get("nativeRenderedCount"),"verification":t.get("verification"),
      "actualGPUContextShared":t.get("graphics",{}).get("sharedContext"),
      "measurement":{"exactReady":"load-real-basemap mark -> actual streaming window end; prior bundle load excluded",
        "preCameraReady":"load mark -> camera phase mark; includes post-stream idle; same endpoint used for full/minimal because minimal has no windows",
        "ack":"enqueue ACK is never counted as actual business draw; coalesced completion uses final-render proof"}}
def load_report(path,label):
    path=path.resolve();r=json.loads(path.read_text(encoding="utf-8-sig"));rows=[];identity={"report":str(path),"sha256":sha(path),"trials":[],"label":label}
    if not r.get("passed"):raise ValueError("Supplement report not passed: "+str(path))
    if r.get("preflight") or "smoke" in str(path).lower():raise ValueError("Smoke/preflight excluded")
    for s in r.get("trials",[]):
        t,tid=A.load_trial(s,path.parent);rows.append(extract(t,r,label));identity["trials"].append(tid);del t
    return r,rows,identity
def summarize(rows):
    groups=[]
    for label,engine,mode in sorted({(t["label"],t["engine"],t["instrumentation"]) for t in rows}):
        ts=[t for t in rows if t["label"]==label and t["engine"]==engine and t["instrumentation"]==mode and t["eligible"]]
        g={"label":label,"engine":engine,"instrumentation":mode,"n":len(ts),"actualMaxBatch":sorted({t["actualMaxBatch"] for t in ts}),
           "contracts":sorted({t["streamCommitPolicy"] for t in ts})}
        for field in ["streamMs","firstConfirmedBusinessMs","wholeMapAndBusinessReadyWallMs","commonPreCameraWholeMapWallMs","poseCount"]:
            g[field]=A.repeats([t.get(field) for t in ts])
        for field in ["poseIntervalsMs","cameraCpuMs","cameraGpuMs"]:
            g[field]={stat:A.repeats([t[field].get(stat) for t in ts]) for stat in ["p50","p95","p99","mean"]}
        groups.append(g)
    return groups
def get_group(groups,label,engine):return next((g for g in groups if g["label"]==label and g["engine"]==engine),None)
def bars(plt,ax,items,field,heading,ylabel="ms",stat=None):
    for i,(name,g,color) in enumerate(items):
        s=g.get(field) if stat is None else g.get(field,{}).get(stat)
        if not s or not A.finite(s.get("median")):continue
        value=s["median"];ax.bar(i,value,color=color,alpha=.8,width=.55)
        ax.errorbar(i,value,yerr=[[value-s["min"]],[s["max"]-value]],fmt="none",color="#31424a",capsize=4,lw=1.2)
        vals=s["rawPerTrialValues"];offsets=[(j-(len(vals)-1)/2)*.08 for j in range(len(vals))]
        ax.scatter([i+o for o in offsets],vals,s=21,color="#24323a",zorder=4)
        ax.text(i,s["max"]+max(.005*s["max"],.005),f"{value:.2f}",ha="center",va="bottom",fontsize=9)
    ax.set_xticks(range(len(items)),[name for name,_,_ in items]);ax.set(title=heading,ylabel=ylabel);ax.set_ylim(bottom=0);ax.margins(y=.16);ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True)
def figures(groups,out):
    plt=A.configure_plots();files=[]
    optimized=[("GeoPulse\n共同 hybrid",get_group(groups,"matched-full","geopulse-current"),A.COLORS["geopulse-current"]),
               ("deck.gl\n共同 hybrid",get_group(groups,"matched-full","deck"),A.COLORS["deck"]),
               ("MapLibre\n合并后终态确认",get_group(groups,"native-coalesced","maplibre"),A.COLORS["maplibre"])]
    optimized=[x for x in optimized if x[1]]
    fig,axs=plt.subplots(1,2,figsize=(11.4,4.8))
    bars(plt,axs[0],optimized,"wholeMapAndBusinessReadyWallMs","整图 + 业务 ready（含底图准备）")
    bars(plt,axs[1],optimized,"streamMs","纯业务流 → 真实终态确认")
    fig.suptitle("100,000 点 · 相同 2048 → 8192 策略；各方案合理提交路径",fontsize=14,y=.995)
    files+=A.savefig(plt,fig,out,"matched-optimized-overview","3 次 trial 中位数与完整范围；散点是各次结果。确认合同注明；排除运行前 bundle 加载。不是普遍产品吞吐排名。")
    fullmin=[("GeoPulse", "geopulse-current"),("deck.gl","deck"),("MapLibre\n逐批确认","maplibre")]
    fig,axs=plt.subplots(1,3,figsize=(14,4.7))
    fields=[("streamMs",None,"纯业务流墙钟"),("commonPreCameraWholeMapWallMs",None,"整图开始 → 相机前 gate"),("poseIntervalsMs","p95","相机回调间隔 P95")]
    for ax,(field,stat,title) in zip(axs,fields):
        for i,(name,engine) in enumerate(fullmin):
            for off,label,color in [(-.17,"matched-full","#335f94"),(.17,"matched-minimal","#56a4a0")]:
                g=get_group(groups,label,engine)
                s=g.get(field) if g and stat is None else g.get(field,{}).get(stat) if g else None
                if not s or not A.finite(s.get("median")):continue
                v=s["median"];ax.bar(i+off,v,width=.28,color=color,label="full" if i==0 and label=="matched-full" else "minimal" if i==0 else None)
                ax.errorbar(i+off,v,yerr=[[v-s["min"]],[s["max"]-v]],fmt="none",color="#31424a",capsize=3)
                ax.scatter([i+off+(j-1)*.035 for j in range(len(s["rawPerTrialValues"]))],s["rawPerTrialValues"],s=13,color="#24323a",zorder=4)
        ax.set_xticks(range(len(fullmin)),[n for n,_ in fullmin]);ax.set(title=title,ylabel="ms");ax.set_ylim(bottom=0);ax.grid(axis="y",alpha=.18);ax.legend(fontsize=8);ax.set_axisbelow(True)
    fig.suptitle("full / minimal 独立会话观察对照；不解释成精确仪表开销",fontsize=14,y=.995)
    files+=A.savefig(plt,fig,out,"instrumentation-observed-control","同种子/业务规模/批次策略；启动次序、OS/频率和冷暖差异未受控。相机回调不是呈现 FPS；minimal 没有 GPU/阶段采集。")
    fig,axs=plt.subplots(1,2,figsize=(11.4,4.6))
    bars(plt,axs[0],optimized,"cameraCpuMs","相机窗口整图 CPU 中位数",stat="p50")
    bars(plt,axs[1],optimized,"cameraGpuMs","相机窗口整图 GPU 中位数",stat="p50")
    fig.suptitle("加载后的整图成本（full 插桩）",fontsize=14,y=.995)
    files+=A.savefig(plt,fig,out,"matched-steady-camera","CPU/GPU 分开；先每 trial 帧中位数再跨重复汇总。不同 trace 会话，微小差异不能宣称普遍优势。")
    contracts=[("原生 source\n每批实际确认",get_group(groups,"matched-full","maplibre"),"#c7a083"),
               ("原生 source\n合并→终态确认",get_group(groups,"native-coalesced","maplibre"),A.COLORS["maplibre"])]
    contracts=[x for x in contracts if x[1]]
    fig,axs=plt.subplots(1,2,figsize=(10,4.7));bars(plt,axs[0],contracts,"streamMs","Native 业务流：不同提交合同")
    bars(plt,axs[1],contracts,"wholeMapAndBusinessReadyWallMs","Native 整图 + 业务 ready")
    fig.suptitle("原生 source 提交策略的取舍",fontsize=14,y=.995)
    files+=A.savefig(plt,fig,out,"native-contract-comparison","合并臂 ACK 仅入队；完成端点有全部 diff promises + 100,000 点实际 draw 证明。enqueue 不是首屏或完成。")
    return files
def report(data,out):
    gs=data["aggregates"];lines=["# 共同批次策略与合理原生提交：整图补充结果（私有）","",
      "优先阅读本补充表：三个方案都采用首批 2048、随后 8192，实际最大批次均核为 8192。GeoPulse / deck 保留逐批实际提交，MapLibre 的合理合并臂以最终全部更新和真实完整绘制确认。",
      "主测试 primary 保留原默认策略、逐批 render/idle ACK 的完整成本；它的 13 秒原生流结果不能泛化成产品固有吞吐，更不能用来宣布笼统数十倍优势。",
      "","## 100,000 点：同批次策略、明确终态合同","",
      "| 方案/合同 | 重复 | 整图 + 业务 ready ms | 纯业务流 ms | 首实际业务确认 ms |",
      "| --- | ---: | ---: | ---: | ---: |"]
    for label,engine,name in [("matched-full","geopulse-current","GeoPulse；逐批提交"),("matched-full","deck","deck.gl；逐批提交"),
                            ("native-coalesced","maplibre","MapLibre；合并后实际终态确认"),("matched-full","maplibre","MapLibre；每批实际 render/idle 确认（合同对照）")]:
        g=get_group(gs,label,engine)
        if g:lines.append(f'| {name} | {g["n"]} | {A.fmt(g["wholeMapAndBusinessReadyWallMs"])} | {A.fmt(g["streamMs"])} | {A.fmt(g["firstConfirmedBusinessMs"])} |')
    lines+=["","括号是三次独立 trial 的最小–最大。整图 ready 是 load-real-basemap mark → streaming window 结束，包含 style/地图初始化、底图资源 ready、adapter 和业务处理；之前已加载的 JS bundle 除外。",
      "原生合并臂的逐批 ACK 是 enqueue，未当作逐批完成或首屏。最终完成已核全部 native update promises、source/map idle、可见瓦片与已上传 circle buckets，以及最终非空 100,000 点绘制。首业务值来自实际 native circle GL submission 的 adapter 证明，仍不是物理显示时间。",
      "","## full / minimal：观察差异，不是精确仪表开销","",
      "| 方案 | full 流 ms | minimal 流 ms | full 整图开始→相机前 gate ms | minimal 同 gate ms | full 回调间隔 P95 ms | minimal 回调间隔 P95 ms |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for engine in ["geopulse-current","deck","maplibre"]:
        f=get_group(gs,"matched-full",engine);m=get_group(gs,"matched-minimal",engine)
        if f and m:lines.append(f'| {A.LABELS[engine]} | {A.fmt(f["streamMs"])} | {A.fmt(m["streamMs"])} | {A.fmt(f["commonPreCameraWholeMapWallMs"])} | {A.fmt(m["commonPreCameraWholeMapWallMs"])} | {A.fmt(f["poseIntervalsMs"]["p95"],3)} | {A.fmt(m["poseIntervalsMs"]["p95"],3)} |')
    lines+=["","minimal 不记录细分 windows、GPU、native Worker profile 或 CDP trace；为比较整图墙钟，双方统一使用 load mark → camera phase mark，额外包含 streaming 后、相机开始前的 idle gate。它与上表的精确 stream-end 端点有区别，不虚构 minimal 的详细结束边界。",
      "full 和 minimal 是不同启动会话，启动顺序、OS、频率与冷暖状态没有配对控制。deck 的首轮波动保留在散点与范围中，不能把两轮差值当作准确 observer CPU/GPU 开销或因果提升。",
      "相机 pose 间隔是原生 rAF 驱动的相机命令回调节奏，不是整图呈现或物理屏幕 FPS。minimal 缺少 GPU 样本保持 null。",
      "","## 相机窗口整图 CPU / GPU","",
      "| 方案 | CPU ms/帧 | GPU ms/帧 |","| --- | ---: | ---: |"]
    for label,engine,name in [("matched-full","geopulse-current","GeoPulse"),("matched-full","deck","deck.gl"),("native-coalesced","maplibre","MapLibre 合并路径")]:
        g=get_group(gs,label,engine)
        if g:lines.append(f'| {name} | {A.fmt(g["cameraCpuMs"]["p50"],3)} | {A.fmt(g["cameraGpuMs"]["p50"],3)} |')
    lines+=["","CPU/GPU 分开呈现，不能相加成帧延迟；GPU 范围是共享地图 GL context，排除 compositor。只有三次重复，稳态差异不能据细小数值判普遍优胜。加载/更新路径优势不自动转成整图 GPU 或显示帧率优势。",
      "本补充记录真实固定城市底图 + 合成点，有限 witness/位置校验不能提升为不同 shader 的全图像素等价证明。原始回执、trial SHA、实际 batch 与最终 draw 证明均保留在 data.json。",""]
    (out/"REPORT.zh-CN.md").write_text("\n".join(lines),encoding="utf-8",newline="\n")
    readme=["# 建议阅读顺序（私有结果）","",
      "1. 本目录 REPORT.zh-CN.md / matched-optimized-overview.png：共同 2048→8192 策略及原生合理合并路径，作为主要批量优化对照。",
      "2. instrumentation-observed-control.png：full/minimal 不同会话观察对照；差值不能解释成精确仪表开销。",
      "3. ../formal-realmap1/analysis-primary1/REPORT.zh-CN.md：保留默认批次与每批 render/idle ACK 的完整 primary，阶段 CPU/GPU/呈现窗口与所有失败边界均按原身份保留。",
      "","primary 不是普遍产品吞吐排名，原生严格逐批确认与合并最终确认提供不同渐进展示保证。读取结果时先看完成合同，再看墙钟。",
      "所有比较只基于预声明操作与本机重复；没有物理 FPS、功耗或总 GPU 利用率结论。没有发布到外部。",""]
    (out/"README.md").write_text("\n".join(readme),encoding="utf-8",newline="\n")
def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("--full",type=pathlib.Path,required=True);ap.add_argument("--minimal",type=pathlib.Path,required=True)
    ap.add_argument("--coalesced",type=pathlib.Path,required=True);ap.add_argument("--out",type=pathlib.Path,required=True);args=ap.parse_args()
    out=args.out.resolve()
    if out.exists():raise FileExistsError("Refusing existing output directory")
    out.mkdir(parents=True);rows=[];identities=[];configs={}
    for path,label in [(args.full,"matched-full"),(args.minimal,"matched-minimal"),(args.coalesced,"native-coalesced")]:
        r,ts,identity=load_report(path,label);rows+=ts;identities.append(identity);configs[label]=r.get("config")
    if not all(t["eligible"] for t in rows):raise ValueError("Supplement has invalid trials")
    if any(t["initialBatchPoints"]!=2048 or t["actualMaxBatch"]!=8192 for t in rows):raise ValueError("Actual batch policy differs from 2048 ->8192")
    for k in ["headless","viewport","dpr","cameraMs","streamBatch","hybridBatch","onePendingBatch","workerCount","pointDiameter","adaptiveLod"]:
        if configs["matched-full"].get(k)!=configs["matched-minimal"].get(k):raise ValueError("Full/minimal common configuration mismatch: "+k)
    groups=summarize(rows);figs=figures(groups,out)
    data={"schema":"geo-pulse/whole-map-matched-analysis-1.0","analyzerSHA256":sha(pathlib.Path(__file__)),"primaryHelperSHA256":sha(HERE/"analyze-whole-map-results.py"),
      "identities":identities,"configs":configs,"trials":rows,"aggregates":groups,"figures":figs,
      "policy":"first 2048 then8192; actual max checked; per-batch/native-coalesced contracts separated",
      "fullMinimalCausalOverheadMs":None,"overheadUnavailableReason":"independent launch order/OS/frequency/cold-warm uncontrolled",
      "physicalPresentationFps":None,"analysisComplete":True}
    (out/"data.json").write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8",newline="\n");report(data,out)
    for name in ["analyze-whole-map-matched.py","analyze-whole-map-results.py"]:
        (out/name).write_bytes((HERE/name).read_bytes())
    print(json.dumps({"out":str(out),"trials":len(rows),"groups":len(groups),"figures":len(figs),"analysisComplete":True},ensure_ascii=False))
if __name__=="__main__":main()
