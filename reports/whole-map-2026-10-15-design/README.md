# GeoPulse 整图性能图表 · 2026-10-15 展示版

本版将原分析图拆为独立主题，统一中文标题、配色、字号、数值栏和误差范围。全部数值取自 [2026-10-14 的已发布实测报告](../whole-map-2026-10-14/README.md)，原图和数据保留。共有 70 张独立图，每张均提供 PNG 与 SVG；这是展示版更新，没有新增性能试验。

[逐张浏览画廊](index.html) 可在下载仓库后直接用浏览器打开；代码托管页面按下面的单图链接阅读。每个单图页面只展示一张图。

先看共同策略与位置更新，再看 CPU / GPU。三次散点和最小–最大范围不表示置信区间；MapLibre 的原生合并与逐批确认合同分别展示，严格确认结果不能当作产品最大吞吐。百度为不同平台的单独验证；单次启动、已就绪底图后的业务流、CPU、GPU 和浏览器反馈分开计量。

## 共同策略与完成条件

| 单图主题 | PNG | SVG |
| --- | --- | --- |
| [整图与业务准备完成](charts/matched/whole-map-ready.md) | [查看](figures/matched/whole-map-ready.png) | [下载](figures/matched/whole-map-ready.svg) |
| [业务流至真实终态确认](charts/matched/business-stream.md) | [查看](figures/matched/business-stream.png) | [下载](figures/matched/business-stream.svg) |
| [full / minimal：业务流墙钟](charts/matched/full-minimal-stream.md) | [查看](figures/matched/full-minimal-stream.png) | [下载](figures/matched/full-minimal-stream.svg) |
| [full / minimal：整图开始至相机前门禁](charts/matched/full-minimal-pre-camera-gate.md) | [查看](figures/matched/full-minimal-pre-camera-gate.png) | [下载](figures/matched/full-minimal-pre-camera-gate.svg) |
| [full / minimal：相机命令回调间隔 P95](charts/matched/full-minimal-camera-cadence-p95.md) | [查看](figures/matched/full-minimal-camera-cadence-p95.png) | [下载](figures/matched/full-minimal-camera-cadence-p95.svg) |
| [相机窗口整图 CPU](charts/matched/camera-whole-map-cpu.md) | [查看](figures/matched/camera-whole-map-cpu.png) | [下载](figures/matched/camera-whole-map-cpu.svg) |
| [相机窗口共享 GL GPU](charts/matched/camera-whole-map-gpu.md) | [查看](figures/matched/camera-whole-map-gpu.png) | [下载](figures/matched/camera-whole-map-gpu.svg) |
| [原生 source：业务流提交合同](charts/matched/native-contract-stream.md) | [查看](figures/matched/native-contract-stream.png) | [下载](figures/matched/native-contract-stream.svg) |
| [原生 source：整图准备合同](charts/matched/native-contract-ready.md) | [查看](figures/matched/native-contract-ready.png) | [下载](figures/matched/native-contract-ready.svg) |

## 已加载地图的位置更新

| 单图主题 | PNG | SVG |
| --- | --- | --- |
| [2 ID 位置更新确认](charts/updates/two-point-update-wall.md) | [查看](figures/updates/two-point-update-wall.png) | [下载](figures/updates/two-point-update-wall.svg) |
| [连续 2048 ID 位置更新确认](charts/updates/contiguous-2048-update-wall.md) | [查看](figures/updates/contiguous-2048-update-wall.png) | [下载](figures/updates/contiguous-2048-update-wall.svg) |
| [分散 2048 ID 位置更新确认](charts/updates/scattered-2048-update-wall.md) | [查看](figures/updates/scattered-2048-update-wall.png) | [下载](figures/updates/scattered-2048-update-wall.svg) |
| [持续 2 ID 更新：单次确认墙钟](charts/updates/continuous-two-point-update-wall.md) | [查看](figures/updates/continuous-two-point-update-wall.png) | [下载](figures/updates/continuous-two-point-update-wall.svg) |
| [持续更新：本场景确认批次频次](charts/updates/continuous-confirmed-rate.md) | [查看](figures/updates/continuous-confirmed-rate.png) | [下载](figures/updates/continuous-confirmed-rate.svg) |
| [持续更新：实际完成次数](charts/updates/continuous-confirmed-count.md) | [查看](figures/updates/continuous-confirmed-count.png) | [下载](figures/updates/continuous-confirmed-count.svg) |

## 百度生产场景

| 单图主题 | PNG | SVG |
| --- | --- | --- |
| [百度：首非空业务 GL 提交](charts/baidu/first-business-gl-submit.md) | [查看](figures/baidu/first-business-gl-submit.png) | [下载](figures/baidu/first-business-gl-submit.svg) |
| [百度：已准备底图后的业务流完成](charts/baidu/ready-basemap-business-stream.md) | [查看](figures/baidu/ready-basemap-business-stream.png) | [下载](figures/baidu/ready-basemap-business-stream.svg) |
| [百度：运行前准备的独立墙钟](charts/baidu/startup-separate-wall.md) | [查看](figures/baidu/startup-separate-wall.png) | [下载](figures/baidu/startup-separate-wall.svg) |
| [百度：原生完整 callback CPU](charts/baidu/native-callback-cpu.md) | [查看](figures/baidu/native-callback-cpu.png) | [下载](figures/baidu/native-callback-cpu.svg) |
| [百度：已验证共享 GL GPU](charts/baidu/verified-shared-gl-gpu.md) | [查看](figures/baidu/verified-shared-gl-gpu.png) | [下载](figures/baidu/verified-shared-gl-gpu.svg) |
| [百度：主线程业务同步阶段](charts/baidu/main-business-service.md) | [查看](figures/baidu/main-business-service.png) | [下载](figures/baidu/main-business-service.svg) |
| [百度：唯一 stream Worker CPU](charts/baidu/stream-worker-service.md) | [查看](figures/baidu/stream-worker-service.png) | [下载](figures/baidu/stream-worker-service.svg) |
| [百度：await 与投递墙钟](charts/baidu/stream-await-wall.md) | [查看](figures/baidu/stream-await-wall.png) | [下载](figures/baidu/stream-await-wall.svg) |
| [百度：浏览器整页呈现反馈间隔 P95](charts/baidu/browser-compositor-feedback-p95.md) | [查看](figures/baidu/browser-compositor-feedback-p95.png) | [下载](figures/baidu/browser-compositor-feedback-p95.svg) |

## 默认策略与阶段归档

| 单图主题 | PNG | SVG |
| --- | --- | --- |
| [整图与业务：准备完成墙钟](charts/primary/ready-20000.md) | [查看](figures/primary/ready-20000.png) | [下载](figures/primary/ready-20000.svg) |
| [业务流：提交至实际确认墙钟](charts/primary/business-stream-20000.md) | [查看](figures/primary/business-stream-20000.png) | [下载](figures/primary/business-stream-20000.svg) |
| [业务流 ACK：进度与确认墙钟](charts/primary/ack-business-stream-20000.md) | [查看](figures/primary/ack-business-stream-20000.png) | [下载](figures/primary/ack-business-stream-20000.svg) |
| [整图起点 ACK：进度与确认墙钟](charts/primary/ack-whole-map-20000.md) | [查看](figures/primary/ack-whole-map-20000.png) | [下载](figures/primary/ack-whole-map-20000.svg) |
| [相机交互：整图 CPU](charts/primary/camera-cpu-quantiles-20000.md) | [查看](figures/primary/camera-cpu-quantiles-20000.png) | [下载](figures/primary/camera-cpu-quantiles-20000.svg) |
| [相机交互：整图 共享 GL GPU](charts/primary/camera-gpu-quantiles-20000.md) | [查看](figures/primary/camera-gpu-quantiles-20000.png) | [下载](figures/primary/camera-gpu-quantiles-20000.svg) |
| [持续更新：整图 CPU](charts/primary/continuous-updates-cpu-quantiles-20000.md) | [查看](figures/primary/continuous-updates-cpu-quantiles-20000.png) | [下载](figures/primary/continuous-updates-cpu-quantiles-20000.svg) |
| [持续更新：整图 共享 GL GPU](charts/primary/continuous-updates-gpu-quantiles-20000.md) | [查看](figures/primary/continuous-updates-gpu-quantiles-20000.png) | [下载](figures/primary/continuous-updates-gpu-quantiles-20000.svg) |
| [相机交互：浏览器呈现反馈间隔 P95](charts/primary/camera-browser-presentation-p95-20000.md) | [查看](figures/primary/camera-browser-presentation-p95-20000.png) | [下载](figures/primary/camera-browser-presentation-p95-20000.svg) |
| [2 ID 单次位置更新](charts/primary/small-update-confirmation-20000.md) | [查看](figures/primary/small-update-confirmation-20000.png) | [下载](figures/primary/small-update-confirmation-20000.svg) |
| [连续 2048 ID 位置更新](charts/primary/bulk-contiguous-confirmation-20000.md) | [查看](figures/primary/bulk-contiguous-confirmation-20000.png) | [下载](figures/primary/bulk-contiguous-confirmation-20000.svg) |
| [分散 2048 ID 位置更新](charts/primary/bulk-scattered-confirmation-20000.md) | [查看](figures/primary/bulk-scattered-confirmation-20000.png) | [下载](figures/primary/bulk-scattered-confirmation-20000.svg) |
| [持续 2 ID 更新：单次确认](charts/primary/continuous-updates-confirmation-20000.md) | [查看](figures/primary/continuous-updates-confirmation-20000.png) | [下载](figures/primary/continuous-updates-confirmation-20000.svg) |
| [业务流窗口：主线程地图与底图](charts/primary/streaming-main-map-20000.md) | [查看](figures/primary/streaming-main-map-20000.png) | [下载](figures/primary/streaming-main-map-20000.svg) |
| [业务流窗口：主线程业务准备与状态](charts/primary/streaming-main-prepare-20000.md) | [查看](figures/primary/streaming-main-prepare-20000.png) | [下载](figures/primary/streaming-main-prepare-20000.svg) |
| [业务流窗口：主线程业务绘制与空间维护](charts/primary/streaming-main-render-spatial-20000.md) | [查看](figures/primary/streaming-main-render-spatial-20000.png) | [下载](figures/primary/streaming-main-render-spatial-20000.svg) |
| [业务流窗口：主线程GL 上传提交](charts/primary/streaming-main-uploads-20000.md) | [查看](figures/primary/streaming-main-uploads-20000.png) | [下载](figures/primary/streaming-main-uploads-20000.svg) |
| [相机窗口：主线程地图与底图](charts/primary/camera-main-map-20000.md) | [查看](figures/primary/camera-main-map-20000.png) | [下载](figures/primary/camera-main-map-20000.svg) |
| [相机窗口：主线程业务准备与状态](charts/primary/camera-main-prepare-20000.md) | [查看](figures/primary/camera-main-prepare-20000.png) | [下载](figures/primary/camera-main-prepare-20000.svg) |
| [相机窗口：主线程业务绘制与空间维护](charts/primary/camera-main-render-spatial-20000.md) | [查看](figures/primary/camera-main-render-spatial-20000.png) | [下载](figures/primary/camera-main-render-spatial-20000.svg) |
| [相机窗口：主线程GL 上传提交](charts/primary/camera-main-uploads-20000.md) | [查看](figures/primary/camera-main-uploads-20000.png) | [下载](figures/primary/camera-main-uploads-20000.svg) |
| [业务流窗口：唯一 stream Worker](charts/primary/streaming-stream-worker-20000.md) | [查看](figures/primary/streaming-stream-worker-20000.png) | [下载](figures/primary/streaming-stream-worker-20000.svg) |
| [业务流窗口：原生地图 Worker 同步调用](charts/primary/streaming-native-map-worker-20000.md) | [查看](figures/primary/streaming-native-map-worker-20000.png) | [下载](figures/primary/streaming-native-map-worker-20000.svg) |
| [整图与业务：准备完成墙钟](charts/primary/ready-100000.md) | [查看](figures/primary/ready-100000.png) | [下载](figures/primary/ready-100000.svg) |
| [业务流：提交至实际确认墙钟](charts/primary/business-stream-100000.md) | [查看](figures/primary/business-stream-100000.png) | [下载](figures/primary/business-stream-100000.svg) |
| [业务流 ACK：进度与确认墙钟](charts/primary/ack-business-stream-100000.md) | [查看](figures/primary/ack-business-stream-100000.png) | [下载](figures/primary/ack-business-stream-100000.svg) |
| [整图起点 ACK：进度与确认墙钟](charts/primary/ack-whole-map-100000.md) | [查看](figures/primary/ack-whole-map-100000.png) | [下载](figures/primary/ack-whole-map-100000.svg) |
| [相机交互：整图 CPU](charts/primary/camera-cpu-quantiles-100000.md) | [查看](figures/primary/camera-cpu-quantiles-100000.png) | [下载](figures/primary/camera-cpu-quantiles-100000.svg) |
| [相机交互：整图 共享 GL GPU](charts/primary/camera-gpu-quantiles-100000.md) | [查看](figures/primary/camera-gpu-quantiles-100000.png) | [下载](figures/primary/camera-gpu-quantiles-100000.svg) |
| [持续更新：整图 CPU](charts/primary/continuous-updates-cpu-quantiles-100000.md) | [查看](figures/primary/continuous-updates-cpu-quantiles-100000.png) | [下载](figures/primary/continuous-updates-cpu-quantiles-100000.svg) |
| [持续更新：整图 共享 GL GPU](charts/primary/continuous-updates-gpu-quantiles-100000.md) | [查看](figures/primary/continuous-updates-gpu-quantiles-100000.png) | [下载](figures/primary/continuous-updates-gpu-quantiles-100000.svg) |
| [相机交互：浏览器呈现反馈间隔 P95](charts/primary/camera-browser-presentation-p95-100000.md) | [查看](figures/primary/camera-browser-presentation-p95-100000.png) | [下载](figures/primary/camera-browser-presentation-p95-100000.svg) |
| [2 ID 单次位置更新](charts/primary/small-update-confirmation-100000.md) | [查看](figures/primary/small-update-confirmation-100000.png) | [下载](figures/primary/small-update-confirmation-100000.svg) |
| [连续 2048 ID 位置更新](charts/primary/bulk-contiguous-confirmation-100000.md) | [查看](figures/primary/bulk-contiguous-confirmation-100000.png) | [下载](figures/primary/bulk-contiguous-confirmation-100000.svg) |
| [分散 2048 ID 位置更新](charts/primary/bulk-scattered-confirmation-100000.md) | [查看](figures/primary/bulk-scattered-confirmation-100000.png) | [下载](figures/primary/bulk-scattered-confirmation-100000.svg) |
| [持续 2 ID 更新：单次确认](charts/primary/continuous-updates-confirmation-100000.md) | [查看](figures/primary/continuous-updates-confirmation-100000.png) | [下载](figures/primary/continuous-updates-confirmation-100000.svg) |
| [业务流窗口：主线程地图与底图](charts/primary/streaming-main-map-100000.md) | [查看](figures/primary/streaming-main-map-100000.png) | [下载](figures/primary/streaming-main-map-100000.svg) |
| [业务流窗口：主线程业务准备与状态](charts/primary/streaming-main-prepare-100000.md) | [查看](figures/primary/streaming-main-prepare-100000.png) | [下载](figures/primary/streaming-main-prepare-100000.svg) |
| [业务流窗口：主线程业务绘制与空间维护](charts/primary/streaming-main-render-spatial-100000.md) | [查看](figures/primary/streaming-main-render-spatial-100000.png) | [下载](figures/primary/streaming-main-render-spatial-100000.svg) |
| [业务流窗口：主线程GL 上传提交](charts/primary/streaming-main-uploads-100000.md) | [查看](figures/primary/streaming-main-uploads-100000.png) | [下载](figures/primary/streaming-main-uploads-100000.svg) |
| [相机窗口：主线程地图与底图](charts/primary/camera-main-map-100000.md) | [查看](figures/primary/camera-main-map-100000.png) | [下载](figures/primary/camera-main-map-100000.svg) |
| [相机窗口：主线程业务准备与状态](charts/primary/camera-main-prepare-100000.md) | [查看](figures/primary/camera-main-prepare-100000.png) | [下载](figures/primary/camera-main-prepare-100000.svg) |
| [相机窗口：主线程业务绘制与空间维护](charts/primary/camera-main-render-spatial-100000.md) | [查看](figures/primary/camera-main-render-spatial-100000.png) | [下载](figures/primary/camera-main-render-spatial-100000.svg) |
| [相机窗口：主线程GL 上传提交](charts/primary/camera-main-uploads-100000.md) | [查看](figures/primary/camera-main-uploads-100000.png) | [下载](figures/primary/camera-main-uploads-100000.svg) |
| [业务流窗口：唯一 stream Worker](charts/primary/streaming-stream-worker-100000.md) | [查看](figures/primary/streaming-stream-worker-100000.png) | [下载](figures/primary/streaming-stream-worker-100000.svg) |
| [业务流窗口：原生地图 Worker 同步调用](charts/primary/streaming-native-map-worker-100000.md) | [查看](figures/primary/streaming-native-map-worker-100000.png) | [下载](figures/primary/streaming-native-map-worker-100000.svg) |

## 来源与复现

[精度和主题覆盖核验](verification.json) · [文件校验清单](manifest.json) · [原始数值证据](../whole-map-2026-10-14/measurements/README-evidence.md) · [重画命令](../../tools/whole-map-report-design/README.md)。

没有根据局部时间估算整张地图 FPS；物理显示帧率保持未测。缺测不填零，阶段间重叠不相加，有限样本不作为全面领先证据。
