#!/usr/bin/env python3
"""Replot all twelve frozen Primary topics as readable, independent measured charts."""
from __future__ import annotations
import argparse, hashlib, json, math, statistics
from pathlib import Path
import numpy as np
from matplotlib import ticker
from matplotlib.lines import Line2D
import chartkit as K

ENGINES=['base','geopulse-current','geopulse-hybrid','deck','maplibre']
LABELS={'base':'纯底图参考','geopulse-current':'GeoPulse 当前','geopulse-hybrid':'GeoPulse hybrid','deck':'deck.gl','maplibre':'MapLibre source'}
PHASES={
'whole-map-render-cpu':'完整地图渲染 callback','map-painter-render':'地图 painter 渲染','base-layer-render':'底图图层绘制','map-style-update':'地图样式更新','map-source-update':'地图 source 更新','map-placement':'地图标签 placement','map-tile-prepare':'地图瓦片准备',
'native-source-_sendWorkerUpdate-submit':'原生 Worker 更新请求','native-source-loadTile-submit':'原生瓦片请求提交',
'buffer-upload-submission':'GL buffer 上传提交','texture-upload-submission':'GL texture 上传提交','business-gpu-upload-submit':'业务 GL 上传提交',
'business-append-prepare':'业务追加准备','business-append-convert-geojson':'业务转为 GeoJSON','business-attributes-prepare':'业务属性准备','business-context-initialize':'业务 context 初始化','business-geometry-prepare':'业务几何准备','business-layer-initialize':'业务图层初始化','business-layer-publish':'业务图层发布','business-layer-state-update':'业务图层状态更新','business-source-update-submit':'业务原生 source 提交',
'business-bounds-classification':'业务边界分类','business-draw-submit':'业务 draw 提交','business-layer-render':'业务图层渲染','business-live-bounds-maintenance':'业务动态边界维护','business-render-callback':'业务渲染 callback','business-spatial-index-build':'业务空间索引构建',
'stream-byte-decode-buffer':'字节 decode 与 buffer','stream-decoder-finish':'decoder 最终 flush','stream-ndjson-drain-parse':'NDJSON drain 与 parse','stream-pack-and-detect':'pack 与 detect',
'worker-geojson-filter':'GeoJSON filter','worker-geojson-index-create':'GeoJSON index 创建','worker-geojson-index-initialize':'GeoJSON index 初始化','worker-geojson-index-update':'GeoJSON index 更新','worker-geojson-tile-build':'GeoJSON tile 构建','worker-geojson-vector-encode':'GeoJSON vector encode','worker-tile-parse-sync-prefix':'瓦片 parse 同步前缀（部分）'}
OLD=['whole-map-ready-stream-wall','whole-map-ack-progress','camera-whole-map-cpu','camera-whole-map-gpu','camera-compositor-feedback','continuous-updates-whole-map-cpu','continuous-updates-whole-map-gpu','update-confirmation-wall','phase-streaming-main','phase-camera-main','phase-streaming-stream-worker','phase-streaming-native-map-worker']
FAMILIES={
 'map':('地图与底图', ['whole-map-render-cpu','map-painter-render','base-layer-render','map-style-update','map-source-update','map-placement','map-tile-prepare','native-source-_sendWorkerUpdate-submit','native-source-loadTile-submit']),
 'prepare':('业务准备与状态', ['business-append-prepare','business-append-convert-geojson','business-attributes-prepare','business-context-initialize','business-geometry-prepare','business-layer-initialize','business-layer-publish','business-layer-state-update','business-source-update-submit']),
 'render-spatial':('业务绘制与空间维护', ['business-bounds-classification','business-draw-submit','business-layer-render','business-live-bounds-maintenance','business-render-callback','business-spatial-index-build']),
 'uploads':('GL 上传提交', ['buffer-upload-submission','texture-upload-submission','business-gpu-upload-submit'])}


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def pointer(part):return str(part).replace('~','~0').replace('/','~1')
def empty():return {'n':0,'median':None,'min':None,'max':None,'rawPerTrialValues':[]}

def render_all(source:Path,out:Path):
 source=Path(source);out=Path(out)/'figures/primary';path=source/'data/primary.json';data=json.loads(path.read_text(encoding='utf-8'));source_sha=sha(path);charts=[];checks=[];counter=0
 groups={(g['engine'],g['count']):(i,g) for i,g in enumerate(data['aggregates'])}
 assert len(groups)==9 and ('base',100000) not in groups and len(data['trials'])==27
 assert all(t['eligible'] for t in data['trials'])
 def row(i,g,parts,stats,label=None,**extra):
  nonlocal counter
  ptr='/aggregates/'+str(i)+'/'+('/'.join(pointer(p) for p in parts));checked=K.validate_stats(stats,ptr)
  if checked['available']:assert checked['n']==3,ptr+' must retain three trial scalars'
  counter+=1;checks.append({'sourceFile':'data/primary.json','sourceFileSha256':source_sha,'sourcePointer':ptr,**checked})
  return {'sourceAvailability':'measured' if checked['available'] else 'null-or-not-collected','label':label or LABELS[g['engine']],'engine':g['engine'],'colorKey':g['engine'],'stats':stats,'sourceFile':'data/primary.json','sourceFileSha256':source_sha,'sourcePointer':ptr,'count':g['count'],**extra}
 def add(old,slug,title,subtitle,rows,unit,notes,log=False):
  info=K.render_chart(out,slug,title,subtitle,rows,unit=unit,notes=notes,log=log);info.update({'family':'primary','group':'primary','oldFigure':old,'originalFigure':old,'metricScope':unit,'sourcePackage':'whole-map-2026-10-14','plotType':'single-axis-interval','panelCount':1});charts.append(info)
 common=['圆点为三次重复；空心标记为重复中位数；横线为完整最小–最大范围。','所有数值来自冻结的整图测量，没有运行新的测试。']
 strict='原生 source 为严格逐批实际 render / idle 确认；长墙钟不代表产品最大吞吐。'
 for count in [20000,100000]:
  sub=f'{count:,} 点配置 · 同一真实底图 / MapLibre context · current、deck、source 固定 2048；hybrid 2048→8192'
  available=[groups[(e,count)] for e in ENGINES if (e,count) in groups and e!='base']
  for metric,name,title in [('wholeMapAndBusinessReadyWallMs','ready','整图与业务：准备完成墙钟'),('streamMs','business-stream','业务流：提交至实际确认墙钟')]:
   rows=[row(i,g,['metrics',metric],g['metrics'][metric],contract='strict per-batch native render confirmation' if g['engine']=='maplibre' else 'adapter actual per-batch submission') for i,g in available]
   notes=common+[('load-real-basemap mark → streaming window 完成；含底图 / adapter；此前 JS bundle 除外。' if name=='ready' else '此指标只覆盖业务流；不含事先底图加载或 JS bundle。'),strict]
   add('whole-map-ready-stream-wall',f'{name}-{count}',title,sub,rows,'ms',notes,log=count==100000)
  # Two independent clock endpoints; show individual repeat checkpoints and full range.
  for metric,slug,title in [('streamAckWallMs','ack-business-stream','业务流 ACK：进度与确认墙钟'),('wholeMapAckWallMs','ack-whole-map','整图起点 ACK：进度与确认墙钟')]:
   series=[];allrows=[]
   for i,g in available:
    rs=[row(i,g,['ackProgress',j,metric],point[metric],fraction=point['fraction'],clockEndpoint=metric) for j,point in enumerate(g['ackProgress'])]
    allrows.extend(rs);series.append({'label':LABELS[g['engine']],'engine':g['engine'],'x':[p['fraction']*100 for p in g['ackProgress']],'y':[r['stats']['median'] for r in rs],'measurements':rs})
   curve_notes=['实线：各确认进度点的三次重复中位数；半透明带：完整最小–最大范围。','细线保留三次轨迹；5%、50%、100% 进度处的圆点为三次原值。',strict,'比例门槛取首次 received 达到或超过目标的一批；批次可能跨过门槛，不是精确逐点时间。']
   fig,ax=K.frame(title,sub,curve_notes,curve=True)
   for s in series:
    c=K.PALETTE[s['engine']];x=s['x'];ys=s['y'];rs=s['measurements'];low=[r['stats']['min'] for r in rs];high=[r['stats']['max'] for r in rs]
    ax.fill_between(x,low,high,color=c,alpha=.11,zorder=1);ax.plot(x,ys,color=c,lw=2.3,label=s['label'],zorder=4)
    for rep in range(3):ax.plot(x,[r['stats']['rawPerTrialValues'][rep] for r in rs],color=c,lw=.55,alpha=.27,zorder=2)
    for j in [0,9,19]:
     ax.scatter([x[j]-.55,x[j],x[j]+.55],rs[j]['stats']['rawPerTrialValues'],c=c,s=17,edgecolors='white',lw=.5,zorder=5)
   if count==100000:ax.set_yscale('log');ax.yaxis.set_major_formatter(ticker.FuncFormatter(lambda x,_:f'{x:,.0f}'));ax.yaxis.set_minor_locator(ticker.NullLocator())
   else:ax.set_ylim(bottom=0)
   ax.set_xlim(0,102);ax.set_xlabel('已确认比例门槛（首次达到或超过） / %',labelpad=12);ax.set_ylabel('ms'+(' · 对数刻度' if count==100000 else ''),labelpad=12);ax.legend(loc='upper left',frameon=False,fontsize=10.3);ax.grid(axis='y',color=K.GRID)
   files=K.save(fig,out,f'{slug}-{count}');charts.append({'family':'primary','group':'primary','slug':f'{slug}-{count}','title':title,'subtitle':sub,'unit':'ms','xunit':'%','oldFigure':'whole-map-ack-progress','originalFigure':'whole-map-ack-progress','axisScale':'log-y' if count==100000 else 'linear','series':series,'rows':allrows,'files':files,'font':K.FONT,'panelCount':1,'metricScope':metric,'notes':curve_notes})
  # Frame quantiles keep CPU/GPU separate and encode P50/P95/P99 explicitly in row labels.
  for window,scope in [('camera','相机交互'),('continuous-updates','持续更新')]:
   for metric,name in [('renderCpuMs','cpu'),('wholeMapGpuMs','gpu')]:
    rows=[]
    for e in ENGINES:
     if (e,count) not in groups or (window!='camera' and e=='base'):continue
     i,g=groups[(e,count)];w=g['windows'].get(window,{})
     for stat in ['p50','p95','p99']:
      stats=w.get(metric,{}).get(stat,empty());rows.append(row(i,g,['windows',window,metric,stat],stats,LABELS[e]+'  ·  '+stat.upper(),statistic=stat,marker={'p50':'o','p95':'s','p99':'^'}[stat],window=window))
    old=('camera-whole-map-' if window=='camera' else 'continuous-updates-whole-map-')+name
    notes=common+['中位数形状：P50 圆形、P95 方形、P99 三角；每一分位数均先由 trial 帧分布计算，再汇总三次。','CPU 是同步 render 服务时间；GPU 是共享地图 GL query，排除 compositor；两者不能相加。']
    if count==20000 and window=='camera':notes.append('纯底图业务为 0；20,000 是共同配置标签。仅有该配置的三次参考，不虚构 100,000 业务参考。')
    if window=='continuous-updates':notes.append('持续更新窗口包括实际操作与每轮等待；不是最大刷新率或屏幕 FPS。')
    add(old,f'{window}-{name}-quantiles-{count}',f'{scope}：整图 '+('CPU' if name=='cpu' else '共享 GL GPU'),sub,rows,'ms / 帧',notes)
  rows=[row(i,g,['windows','camera','compositorPresentationP95Ms'],g['windows']['camera']['compositorPresentationP95Ms']) for i,g in [groups[(e,count)] for e in ENGINES if (e,count) in groups]]
  add('camera-compositor-feedback',f'camera-browser-presentation-p95-{count}','相机交互：浏览器呈现反馈间隔 P95',sub,rows,'ms',common+(['纯底图业务为 0；20,000 仅为共同配置标签。'] if count==20000 else [])+['目标 renderer + authored phase anchors 精确切窗；呈现终点配对后去重。','浏览器 feedback 不是物理 scanout，PARTIAL 不保证每个业务 revision 完整显示。'])
  operations=[('small-update','2 ID 单次位置更新'),('bulk-contiguous','连续 2048 ID 位置更新'),('bulk-scattered','分散 2048 ID 位置更新'),('continuous-updates','持续 2 ID 更新：单次确认')]
  for op,title in operations:
   rows=[row(i,g,['updates',op,'wallP50'],g['updates'][op]['wallP50'],window=op,contract='actual submitted-to-draw confirmation') for i,g in available]
   add('update-confirmation-wall',f'{op}-confirmation-{count}',title,sub,rows,'ms',common+['每个 trial 先取已完成操作的确认墙钟中位数；不同规模分别展示。',strict,'持续场景有每轮等待；不将该操作墙钟或完成次数改称 FPS。'],log=True)
  # Main phase views use clustered intervals, keeping stage labels legible and avoiding 30-row legends.
  for window,windowlabel in [('streaming','业务流窗口'),('camera','相机窗口')]:
   windowgroups=[groups[(e,count)] for e in ENGINES if (e,count) in groups and (e!='base' or window=='camera')]
   for family,(familylabel,selected) in FAMILIES.items():
    plotphases=[p for p in selected if any(('main/'+p+'/same-phase-interval-union-ms') in g['windows'].get(window,{}).get('stageCosts',{}) for i,g in windowgroups)]
    if not plotphases:continue
    r=[]
    for phase in plotphases:
     key='main/'+phase+'/same-phase-interval-union-ms'
     for i,g in windowgroups:r.append(row(i,g,['windows',window,'stageCosts',key],g['windows'].get(window,{}).get('stageCosts',{}).get(key,empty()),phase=phase,thread='main',metric='same-phase-interval-union-ms'))
    old='phase-'+window+'-main';slug=f'{window}-main-{family}-{count}';title=f'{windowlabel}：主线程{familylabel}'
    notes=common+(['纯底图业务为 0；20,000 是共同配置标签，参考不包含 20,000 业务点。'] if count==20000 and window=='camera' else [])+['每阶段按同阶段 / 同线程 span 区间并集；嵌套阶段不能相加为总 CPU 或总墙钟。','对称对数横轴，0 附近 0.1ms 内线性；未测值不绘制，完整缺失状态见元数据。']
    fig,ax=K.frame(title,sub,notes,row_count=len(plotphases)+2)
    for phaseindex,phase in enumerate(plotphases):
     for engineindex,(i,g) in enumerate(windowgroups):
      entry=next(x for x in r if x['phase']==phase and x['engine']==g['engine']);s=entry['stats']
      if s['median'] is None:continue
      y=phaseindex+(engineindex-(len(windowgroups)-1)/2)*.16;c=K.PALETTE[g['engine']]
      ax.hlines(y,s['min'],s['max'],color=c,lw=1.6,alpha=.7);ax.scatter(s['rawPerTrialValues'],[y-.03,y,y+.03],s=11,c=c,edgecolors='white',lw=.35,zorder=3,clip_on=False);ax.scatter([s['median']],[y],s=32,facecolors='white',edgecolors=c,lw=1.2,zorder=4,clip_on=False)
    ax.set_xscale('symlog',linthresh=.1);ax.set_xlim(left=0);ax.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x,_:f'{x:g}'));ax.xaxis.set_minor_locator(ticker.NullLocator());ax.set_ylim(-1.5,len(plotphases)-.4);ax.invert_yaxis();ax.set_yticks(range(len(plotphases)),[PHASES.get(p,p) for p in plotphases],fontsize=10.5);ax.set_xlabel('ms · 同阶段同步区间并集 · 对称对数刻度',labelpad=13)
    handles=[Line2D([],[],color=K.PALETTE[g['engine']],marker='o',mfc='white',lw=1.5,label=LABELS[g['engine']]) for i,g in windowgroups];ax.legend(handles=handles,loc='upper left',bbox_to_anchor=(0,1.0),ncol=3 if len(windowgroups)>4 else 2,frameon=False,fontsize=9.1,columnspacing=1.3,handlelength=1.7)
    files=K.save(fig,out,slug);charts.append({'family':'primary','group':'primary','slug':slug,'title':title,'subtitle':sub,'unit':'ms','oldFigure':old,'originalFigure':old,'notes':notes,'rows':r,'files':files,'font':K.FONT,'axisScale':'symlog-0.1','panelCount':1,'metricScope':'same-phase, same-thread synchronous interval union; nested phase rows are not additive','thread':'main','window':window})
  for thread,label,metric in [('stream-worker','唯一 stream Worker','same-phase-interval-union-ms'),('native-map-worker','原生地图 Worker 同步调用','per-call-synchronous-ms')]:
   keys=sorted({k for i,g in available for k in g['windows'].get('streaming',{}).get('stageCosts',{}) if k.startswith(thread+'/')})
   rows=[]
   # Native worker GeoJSON stages only exist for the native source; retain null evidence for other engines.
   for key in keys:
    phase=key.split('/')[1]
    for i,g in available:
     s=g['windows'].get('streaming',{}).get('stageCosts',{}).get(key,empty())
     if s['n'] or thread=='stream-worker':rows.append(row(i,g,['windows','streaming','stageCosts',key],s,PHASES.get(phase,phase)+'\n'+LABELS[g['engine']],phase=phase,thread=thread,metric=metric))
   notes=common+(['唯一 stream Worker 的同阶段 CPU 区间并集；主线程与 Worker 并行，不能相加。'] if thread=='stream-worker' else ['每 trial 原生 Worker 同步调用中位数，再汇总三次；tile parse 仅同步前缀，属于部分 CPU。','缺乏 distinct workerId；不计算原生 Worker 总 CPU，也不与主线程并集相加。'])
   log=bool(rows) and all(v>0 for r in rows for v in r['stats'].get('rawPerTrialValues',[]))
   add('phase-streaming-'+thread,f'streaming-{thread}-{count}','业务流窗口：'+label,sub,rows,'ms / 调用' if thread=='native-map-worker' else 'ms',notes,log=log)
 coverage={old:[c['slug'] for c in charts if c['oldFigure']==old] for old in OLD}
 assert all(coverage.values()),'Every original topic must be represented'
 audit={'schema':'geo-pulse/primary-report-design-audit-1.0','sourcePackage':'whole-map-2026-10-14','sourceFile':'data/primary.json','sourceFileSha256':source_sha,'originalFigureCoverage':coverage,'originalTopicCount':12,'chartCount':len(charts),'metricCheckCount':counter,'metricChecks':checks,'staticMeasuredReplotOnly':True,'sourceAggregateDataChanged':False,'physicalFps':None,'charts':charts}
 out.mkdir(parents=True,exist_ok=True);(out/'audit-primary.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 assert sha(path)==source_sha,'Frozen source aggregate changed during plotting'
 return charts,audit

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[2]/'reports/whole-map-2026-10-14');p.add_argument('--output',type=Path,required=True);a=p.parse_args();charts,audit=render_all(a.source,a.output);print(json.dumps({'chartCount':len(charts),'metricCheckCount':audit['metricCheckCount'],'allTwelveTopicsCovered':all(audit['originalFigureCoverage'].values())},ensure_ascii=False))
