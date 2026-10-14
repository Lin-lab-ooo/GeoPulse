#!/usr/bin/env python3
"""Business/update/Baidu redesign from frozen measured public aggregates, without a benchmark."""
from __future__ import annotations
import argparse, hashlib, json, math, statistics
from pathlib import Path

ENGINE_LABELS={"geopulse-current":"GeoPulse","deck":"deck.gl","maplibre":"MapLibre source"}
VARIANT_LABELS={"current":"GeoPulse current","hybrid":"GeoPulse hybrid"}
PHASE_LABELS={"baseline":"纯底图相机","loading":"业务加载","camera":"加载后相机"}

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def checked_stats(stats,label):
    """Keep full original floats, validate repeat median/range, and retain missing values."""
    values=stats.get("rawPerTrialValues",[])
    if not values:
        if any(stats.get(k) is not None for k in ["median","min","max"]):raise ValueError(label+": values missing with finite aggregate")
        return dict(stats)
    if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in values):raise ValueError(label+": nonfinite trial value")
    if stats.get("n")!=len(values):raise ValueError(label+": repeat count mismatch")
    expected={"median":statistics.median(values),"min":min(values),"max":max(values)}
    for key,value in expected.items():
        if not math.isclose(value,stats[key],rel_tol=1e-11,abs_tol=1e-8):raise ValueError(label+": "+key+" mismatch")
    return dict(stats)

def observed(values):
    return {"n":len(values),"median":statistics.median(values) if values else None,"min":min(values) if values else None,"max":max(values) if values else None,"rawPerTrialValues":list(values),"aggregation":"one observed scalar per trial, median/full range; a singleton is explicitly a one-time observation"}

def build_specs(source:Path):
    data={name:json.loads((source/"data"/(name+".json")).read_text(encoding="utf-8")) for name in ["matched","updates","baidu"]}
    filehash={name:sha(source/"data"/(name+".json")) for name in data}
    specs=[];checks=[]
    def row(family,index,pointer,label,colorKey,stats,**extra):
        stats=checked_stats(stats,label)
        checks.append({"sourceFile":"data/"+family+".json","sourceFileSha256":filehash[family],"sourcePointer":pointer,"label":label,"n":stats["n"],"median":stats["median"],"min":stats["min"],"max":stats["max"],"rawPerTrialValues":stats["rawPerTrialValues"],"repeatStatisticVerified":True,**extra})
        return {"label":label,"colorKey":colorKey,"stats":stats,"sourceFile":"data/"+family+".json","sourcePointer":pointer,**extra}
    def add(family,slug,title,subtitle,rows,unit,oldFigure,notes,log=False):
        legend="圆点为单次观测；没有三次重复散点或重复范围。" if all(r["stats"]["n"]==1 for r in rows) else "小实心点：每次实测；空心圆：重复中位数；横线：最小–最大。"
        specs.append({"family":family,"slug":slug,"title":title,"subtitle":subtitle,"rows":rows,"unit":unit,"oldFigure":oldFigure,"notes":[legend]+notes,"log":log})
    def mg(label,engine):
        return next((i,a) for i,a in enumerate(data["matched"]["aggregates"]) if a["label"]==label and a["engine"]==engine)
    optimized=[mg("matched-full","geopulse-current"),mg("matched-full","deck"),mg("native-coalesced","maplibre")]
    common_sub="100,000 合成点 · 相同真实 Innsbruck 底图 · 首批 2048，随后 8192"
    common_notes=["散点为三次实测；中位数和范围均先按 trial 汇总。","GeoPulse/deck 逐批实际提交；MapLibre 合并后等待完整 draw 与 source/map idle。"]
    for field,slug,title in [("wholeMapAndBusinessReadyWallMs","whole-map-ready","整图与业务准备完成"),("streamMs","business-stream","业务流至真实终态确认")]:
        rows=[row("matched",i,f"/aggregates/{i}/{field}",ENGINE_LABELS[a["engine"]]+("\n合并后终态确认" if a["label"]=="native-coalesced" else "\n逐批实际提交"),a["engine"],a[field]) for i,a in optimized]
        notes=common_notes+(["整图 ready 含 style、地图、底图、adapter 和业务；此前 JS bundle 加载除外。"] if field.startswith("whole") else ["合并臂 enqueue ACK 不等于 draw ACK；最终完整绘制已确认。"])
        add("matched",slug,title,common_sub,rows,"ms","matched-optimized-overview",notes)
    for field,stat,slug,title in [("streamMs",None,"full-minimal-stream","full / minimal：业务流墙钟"),("commonPreCameraWholeMapWallMs",None,"full-minimal-pre-camera-gate","full / minimal：整图开始至相机前门禁"),("poseIntervalsMs","p95","full-minimal-camera-cadence-p95","full / minimal：相机命令回调间隔 P95")]:
        rows=[]
        for engine in ["geopulse-current","deck","maplibre"]:
            for label in ["matched-full","matched-minimal"]:
                i,a=mg(label,engine);stats=a[field] if stat is None else a[field][stat]
                rows.append(row("matched",i,f"/aggregates/{i}/{field}"+("/"+stat if stat else ""),ENGINE_LABELS[engine]+(" • full" if label.endswith("full") else " • minimal"),engine,stats,variant="full" if label.endswith("full") else "minimal"))
        add("matched",slug,title,"共同批次 · MapLibre 为每批实际 render/idle 确认",rows,"ms","instrumentation-observed-control",["独立启动会话；OS、频率、冷暖与顺序未配对，差值不是精确仪表开销。","相机命令回调节奏不是浏览器呈现或物理 FPS；minimal 无 GPU / 阶段数据。"])
    for field,slug,title,unit in [("cameraCpuMs","camera-whole-map-cpu","相机窗口整图 CPU","ms / 帧"),("cameraGpuMs","camera-whole-map-gpu","相机窗口共享 GL GPU","ms / 帧")]:
        rows=[row("matched",i,f"/aggregates/{i}/{field}/p50",ENGINE_LABELS[a["engine"]]+("\n原生合并路径" if a["engine"]=="maplibre" else ""),a["engine"],a[field]["p50"]) for i,a in optimized]
        add("matched",slug,title,"加载完成后的相机窗口 · 每 trial 帧中位数，再汇总三次重复",rows,unit,"matched-steady-camera",["CPU 同步服务时间与 GPU query span 并行，不能相加。","GPU 覆盖共享地图 GL，排除 compositor；微小差异不推导普遍优势或物理 FPS。"])
    for field,slug,title in [("streamMs","native-contract-stream","原生 source：业务流提交合同"),("wholeMapAndBusinessReadyWallMs","native-contract-ready","原生 source：整图准备合同")]:
        rows=[]
        for label in ["matched-full","native-coalesced"]:
            i,a=mg(label,"maplibre");name="逐批实际 render / idle 确认" if label=="matched-full" else "合并后完整终态确认"
            rows.append(row("matched",i,f"/aggregates/{i}/{field}",name,"maplibre",a[field],variant="strict" if label=="matched-full" else "coalesced"))
        add("matched",slug,title,"同原生 source · 首批 2048，随后 8192 · 保留合同取舍",rows,"ms","native-contract-comparison",["严格逐批确认提供不同渐进保证；不能把它泛化为产品最大吞吐。","合并臂逐批 ACK 仅入队；完成需全部 diff promises 和 100,000 点实际 draw。"])
    # Existing update figure: four wall metrics and separate rate/count metrics.
    operations=[("small-update","two-point-update-wall","2 ID 位置更新确认"),("bulk-contiguous","contiguous-2048-update-wall","连续 2048 ID 位置更新确认"),("bulk-scattered","scattered-2048-update-wall","分散 2048 ID 位置更新确认"),("continuous-updates","continuous-two-point-update-wall","持续 2 ID 更新：单次确认墙钟")]
    for operation,slug,title in operations:
        rows=[row("updates",i,f"/aggregates/{i}/operations/{operation}/wallP50Ms",ENGINE_LABELS[a["engine"]],a["engine"],a["operations"][operation]["wallP50Ms"]) for i,a in enumerate(data["updates"]["aggregates"])]
        add("updates",slug,title,"100,000 点已加载整图 · 相同更新材料 · 对数时间轴",rows,"ms","matched-position-update-wall",["每次等待真实 commit/draw；native source 还等待 source/tile idle。","三次散点、重复中位数与完整范围；对数轴不改变原始数值。"],log=True)
    for field,slug,title,unit in [("confirmedBatchesPerSecond","continuous-confirmed-rate","持续更新：本场景确认批次频次","确认批次 / 秒"),("completedCalls","continuous-confirmed-count","持续更新：实际完成次数","确认操作次数")]:
        rows=[]
        for i,a in enumerate(data["updates"]["aggregates"]):
            v=a["operations"]["continuous-updates"][field];stats=observed(v) if isinstance(v,list) else v
            rows.append(row("updates",i,f"/aggregates/{i}/operations/continuous-updates/{field}",ENGINE_LABELS[a["engine"]],a["engine"],stats))
        add("updates",slug,title,"计划循环 1500ms · 每次确认完成后等待 100ms",rows,unit,"matched-continuous-update-commits",["频次分母为实际窗口，含等待与末次操作超出；完成次数保留三次原值。","这是该节流场景的 commit 吞吐，不能改称最大刷新率或浏览器 / 物理 FPS。"])
    # Baidu is separate platform validation and never a cross-platform ranking.
    baidu=data["baidu"]
    for field,slug,title in [("firstNonemptyBusinessGlSubmitMs","first-business-gl-submit","百度：首非空业务 GL 提交"),("businessStreamCompletedMs","ready-basemap-business-stream","百度：已准备底图后的业务流完成")]:
        rows=[row("baidu",i,f"/aggregates/{i}/metrics/{field}",VARIANT_LABELS[a["variant"]],"geopulse-"+a["variant"],a["metrics"][field],variant=a["variant"]) for i,a in enumerate(baidu["aggregates"])]
        add("baidu",slug,title,"真实百度标准底图 · 100,000 混合要素 / 120,000 顶点",rows,"ms","baidu-stream-and-startup",["SDK / UI / 地图复用，stream 开始前底图已 ready；不是整图冷启动。","current 每 trial 49 批，hybrid 13 批；首 GL 提交不是 GPU 完成或屏幕呈现。"])
    startup_rows=[]
    for field,label in [("sdkConnectWallMs","SDK 连接 • 单次观测"),("sceneGateWallMs","空业务地理底图 gate • 单次观测")]:
        startup_rows.append(row("baidu",None,"/startup/"+field,label,"neutral",observed([baidu["startup"][field]]),observationScope="single shared setup, not three repetitions"))
    add("baidu","startup-separate-wall","百度：运行前准备的独立墙钟","两项均为单次共享准备 · 不计入业务 stream",startup_rows,"ms","baidu-stream-and-startup",["SDK 连接与随后的空业务底图 scene gate 分开记录；没有三次冷启动样本。","初始 tile requested=10 / failed=2 / 成功完成=8 / inflight=0；全 run requestFailures=3。"])
    for field,slug,title in [("sdkCallbackCpuP50Ms","native-callback-cpu","百度：原生完整 callback CPU"),("sharedGlGpuP50Ms","verified-shared-gl-gpu","百度：已验证共享 GL GPU")]:
        rows=[]
        for phase in ["baseline","loading","camera"]:
            for i,a in enumerate(baidu["aggregates"]):
                rows.append(row("baidu",i,f"/aggregates/{i}/windows/{phase}/{field}",PHASE_LABELS[phase]+" • "+a["variant"],"geopulse-"+a["variant"],a["windows"][phase][field],variant=a["variant"],phase=phase))
        notes=["每 trial callback 中位数，再汇总三次；CPU 与 GPU 并行，不相加。","共享 GL query 排除 DOM / 2D labels / compositor；百度私有子阶段 CPU 未独立计量。"]
        if field.startswith("shared"):notes=["camera 4419 / 4419 有效；loading 695 / 750 有效，55 未验证 callback 保持 null。","loading 中位数只描述 verified 子集；DOM / 2D labels / compositor 不在 GL query 内。"]
        add("baidu",slug,title,"真实百度生产应用 · 三个独立窗口 · 指标单位一致",rows,"ms / callback","baidu-native-callback-cpu-gpu",notes)
    stage_sets=[("main",["business-staging","business-render-callback","business-gpu-upload-submit","business-bounds-classification"],"main-business-service","百度：主线程业务同步阶段"),
        ("stream-worker",["stream-byte-decode-buffer","stream-ndjson-drain-parse","stream-pack-and-detect"],"stream-worker-service","百度：唯一 stream Worker CPU"),
        ("wait",["stream-reader-wait","stream-main-ack-wait","stream-worker-to-main-transport"],"stream-await-wall","百度：await 与投递墙钟")]
    stage_labels={"business-staging":"主线程 staging","business-render-callback":"业务 render callback","business-gpu-upload-submit":"GL upload 提交","business-bounds-classification":"bounds 分类","stream-byte-decode-buffer":"字节 decode / buffer","stream-ndjson-drain-parse":"NDJSON drain / parse","stream-pack-and-detect":"pack / detect","stream-reader-wait":"reader.read await","stream-main-ack-wait":"main ACK await","stream-worker-to-main-transport":"Worker → main 投递"}
    for thread,phases,slug,title in stage_sets:
        rows=[]
        for phase in phases:
            for i,a in enumerate(baidu["aggregates"]):
                field="wallWaits" if thread=="wait" else "stageCpuCosts";costs=a["windows"]["loading"][field]
                key=next((k for k in costs if k.split("/",1)[1]==phase),None) if thread=="wait" else thread+"/"+phase
                stats=costs.get(key) or observed([])
                pointer=f"/aggregates/{i}/windows/loading/{field}/"+(key.replace("~","~0").replace("/","~1") if key else phase)
                rows.append(row("baidu",i,pointer,stage_labels[phase]+" • "+a["variant"],"geopulse-"+a["variant"],stats,variant=a["variant"],phase=phase))
        add("baidu",slug,title,"完整 loading 窗口 · current / hybrid 同 seed 几何 digest 一致",rows,"ms","baidu-stream-phase-costs",["同步阶段按同阶段、同线程 span 并集；不同阶段可嵌套，不能相加。","Worker 与主线程并行；await / 投递是墙钟等待，不是 CPU 服务时间。"])
    rows=[]
    for phase in ["baseline","loading","camera"]:
        for i,a in enumerate(baidu["aggregates"]):
            rows.append(row("baidu",i,f"/aggregates/{i}/windows/{phase}/compositorFeedbackIntervalP95Ms",PHASE_LABELS[phase]+" • "+a["variant"],"geopulse-"+a["variant"],a["windows"][phase]["compositorFeedbackIntervalP95Ms"],variant=a["variant"],phase=phase))
    add("baidu","browser-compositor-feedback-p95","百度：浏览器整页呈现反馈间隔 P95","目标 renderer + authored phase anchors 精确切窗",rows,"ms","baidu-compositor-feedback",["PRESENTED_ALL / PARTIAL 配对呈现终点并去重；PARTIAL 不保证每个业务 revision 完整显示。","浏览器 feedback 不是物理 scanout；加载按需绘制间隔不能改称更新响应延迟。"])
    return specs,{"schema":"geo-pulse/business-report-redesign-audit-1.0","sourcePackage":"whole-map-2026-10-14","staticMeasuredReplotOnly":True,"physicalFps":None,"inputSha256":filehash,"charts":specs,"metricChecks":checks,"sourceAggregateDataChanged":False}

def render_all(source:Path,out:Path):
    """Write only redesigned figures in a new package and return machine-readable evidence."""
    from chartkit import render_chart
    source=Path(source).resolve();out=Path(out).resolve()
    if out==source or source in out.parents:
        raise ValueError("Output must be outside the frozen source report")
    specs,audit=build_specs(source);charts=[]
    for spec in specs:
        family=spec["family"]
        rendered=render_chart(out/"figures"/family,spec["slug"],spec["title"],spec["subtitle"],spec["rows"],unit=spec["unit"],notes=spec["notes"],log=spec["log"])
        rendered["family"]=family;rendered["oldFigure"]=spec["oldFigure"]
        rendered["sourceOldFigure"]="../whole-map-2026-10-14/figures/"+family+"/"+spec["oldFigure"]+".png"
        for file in rendered["files"]:file["file"]="figures/"+family+"/"+file["file"]
        charts.append(rendered)
    for name,expected in audit["inputSha256"].items():
        if sha(source/"data"/(name+".json"))!=expected:raise ValueError("Frozen input changed during redraw: "+name)
    audit["renderedCharts"]=charts
    audit["generatorSha256"]=sha(Path(__file__))
    return charts,audit

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path,default=Path(__file__).resolve().parents[2]/"reports/whole-map-2026-10-14")
    parser.add_argument("--out",type=Path)
    args=parser.parse_args()
    if args.out:
        charts,audit=render_all(args.source,args.out)
        args.out.mkdir(parents=True,exist_ok=True)
        (args.out/"chart-audit-business.json").write_text(json.dumps(audit,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        print(json.dumps({"chartCount":len(charts),"metricCheckCount":len(audit["metricChecks"]),"outputFileCount":sum(len(c["files"]) for c in charts),"frozenSourceSha256Verified":True},ensure_ascii=False))
    else:
        specs,audit=build_specs(args.source)
        print(json.dumps({"chartCount":len(specs),"metricCheckCount":len(audit["metricChecks"]),"families":{family:sum(x["family"]==family for x in specs) for family in ["matched","updates","baidu"]}},ensure_ascii=False))
