#!/usr/bin/env python3
"""Position-update matched supplement. Existing data only; no browser or trace reanalysis."""
from __future__ import annotations
import argparse, hashlib, importlib.util, json, pathlib
HERE=pathlib.Path(__file__).resolve().parent
SOURCE_ROOT=HERE.parents[2]
spec=importlib.util.spec_from_file_location("primary_helper",HERE/"analyze-whole-map-results.py")
A=importlib.util.module_from_spec(spec);spec.loader.exec_module(A)
ENGINE_NAMES={"geopulse-current":"GeoPulse\n共同 hybrid","deck":"deck.gl\n共同 hybrid","maplibre":"MapLibre circle source\n加载合并；更新逐次确认"}
EXPECTED_IDS={"small-update":2,"bulk-contiguous":2048,"bulk-scattered":2048,"continuous-updates":2}
CACHE={}
def sha(p):
    p=p.resolve();st=p.stat();key=(str(p),st.st_size,st.st_mtime_ns)
    if key not in CACHE:CACHE[key]=hashlib.sha256(p.read_bytes()).hexdigest()
    return CACHE[key]
def verify_sources(report,folder):
    verified=[];unresolved=[];drifts=[]
    for name,expected in report.get("bindings",{}).items():
        if not isinstance(expected,str) or len(expected)!=64:unresolved.append(name);continue
        if name.startswith("geopulse/"):p=SOURCE_ROOT/"public/js"/name.split("/",1)[1]
        elif name.startswith("/assets/"):p=HERE/name.lstrip("/")
        elif name=="maplibre-worker.native":p=HERE/"node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"
        elif name=="maplibre-worker.profile":p=folder/"maplibre-worker.profile.mjs"
        elif name=="bundle":p=folder/"bundle.js"
        else:p=folder/name
        if not p.is_file():unresolved.append(name);continue
        actual=sha(p)
        if actual!=expected:
            frozen=SOURCE_ROOT/"tools/fixtures/research-2.6-release/public/js"/name.split("/",1)[1] if name.startswith("geopulse/") else None
            if frozen is None or not frozen.is_file() or sha(frozen)!=expected:
                raise ValueError("Source SHA mismatch without exact frozen source: "+name)
            drifts.append({"binding":name,"currentFile":str(p.resolve()),"currentSHA256":actual,"measuredSHA256":expected,
              "frozenFile":str(frozen.resolve()),
              "reason":"Root changed production Baidu connection default/custom style initialization after these trials; old complete source identity preserved"})
            p=frozen;actual=expected
        verified.append({"binding":name,"file":str(p.resolve()),"sha256":actual})
    return {"verifiedCount":len(verified),"unresolved":unresolved,"verified":verified,"currentWorkspaceDrifts":drifts,
            "scope":"archived private code and current immutable production/dependency/asset bytes; every resolved binding matches; cache by path,size,mtime"}
def extract(t,source_label):
    p=t.get("profile") or {};windows={w.get("name"):w for w in p.get("windows",[])}
    engine=t["engine"];rows=[]
    for label,ids in EXPECTED_IDS.items():
        us=[u for u in t.get("updates",[]) if u.get("label")==label]
        if not us or any(u.get("ids")!=ids for u in us):raise ValueError("Update material mismatch: "+label)
        w=windows.get(label)
        if not w or not A.finite(w.get("durationMs")):raise ValueError("Missing update window: "+label)
        checked=[]
        for u in us:
            receipt=u.get("receipt") or {};revision=receipt.get("revision")
            if receipt.get("updatedPoints",receipt.get("updated"))!=ids:raise ValueError("Updated point count mismatch")
            if receipt.get("queuedOnly") or u.get("queuedOnly"):raise ValueError("Enqueue ACK cannot confirm post-load update")
            actual_frames=[f for f in t.get("businessFrames",[]) if f.get("window")==label and f.get("nativeBusinessDraw") is True and (f.get("instances") or 0)>0]
            if engine=="maplibre":
                proof=bool(actual_frames) and (receipt.get("committedRevision") or 0)>=(revision or 1)
            else:
                proof=any((f.get("revision") or 0)>=(revision or 1) for f in actual_frames)
            if not proof:raise ValueError("Missing actual post-update confirmation evidence: "+engine+" "+label)
            checked.append({"revision":revision,"wallMs":u["wallMs"],"requestedIds":ids,"receipt":receipt,
              "actualNativeDrawEvidence":True,"proofScope":"native final receipt+nonempty draw for source; matching drawn revision after staging receipt for GP/deck"})
        cpu_intervals=[]
        for s in p.get("spans",[]):
            if s.get("thread","main")!="main" or not A.is_cpu(s):continue
            interval=A.clip(s,w)
            if interval is not None:cpu_intervals.append(interval)
        duration=w["durationMs"];completed=len(checked)
        rows.append({"label":label,"idsPerOperation":ids,"completedCalls":completed,"actualWindowMs":duration,
          "wallDistributionMs":A.dist([u["wallMs"] for u in checked]),"operationReceipts":checked,
          "mainSynchronousSpanUnionMs":A.union_ms(cpu_intervals),
          "confirmedBatchesPerSecond":completed/(duration/1000) if label=="continuous-updates" else None,
          "confirmedDeviceStatesPerSecond":completed*ids/(duration/1000) if label=="continuous-updates" else None,
          "rateScope":"scenario completion count / actual wall window, includes 100ms sleep after each operation; not maximum rate or frame FPS"})
    if not t.get("passed") or t.get("verification",{}).get("passed") is not True:raise ValueError("Trial quality not passed")
    return {"engine":engine,"rep":t.get("rep"),"seed":t.get("seed"),"count":t.get("count"),"sourceLabel":source_label,
      "loadContract":"coalesced-final-render" if t.get("nativeCoalesce") else "actual per-batch commit",
      "updateContract":"every update awaited actual native draw/commit; source additionally native idle",
      "operations":rows,"verification":t.get("verification"),"qualityWitnessCount":len(t.get("witness",[]))}
def aggregate(rows):
    groups=[]
    for engine in ["geopulse-current","deck","maplibre"]:
        ts=[t for t in rows if t["engine"]==engine];ops={}
        for label in EXPECTED_IDS:
            selected=[u for t in ts for u in t["operations"] if u["label"]==label]
            ops[label]={"wallP50Ms":A.repeats([u["wallDistributionMs"]["p50"] for u in selected]),
              "wallP95Ms":A.repeats([u["wallDistributionMs"]["p95"] for u in selected]),
              "mainSynchronousSpanUnionMs":A.repeats([u["mainSynchronousSpanUnionMs"] for u in selected]),
              "completedCalls":[u["completedCalls"] for u in selected],"actualWindowMs":[u["actualWindowMs"] for u in selected],
              "confirmedBatchesPerSecond":A.repeats([u["confirmedBatchesPerSecond"] for u in selected]),
              "confirmedDeviceStatesPerSecond":A.repeats([u["confirmedDeviceStatesPerSecond"] for u in selected])}
        groups.append({"engine":engine,"trialCount":len(ts),"operations":ops})
    return groups
def plots(groups,out):
    plt=A.configure_plots();files=[];fig,axs=plt.subplots(2,2,figsize=(11.5,7.8))
    for ax,label in zip(axs.flat,EXPECTED_IDS):
        for i,g in enumerate(groups):
            s=g["operations"][label]["wallP50Ms"];v=s["median"];color=A.COLORS[g["engine"]]
            ax.bar(i,v,width=.55,color=color,alpha=.83);ax.errorbar(i,v,yerr=[[v-s["min"]],[s["max"]-v]],fmt="none",color="#30434a",capsize=4)
            vals=s["rawPerTrialValues"];ax.scatter([i+(j-1)*.07 for j in range(len(vals))],vals,s=22,color="#22323a",zorder=4)
            ax.text(i,s["max"]*1.15,f"{v:.2f} ms",ha="center",va="bottom",fontsize=9)
        ax.set_xticks(range(len(groups)),[ENGINE_NAMES[g["engine"]] for g in groups])
        ax.set_yscale("log");ax.set_ylim(bottom=1);ax.margins(y=.2)
        ax.set(title=A.ULABELS[label],ylabel="提交 → 实际确认墙钟（ms，对数刻度）");ax.grid(axis="y",which="major",alpha=.18);ax.set_axisbelow(True)
    fig.suptitle("100,000 点：加载完成后的位置更新响应",fontsize=14,y=.995)
    files+=A.savefig(plt,fig,out,"matched-position-update-wall","每 trial 先汇总，再跨 3 次取中位数与范围；散点为各次结果。全部后续更新实际确认；source 同时等待原生 idle。")
    fig,axs=plt.subplots(1,2,figsize=(11.5,4.8))
    for i,g in enumerate(groups):
        op=g["operations"]["continuous-updates"];rate=op["confirmedBatchesPerSecond"];counts=op["completedCalls"];color=A.COLORS[g["engine"]]
        axs[0].bar(i,rate["median"],width=.55,color=color,alpha=.83);axs[0].errorbar(i,rate["median"],yerr=[[rate["median"]-rate["min"]],[rate["max"]-rate["median"]]],fmt="none",color="#30434a",capsize=4)
        axs[0].scatter([i+(j-1)*.07 for j in range(len(rate["rawPerTrialValues"]))],rate["rawPerTrialValues"],s=22,color="#22323a",zorder=4)
        axs[0].text(i,rate["max"]+.12,f'{rate["median"]:.2f}',ha="center",fontsize=10)
        median=A.quantile(counts,.5);axs[1].bar(i,median,width=.55,color=color,alpha=.83)
        axs[1].scatter([i+(j-1)*.07 for j in range(len(counts))],counts,s=22,color="#22323a",zorder=4);axs[1].text(i,max(counts)+.2,str(counts),ha="center",fontsize=9)
    for ax in axs:
        ax.set_xticks(range(len(groups)),[ENGINE_NAMES[g["engine"]] for g in groups]);ax.set_ylim(bottom=0);ax.margins(y=.17);ax.grid(axis="y",alpha=.18);ax.set_axisbelow(True)
    axs[0].set(title="本场景已确认 2-ID 更新批次频次",ylabel="确认更新批次 / 秒");axs[1].set(title="每个实际窗口完成次数（3 次原值）",ylabel="确认操作次数")
    fig.suptitle("持续设备状态更新：场景 commit 吞吐，非显示 FPS",fontsize=14,y=.995)
    files+=A.savefig(plt,fig,out,"matched-continuous-update-commits","计划循环 1500ms，每次确认后 sleep 100ms；分母是实际含等待/末次超出的窗口。不是最大频率、GPU FPS 或物理呈现。")
    return files
def short_report(data,out):
    lines=["# 已加载整图上的位置更新对照（私有）","",
      "10 万点加载完成后，三个方案执行相同的 2 ID 与 2048 ID 更新。原生加载阶段使用合并路径，后续每次 update 仍严格等待实际 commit / source idle。GeoPulse / deck 的返回 snapshot 与后续真实 draw revision 对账；没有用 enqueue ACK 代替确认。",
      "","| 方案 | 2 点单次 ms | 连续 2048 ID ms | 分散 2048 ID ms | 持续 2 点每次中位数 ms |","| --- | ---: | ---: | ---: | ---: |"]
    for g in data["aggregates"]:
        lines.append("| "+A.LABELS[g["engine"]]+" | "+" | ".join(A.fmt(g["operations"][k]["wallP50Ms"]) for k in EXPECTED_IDS)+" |")
    lines+=["","数值为先每 trial 汇总、再跨三次取中位数，括号为最小–最大。图采用明确的对数时间轴，使几毫秒和数百毫秒都可读；真实原值与范围保留在 data.json。",
      "","| 方案 | 连续确认操作次数（每 trial） | 实际窗口 ms | 本场景确认批次 / 秒 |","| --- | --- | --- | ---: |"]
    for g in data["aggregates"]:
        u=g["operations"]["continuous-updates"];lines.append(f'| {A.LABELS[g["engine"]]} | {u["completedCalls"]} | {[round(v,2) for v in u["actualWindowMs"]]} | {A.fmt(u["confirmedBatchesPerSecond"])} |')
    lines+=["","循环名义持续 1500ms，每次操作完成后等待 100ms，最后一个操作与等待可能使实际窗口超过计划时间。频次按实际窗口计算，包含该节流与等待；它是此场景中已确认新设备状态的 commit 吞吐，不是产品最大刷新率，更不是浏览器或物理屏幕 FPS。",
      "这里支持的优势集中在已加载后的局部位置更新提交/确认路径；它不证明 GeoPulse 整图 GPU 更快。整图 GPU 在相机窗口另有约 2.5–2.7ms 的相近样本，CPU/GPU、等待与更新次数不能相加或互相换名。",
      "每次 native source 确认还等待源/瓦片 idle，强于只确认上传调用；即使更新材料相同，也不能把本表泛化成所有原生产品的固有更新时延。三次重复与有限 witness/位置核查仍限制普遍结论。",
      "","","输出：matched-position-update-wall.png/svg、matched-continuous-update-commits.png/svg、data.json。旧 matched1/primary 报告保持原样。生产 renderer 之后因百度默认/自定义样式初始化调整发生字节变化；本图按精确原冻结 renderer SHA 验证，不改旧身份，也不声称新整体源码已在此性能路径复测。",""]
    (out/"REPORT.zh-CN.md").write_text("\n".join(lines),encoding="utf-8",newline="\n")
def main():
    global SOURCE_ROOT
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("--matched",type=pathlib.Path,required=True);ap.add_argument("--native",type=pathlib.Path,required=True);ap.add_argument("--out",type=pathlib.Path,required=True);ap.add_argument("--source-root",type=pathlib.Path,default=SOURCE_ROOT);args=ap.parse_args();SOURCE_ROOT=args.source_root.resolve()
    out=args.out.resolve()
    if out.exists():raise FileExistsError("Refusing existing output directory")
    out.mkdir(parents=True);rows=[];identities=[];source_checks=[]
    for p,label,engines in [(args.matched,"matched-policy1",{"geopulse-current","deck"}),(args.native,"native-coalesced1",{"maplibre"})]:
        p=p.resolve();r=json.loads(p.read_text(encoding="utf-8-sig"))
        if not r.get("passed"):raise ValueError("Input report failed")
        source_checks.append({"label":label,**verify_sources(r,p.parent)})
        identity={"report":str(p),"sha256":sha(p),"trials":[]}
        for s in r["trials"]:
            if s["engine"] not in engines:continue
            t,tid=A.load_trial(s,p.parent);rows.append(extract(t,label));identity["trials"].append(tid);del t
        identities.append(identity)
    groups=aggregate(rows);figs=plots(groups,out)
    data={"schema":"geo-pulse/whole-map-update-matched-analysis-1.0","analyzerSHA256":sha(pathlib.Path(__file__)),"helperSHA256":sha(HERE/"analyze-whole-map-results.py"),
      "identities":identities,"sourceVerification":source_checks,"trials":rows,"aggregates":groups,"figures":figs,
      "allUpdatesActualConfirmed":True,"ratePolicy":"actual completed 2-ID commit calls / actual continuous window including fixed100ms sleeps",
      "generalMaxRefreshRate":None,"physicalPresentationFps":None,"displayFps":None,"analysisComplete":True}
    (out/"data.json").write_text(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8",newline="\n");short_report(data,out)
    for name in ["analyze-whole-map-updates.py","analyze-whole-map-results.py"]:(out/name).write_bytes((HERE/name).read_bytes())
    print(json.dumps({"out":str(out),"trials":len(rows),"figures":len(figs),"sourceResolved":[s["verifiedCount"] for s in source_checks],
                    "unresolved":[s["unresolved"] for s in source_checks],"analysisComplete":True},ensure_ascii=False))
if __name__=="__main__":main()
