# 方法、时钟与公开数据边界

主要对照固定 MapLibre GL JS 6.14.0、deck.gl 9.4.0、同一 Innsbruck 矢量底图/style/数据 SHA、1024×768 viewport、DPR1、同一相机轨迹、同 seed 的合成 point 流、3.2px point diameter、无 adaptive LOD。浏览器为 Microsoft Edge 155.0.4283.45，GPU 为 NVIDIA GeForce RTX 5060 Laptop GPU，经 ANGLE / Direct3D11。每个条件 3 trial，种子随重复为 20261014/20261015/20261016；条件运行顺序轮换。

每 trial 先计算业务墙钟、帧分位数和同线程区间并集，再跨三次 trial 取中位数与最小–最大。`rawPerTrialValues` 保存未舍入值；范围不是置信区间，没有把所有帧混在一起当作独立重复。缺失值为 `null`。

## 完成合同与端点

主要共同 batch 策略是首批 2048，后续 8192。GeoPulse / deck 逐批实际提交，native MapLibre 合并 source diff 后等待所有 update promises、source/map idle、可见瓦片上传，以及最终完整 100,000 点 draw。原生 source 采用原生 update/coalescing API；enqueue 回执只表示入队。首业务数据取实际 GL 提交证明，仍不代表 GPU 完成/屏幕呈现。

whole-map + business ready 从 load-real-basemap mark 到 streaming window 结束，包含 style、地图初始化、底图 ready、adapter 与业务处理，排除运行前 JS bundle 加载。默认/严格逐批确认历史试验保留，但不能泛化为产品最大吞吐。full/minimal 控制是不同启动会话，启动顺序、OS/频率/冷暖未配对；两轮墙钟差不能当作精确 observer 因果开销。minimal 无 GPU/细分 window/native Worker/CDP trace，缺失保持 null。

百度是独立生产验证，标准 JSAPI 4.0、真实上海底图、当前生产 UI，1366×768 viewport / DPR1，地图 canvas 1068×373。100k mixed geometry=120k vertices。同 SDK/UI/地图复用。SDK连接、scene gate、ready 后业务 stream 分别计量；没有跨平台排名。

## 各类时间不能互换

| 数据 | 时钟/覆盖 | 可解释的含义与限制 |
| --- | --- | --- |
| 端到端/业务/update wall ms | 主线程/Worker 锚定的 elapsed wall clock | 含等待与调度；不同端点单列 |
| network reader.read await | Promise 墙钟等待 | 含 scheduling/backpressure，不能叫纯线速传输时间 |
| decode/parse/packing/detect | stream Worker 同步服务 span | parse inclusive 与嵌套 pack/detect 不能相加 |
| queue/ACK/backpressure | postMessage → ACK resumed await | 含 delivery/staging/GL submission/调度，非 GPU completion |
| main staging/spatial/update/upload/render | 主线程同步服务 span | 同一阶段/线程取区间并集；跨阶段仍可能嵌套 |
| native Worker parse | 同步调用/前缀 | 未覆盖全部 async Worker CPU；缺 workerId 的原生 Worker不合成总 CPU |
| native whole-map callback CPU | 完整同步 callback | 包含底图/业务与观察器工作；不能倒推百度私有子阶段 |
| whole-map shared GL GPU | 异步 GPU timer query span | 与 CPU 并行；不含 compositor/DOM/2D label/callback外命令 |
| browser compositor presentation | target renderer、authored marks、clock anchors、实际呈现点去重 | PRESENTED_ALL/PARTIAL；PARTIAL不保证每个business revision完整显示；非物理 scanout |
| rAF / camera pose interval | 相机命令/SDK callback cadence | 非地图呈现 FPS |
| physical FPS | null | 未验证物理显示 scanout，不由 reciprocal ms 推导 |

阶段计量保存 network/decode/parse/packing、queue/backpressure、main staging、spatial maintenance/query、GL uploads、business render 和 whole-map CPU/GPU/呈现。不可独立观察的私有阶段保持 null。不同线程并行、CPU/GPU并行，嵌套或并发 span 不能相加成端到端墙钟。

百度 complete1 的 camera verified GPU 为 4419/4419；loading 为 695/750，余下55保持 null。旧 standard1 在 reset边界将同一个 target context 的底图前缀暂归 other，query未覆盖完整 callback；旧 window null 保留，修正后在新运行验证覆盖。没有用 targetContextGpuMs填补 whole-map GPU。GPU query 不覆盖浏览器全部 GPU。

## 场景与公开副本

评分前先核查空业务地理底图截图和资源响应，再检查数量、实际更新、projection、完整 primitives、LOD 和 witness。Innsbruck 概览截图显示道路/地点标签，building 由解码z13/z14层与固定 style 确认；百度截图显示上海道路/区名/地点。SDK连接或 custom layer render 本身不证明底图 loaded。烟雾/资源 preflight只承担诊断/coverage角色，未用作性能重复。灰/空白地理底图标为 invalid-scene，不能因旧protocol passed获得整图分数。

`data/*.json` 是去除本机路径/URL后的公开衍生分析：保留所有原数值聚合、trial摘要/计数/覆盖/null和原始身份SHA，长 presentationPoints 不在聚合中重复保存。`measurements/` 提供独立数值原证据提取，以其 manifest/提取器说明为准。公开衍生JSON本身的SHA在 manifest.report-files.json；原 trial/report/trace SHA 只绑定未改写的本地原字节，不能拿它核验改写后的公开JSON。未公开完整CDPtrace或SDK bundle，不能声称能重建所有浏览器事件。

PNG/SVG来自原 matplotlib分析器读取测量report/trial并汇总的输出，不是模拟计时。每图原始来源、分析器SHA、原始analysis SHA与图SHA见 [source-index.json](source-index.json)。所有22PNG+22SVG逐字节复制。截图也是当时真实地图，未做图像生成或编辑。

重复小、单机运行、背景负载/频率/热状态未配对，观察器/tracing有开销；有限像素witness不是不同shader全图逐像素等价证明。文中数字描述所列fixture与合同，不承诺普适倍数、最大产品FPS、功耗或总GPU利用率。
