#!/usr/bin/env python3
"""Redraw four static report figures from published aggregates; never run a benchmark."""
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

COLORS=["#35968e","#5981c5","#cc8c60"]
LABELS=["GeoPulse\nper-batch commit","deck.gl\nper-batch commit","MapLibre\ncoalesced final draw"]

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def checked(distribution,name):
    values=np.asarray(distribution["rawPerTrialValues"],dtype=float)
    if len(values)!=3 or distribution["n"]!=3 or not np.all(np.isfinite(values)):
        raise ValueError(name+": expected three finite measured per-trial values")
    calculated={"median":float(np.median(values)),"min":float(np.min(values)),"max":float(np.max(values))}
    for key,value in calculated.items():
        if not math.isclose(value,distribution[key],rel_tol=1e-10,abs_tol=1e-8):
            raise ValueError(name+": public repeat statistic mismatch: "+key)
    return {"metric":name,"n":3,**calculated,"perTrialValues":values.tolist()}

def bars(ax,rows,labels,title,unit="ms",log=False):
    x=np.arange(len(rows));m=np.array([r["median"] for r in rows]);lo=np.array([r["min"] for r in rows]);hi=np.array([r["max"] for r in rows])
    ax.bar(x,m,color=COLORS[:len(rows)],alpha=.88,width=.65)
    ax.errorbar(x,m,yerr=np.vstack([m-lo,hi-m]),fmt="none",ecolor="#24343a",capsize=5)
    for i,r in enumerate(rows):
        ax.scatter(i+np.linspace(-.12,.12,3),r["perTrialValues"],s=22,color="#24343a",zorder=3)
        ax.annotate(f'{r["median"]:.2f}',(i,r["max"]),xytext=(0,7),textcoords="offset points",ha="center",fontsize=9)
    ax.set_xticks(x,labels);ax.set_ylabel(unit);ax.set_title(title);ax.grid(axis="y",alpha=.2);ax.set_axisbelow(True)
    if log:ax.set_yscale("log")
    else:ax.set_ylim(0,max(hi)*1.22)

def main():
    repo=Path(__file__).resolve().parents[2]
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data",type=Path,default=repo/"reports/whole-map-2026-10-14")
    parser.add_argument("--out",type=Path,required=True,help="New empty output directory, outside the immutable report package")
    args=parser.parse_args();package=args.data.resolve();out=args.out.resolve()
    if out==package or package in out.parents or out.exists():
        parser.error("--out must be a new directory outside the immutable report package")
    data={key:json.loads((package/"data"/(key+".json")).read_text(encoding="utf-8")) for key in ["matched","updates","baidu"]}
    matched=data["matched"]["aggregates"]
    selected=[next(a for a in matched if a["engine"]==engine and a["label"]==label) for engine,label in [("geopulse-current","matched-full"),("deck","matched-full"),("maplibre","native-coalesced")]]
    out.mkdir(parents=True);checks=[];figures=[]
    def metric(d,name):
        value=checked(d,name);checks.append(value);return value
    def save(fig,name,caption):
        fig.text(.02,.015,caption,fontsize=8,color="#506169");fig.tight_layout(rect=(0,.07,1,1))
        for extension in ["png","svg"]:
            target=out/(name+"."+extension);fig.savefig(target,dpi=160,bbox_inches="tight",facecolor="white");figures.append({"file":target.name,"sha256":sha(target)})
        plt.close(fig)
    fig,ax=plt.subplots(figsize=(9,5))
    bars(ax,[metric(a["wholeMapAndBusinessReadyWallMs"],a["engine"]+" whole-map-ready-ms") for a in selected],LABELS,"100k points: whole map + business ready")
    save(fig,"whole-map-ready","Measured three-trial median and full range; JS bundle loaded beforehand. ACK contracts differ; no FPS claim.")
    groups=data["updates"]["aggregates"]
    fig,ax=plt.subplots(figsize=(9,5));labels=["GeoPulse","deck.gl","MapLibre source\nper-update draw + idle"]
    bars(ax,[metric(next(a for a in groups if a["engine"]==e)["operations"]["small-update"]["wallP50Ms"],e+" two-id-update-ms") for e in ["geopulse-current","deck","maplibre"]],labels,"100k loaded points: actual two-ID update confirmation",log=True)
    save(fig,"two-point-update","Measured commits, three trials. Log time axis; stronger source idle gate is explicit. Not maximum update frequency.")
    fig,axs=plt.subplots(1,2,figsize=(12,5))
    for ax,key,title in [(axs[0],"cameraCpuMs","Native whole-map callback CPU"),(axs[1],"cameraGpuMs","Shared map GL GPU query span")]:
        bars(ax,[metric(a[key]["p50"],a["engine"]+" "+key+" p50") for a in selected],["GeoPulse","deck.gl","MapLibre source\nloaded via coalescing"],title,"ms / sampled frame")
    save(fig,"camera-cpu-gpu","Per-trial frame median, then three-trial median/range. CPU/GPU overlap; compositor excluded. Physical FPS is null.")
    b=data["baidu"];fig,axs=plt.subplots(1,2,figsize=(11,5))
    startup=[b["startup"]["sdkConnectWallMs"],b["startup"]["sceneGateWallMs"]]
    axs[0].bar([0,1],startup,color=["#758992","#a5b7be"]);axs[0].set_xticks([0,1],["SDK connect\nonce only","Empty-basemap scene gate\nonce only"]);axs[0].set_title("Separate one-time startup wall spans");axs[0].set_ylabel("ms");axs[0].set_ylim(0,max(startup)*1.2)
    for i,v in enumerate(startup):axs[0].text(i,v+300,f"{v:.2f}",ha="center",fontsize=9)
    bars(axs[1],[metric(a["metrics"]["businessStreamCompletedMs"],a["variant"]+" baidu-ready-business-stream-ms") for a in b["aggregates"]],["current\n49 batches","hybrid\n13 batches"],"100k mixed features / 120k vertices\nBusiness stream on already-ready basemap")
    save(fig,"baidu-startup-stream","Startup observations are single shared setup, not three cold starts. Stream: three trials each. No cross-platform ranking.")
    provenance={"schema":"geo-pulse/public-aggregate-replot-1.0","purpose":"Static redraw of measured published aggregate values. No browser, runtime rendering or benchmark was run.","replotScriptSha256":sha(Path(__file__)),"inputFiles":[{"file":"data/"+key+".json","sha256":sha(package/"data"/(key+".json")),"originalAnalysisSha256":d["publicDerivation"]["originalAnalysisSha256"]} for key,d in data.items()],"repeatStatisticChecks":checks,"startupSingleObservedSpansMs":startup,"figures":figures,"physicalFps":None,"fullCdpTraceReanalysis":False}
    (out/"replot-verification.json").write_text(json.dumps(provenance,indent=2)+"\n",encoding="utf-8")
    print(f"Verified {len(checks)} measured repeat distributions; wrote {len(figures)} static PNG/SVG outputs. No benchmark run.")
if __name__=="__main__":main()
