# 整张地图与各阶段性能测试协议

2026-10-14 新增。本文规定今后的 GeoPulse 性能测试默认边界：测试整张地图，同时保留各阶段耗时。它是运行前协议和计量定义，不是已执行结果。编写本文没有启动浏览器或性能负载。

旧的业务层 draw、局部 GPU 或固定画布实验仍可作为组件证据。只有包含实际底图、相同业务质量、原生地图重绘与完整数据路径的试验，才能支持整图性能结论。以前提到的 MapLibre 约 0.216 ms 与 GeoPulse 约 0.280 ms 等组件数值，需要按各自原始计时范围理解；两者不能直接推出整张地图的整体优劣。

## 1. 运行前固定的比较条件

每个正式输出先保存 manifest，再开始计时。manifest 固定：

- 工具、observer、fixture、原始数据、生产模块、底图库及业务库的版本和 SHA256；生产 legacy-v1 与完整 runtime-v2 起末身份。
- 实际浏览器版本、headed/headless、GPU/驱动与 ANGLE backend、视口 CSS 尺寸、地图容器尺寸、DPR、WebGL 版本、刷新节奏及支持的计时扩展。
- 相同的底图资源、style、瓦片来源、瓦片集、初始相机、图层顺序、地图投影、LOD、点尺寸、颜色/alpha、风险保留及质量要求。
- 数据类型、记录数、各类图元数、展开顶点数、唯一 ID/重复 ID 语义、种子、数据 SHA、NDJSON transport、压缩、服务端 chunk/delay、batch/ACK 策略。
- 冷/暖缓存定义、准备就绪条件、预热数、重复数、场景顺序、camera trace、更新计划、超时和未完成判定；每个参数是预声明值。
- 所有实际外部请求的允许范围。普通地图资源不等于地点检索授权；AK 只从用户授权的临时配置加载，不得写入源码、报告或截图，不得调用 POI/LocalSearch，不自动发布结果。

同底图对照建议包含 base-only、GeoPulse、deck.gl、MapLibre 业务 source 三臂；每臂单独运行相同地图，禁止多个 GPU 场景并行。base-only 是共同底图参考，不包含业务数据，不能将它的业务阶段填写为零而假装已经处理同样的记录。

公平公共子集先采用相同点数据、唯一 ID、点尺寸和颜色。GeoPulse 的点/线/矩形混合业务路径另做整图测试。公共点子集与混合生产路径分别报告；若图元、透明顺序、瓦片裁剪或 shader 语义不同，先记录质量差异，不能以相同 recordCount 掩盖不同工作量。

地图资源须本机固定或可复现的获准来源。所有臂使用同一批相机范围和瓦片；如果是固定本地底图，结论写明该底图的复杂度，不能推广成任意真实地图。底图资源加载与业务流加载可以并行，但必须分别记录开始/结束，不把已预加载底图的成绩命名为整图冷启动。

底图有效性必须独立验证：先在空业务场景记录地图资源响应与实际底图截图，确认道路、建筑或地名已出现。SDK 连接回调、自定义业务层首帧、业务计数或 `mode=baidu` 都不能单独证明底图加载成功。空白底图标记 `invalid-scene`，排除整图性能排名，并保留失败证据。

先比较相同批量和逐批绘制确认合同，再额外测各库的高效原生用法，例如 MapLibre 的更新队列合并。合并模式的入队 ACK 不能当成绘制 ACK，完成时间必须等待全部更新及最终有效原生绘制；首次可见只能来自实际绘制证据。不同 ACK 合同分别报告，禁止将严格逐批合同的速度差泛称产品最大吞吐差。

## 2. 三种时钟，三种不同的合计

浏览器事件使用单调时钟；Window、流 Worker、空间 Worker 都记录自己的 timeOrigin：

    browserEpochMs = performance.timeOrigin + performance.now()
    runRelativeMs = browserEpochMs - runStartedEpochMs

保留 realmId、workerId、clockOriginMs 和原始相对时间。不要直接比较不同 Worker 的 performance.now()，不要用接收时刻冒充 Worker 执行时刻。主线程收到 Worker 消息只补 receiveEpochMs；原发出时刻必须由发出方携带。页面导航、timeOrigin 改变、context lost 或测试中系统休眠须明确使对应时间比较无效。跨上下文转换按 [W3C High Resolution Time](https://w3c.github.io/hr-time/) 的时钟定义。

服务端用 Node 单调时钟单独记录生成、序列化、压缩、write/drain。浏览器与 Node 的本地单调时间没有自动共同零点；没有校时与误差界时，不计算服务端 write 到浏览器 receive 的精确单向延迟。服务器 Date.now() 仅用于日志关联。

必须区分：

| 类型 | 计算方法 | 允许解释 |
| --- | --- | --- |
| wall duration | 同一开始/结束边界的差 | 用户路径经过的墙钟时长 |
| measured CPU service | 同线程同步代码区间的差；嵌套父子区间不能重复累计 | 被观察代码的 CPU 提交/计算时间，含调度中断的测量误差 |
| GPU query duration | GPU 计时扩展的有效异步查询结果 | 被 bracket 的 WebGL 命令区间在 GPU 时间线上的跨度 |

Worker、主线程、网络和 GPU 会重叠。不得把 fetch、reader wait、ACK wait、staging、draw 与 GPU 的数值相加命名为 totalMs。总墙钟用实际端点计算；线程 CPU 单独列；区间图展示重叠。同线程 aggregate 按不重叠最外层服务区间累积，子阶段另列。浏览器全进程 CPU、GPU utilization、功耗未测就是 null，不能由这些区间估算百分比。

## 3. 每条事件与每批记录

统一事件至少包含：

    {
      schema: "geo-pulse/whole-map-span-1.0",
      runId, variantId, scenarioId, repeat,
      batchId, frameId, revision, parentSpanId, spanId,
      realmId, thread, phase, kind,
      startEpochMs, endEpochMs, durationMs,
      featureCount, vertexCount, decodedBytes, uploadedBytes,
      status, unavailableReason, scope
    }

kind 为 cpu-service、wall-wait、gpu-query 或 instant。非适用字段为 null。每阶段 status 为 measured、not-applicable、unavailable 或 invalid；unavailableReason 与 scope 不得缺失。使用批序号，不用 records 数、features 数或 stagingRevision 冒充 batchId。revision 记录 staging/commit 世代，frameId 连接实际地图重绘；它们与 batchId 是不同维度。

热路径 observer 写入有上限的内存记录或批量汇总，退出计时后落盘；不在每条数据/每帧同步 stringify、逐槽 hash、readPixels 或磁盘写入。记录原始区间与样本数量；observer 开销单列。正式性能路径与带镜像/像素 oracle 的质量路径分别执行，但绑定相同源码、fixture 与配置。

每批至少保存：

1. Worker pack 开始/结束、postMessage 前/返回、batchId、实际 feature/vertex/byte 数。
2. 主线程 message handler 进入、staging slice 开始/结束、每 slice revision、等待 commit 的开始/resolve。
3. 实际 GL geometry/index upload 所属 frame/revision 与字节/call 数。
4. ACK 主线程发送、Worker ACK handler 接收、await 恢复及下一 batch 允许时点。
5. 本批第一次实际业务 draw submission；最终 revision 被整图 draw 覆盖的时点。

分别计算 postMessage-start 到 main-receive 的 delivery delay、commit-await wall、ACK-return delay。它们包含消息调度或 promise 调度；不命名为纯 IPC、纯网络或纯 GPU 时间。取消/错误记录仍保留 runId/batchId，迟到 ACK 不得推进新 run。

## 4. 必须报告的阶段与真实边界

每个阶段均有 measured/status/scope 字段。底图库内部无法细分时，记录可测粗区间并明确细分 unavailable，不用 0 补齐。

| 阶段名 | 开始 → 结束 | 范围与限制 |
| --- | --- | --- |
| mapInitializationWallMs | 创建原生 Map → 预声明的底图 ready 条件 | 包含初始化/资源等待；独立于已准备后的业务流计时 |
| baseResourceNetwork | Resource Timing/CDP request start → responseEnd/loadingFinished | 真实底图请求；注明 cache/service-worker/TAO 与 decoded/encoded/transfer 字节可用性 |
| streamFetchHeadersWallMs | 流 Worker fetch 前 → response headers 已取得 | 不是完整下载时间 |
| streamFirstByteAtMs | run start → 第一次非空 reader value | 应用实际观察的首字节；浏览器可能提前缓存 |
| streamTransportResourceMs | 浏览器 Resource Timing 请求开始 → responseEnd | 可用时报告 transport resource elapsed，不等于纯 wire 传输；缺少条目就是 unavailable |
| streamReadWaitWallMs | 每次 reader.read 调用 → promise resume | 累计等待和调度，排除直接 ACK 等待；不等于线路吞吐 |
| streamReaderEofAtMs | run start → reader done 被 Worker 观察 | ACK 背压可能延后读取，不能命名为真实下载完成 |
| streamDecodeCpuMs | decoder.push/finishInput 的同步区间 | UTF-8 解码及输入缓冲；若现有 aggregate 包含其它工作须保留实际范围 |
| streamParseCpuMs | decoder.drain 的同步区间 | NDJSON JSON parse/record validation；不包含 reader 等待 |
| packCpuMs | packBatch 开始 → 结束 | detector、图元展开、typed buffer 分配/填充；detector 若未单独 bracket 就不细拆 |
| workerPostMessageCpuMs | postMessage 调用前 → 返回 | transfer/序列化提交成本；不代表主线程已收到 |
| workerToMainDeliveryWallMs | Worker 发出 → main message handler 进入 | 包含队列等待和事件分派；双方绝对单调时钟连接 |
| stagingCpuMs | 每 slice append 前 → 返回 | 当前 app 指 validation/copy/页管理；所有 slice 累计 |
| stagingYieldCommitWallMs | awaitCommit 调用 → resolve handler | 帧调度、上传提交与 await 调度；不代表 GPU execution |
| geometryUploadSubmissionCpuMs | position/color bufferData/SubData 调用区间 | CPU 调用成本，含驱动可见阻塞；不包含 index 调用或 GPU completion |
| indexUploadSubmissionCpuMs | index bufferData/SubData 调用区间 | LOD/空间选择索引分开计，含分配与重写 |
| spatialBuildCpuMs | 实际同步/渐进建树 slice 区间 | 累计 CPU 与 max slice；ready wall 独立，不将准备隐藏到 steady state |
| spatialQueryCpuMs | 实际主线程 query 区间；空间 Worker query 区间单列 | 不能把 Worker query 数值算作主线程 CPU；transport/delivery 独立 |
| liveBoundsMaintenanceCpuMs | 实际动态边界维护 slice 区间 | 选项未启用写 not-applicable |
| sourceAdapterCpuMs | point/属性格式转换开始 → 结束 | 公共 stream 到 GeoPulse/deck/GeoJSON 的实际转换；不将某臂转换移到计时前 |
| sourceUpdateSubmissionCpuMs | 原生 source/layer update API 调用前 → 返回 | 仅提交；异步 source processing/readiness 另列 |
| sourceProcessingWallMs | 异步 source request → 对应 revision readiness | MapLibre 自有 Worker 的切片/重建；无法细拆则保留 combined wall scope |
| wholeMapRenderCpuMs | 原生地图实际 render callback 进入 → 返回 | 包含底图与本臂业务 layer；不等于应用全部主线程 CPU |
| businessRenderCpuMs | 实际业务 layer callback 进入 → 返回 | 整图 render 的子区间；不可与 wholeMapRenderCpuMs 重复累计 |
| wholeMapGpuMs | 整图第一次 GL 工作前 begin → 整图最后 GL 工作后 end | 同一个地图 WebGL context 中底图与业务命令；有效异步 query |
| businessGpuMs | 单独 pass 中业务 GL bracket | 组件诊断，与 wholeMap GPU 不嵌套；不能代替整图值 |
| compositorFrameCadence | 真实浏览器 trace compositor frame events | browser-observed frame cadence；必须验证事件与时间线 |
| rafCallbackCadence | 保存的 native rAF callback 时间差 | 回调节奏，禁止命名为 display/presentation FPS |
| endToEndReadyWallMs | 声明的 run start → 最终业务 revision 已 ready 且被实际整图 draw 提交 | 完整功能终点；包含流与渲染的重叠过程，不包含未测物理显示延迟 |
| reportExportWallMs | 实际导出操作 → 原 server 保存 receipt | 生命周期阶段，单列；不夹进 steady frame GPU 样本 |

业务 detector、geometry 展开、native tile parse/upload 若要细分，须给对应真实代码 bracket。没有可靠内部 hook 时写 combined 与 unavailable，不能把剩余时间笼统标成 detector、GPU 或网络。

## 5. 当前实现的计量映射

现有代码位置可直接支持以下 observer；正式工具保存原始模块和 served instrumentation 的 SHA，不能只用生产 fingerprint 指代插桩后字节。

| 代码 | 可复用或新增的真实 hook | 注意事项 |
| --- | --- | --- |
| public/js/stream-worker.js readStream/sendBatch | fetch/read/push/drain/finishInput/pack/postMessage/ACK | 现有 parseMs 聚合 push、drain、finishInput；现有 networkTiming 已使用跨上下文时钟，新增每批 ID/区间后才能做准确分解 |
| public/js/app.js startRun/commitBatch/finishRun | run start/main receive/staging/ACK/terminal | 同步 append 与 awaitCommit 是不同指标；firstVisibleMs 当前为首次非空业务 GL submission |
| public/js/loading-staging.js stageGeometryBatch | primitive-aligned slice、commit await、revision | budget 在完整 slice 后检查，是 best effort；不是硬帧预算 |
| public/js/renderer.js _submitGeometryUpload/_upload | position/color/index 真实 GL 调用 | 现有 glUploadSubmissionMs 排除 index buffer allocation、LOD 与空间 index calls |
| public/js/renderer.js _render | business callback、draw/upload/build/query 子区间 | frameMs 包含维护、context/setup、上传、选择、draw 及 progressive build；frameTotalCpuMs 再包含 getStats/observer/schedule |
| public/js/renderer.js _pumpSpatialBuilds/getStats | 同步/渐进 build，主/Worker query 分离 | _selectionMetrics.queryMs 可包含 ready.stats.queryMs 的空间 Worker 数值；不是纯主线程 query CPU |
| server.mjs createServer | 实际生成/序列化/write/drain、流收尾与保存 | 当前 counters 是数量/字节，/api/metrics 是整个 Node 进程 CPU/memory；都不是每批 browser GPU 或 wire delay |

这些现有值不能拿来“倒算”未记录的阶段。尤其不可用 frameMs 减 queryMs 得到 draw CPU，也不可将 renderer.getStats 的 Worker query 与主线程区间相加后称主线程总耗时。

## 6. 原生地图整图 CPU 与 GPU 的实现要求

原生 MapLibre 的公开 triggerRepaint 只要求渲染一帧，多次调用可合并；它的调用耗时不是重绘耗时。计时必须在自然调度的原生 render callback 进入/退出采集，依据 [MapLibre Map API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#triggerrepaint)。

只在测试会话中 wrapper 固定版本的 map._render 或等价实际内部入口；安装时机必须早于 bound callback 捕获。由公开相机/API/repaint 发起工作，观察实际回调，禁止直接手动调用私有 _render 冒充正常地图交互。若仅能 bracket painter.render，报告其准确名称和范围，确认实际 pinned 版本是否存在 pre-painter GL 工作；不能自动把 painter 子区间提升为整个原生 callback。

wholeMapRenderCpuMs 的同步 duration 排除测试 wrapper 的 begin/end query 和结果 poll；observer overhead 另列。固定底图的 render 回调仍包含业务层。它不包含 callback 外的 app UI、异步 Worker、网络、GC 和 compositor CPU，页面/浏览器总 CPU 必须另用线程/进程证据测量。

GPU 采用 WebGL1 EXT_disjoint_timer_query 或 WebGL2 EXT_disjoint_timer_query_webgl2。begin 在该整图 frame 第一批 GL 命令前，end 在原生 frame 的所有 GL 命令后，包住底图和业务层。同一 TIME_ELAPSED target 不做整图/业务嵌套；需组件 GPU 诊断时另起相同条件 pass，或使用真正支持的 timestamp queries 并声明精度。

结果按 [Khronos 规范](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query/) 异步读取：回到 event loop 后轮询 available；不 busy-poll，不用 gl.finish/readPixels 迫使正式计时同步。记录 queryId/frameId、available 时点、disjoint/timeout/context-lost 和有效样本数。出现 disjoint 时使受影响查询无效，保留原值和原因，不能选择性删掉慢值。query 尚未可用不填 0。

先验证底图与业务层实际使用同一个 GL context。deck.gl 若是独立 overlay canvas，或 GeoPulse 仍在本地独立 canvas，native MapLibre query 不包含其业务 GPU 命令；此时记录每 context 的 GPU，wholeMapGpuMs 写 unavailable，不能把多个 context 相加当作整图关键路径或帧延迟。共享 custom layer 或 interleaved overlay 也必须核实际 GL identity。整图 GPU 查询覆盖一个地图 GL context，不覆盖操作系统桌面合成、浏览器其它 context、整个 GPU 利用率或物理屏幕 scanout。GPU 时间线跨度也可能含命令供给空隙，不能声称纯 shader kernel 时间。CPU 与 GPU 时间保持并列，绝不相加为帧时间。

## 7. 真实帧节奏与受控重绘分开

必须分别标明两种场景模式：

- natural-scheduling：实际地图需求驱动的底图/业务/相机调度。记录 rAF、原生 map render、业务 callback 与 compositor events 的真实次数。可观察闲时减少工作；没有绘制的闲时不存在 per-frame GPU 样本。
- fixed-repaint：通过公开 repaint 按固定相机轨迹要求各臂相同重绘次数，用于比较单帧整图 CPU/GPU。它主动改变 demand 闲时行为，不能用它证明生产 idle FPS/能耗或真实交互节奏。

相机轨迹按共同墙钟或预声明的固定 step 生成，保留每个实际 command/pose 完成时点。快臂不能执行更少移动/更新。若固定 step 等待各臂完成再推进，其 end-to-end throughput 与共同墙钟交互试验分开，不能混同。

可在 headed 原生 Edge 的独占会话用 CDP Tracing 采集 Chromium compositor/frame timeline，保存原始 trace、categories、浏览器版本和解析器 SHA。trace 中必须实际存在并能关联到当前地图时间窗的 compositor frame events，才能报相应 browser-observed cadence；仅 BeginFrame、rAF、DrawFrame 或 render callback 并不自动证明用户看到了一帧。依据 [Chrome DevTools Protocol Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/)，具体事件名以固定浏览器的实际 trace 为准。

没有可验证的 compositor/presentation events 时，physicalPresentationFps 与 presentationLatency 均为 null，记录 unavailable。即便有浏览器 presentation feedback，也不能保证外接监视器的物理 scanout；真正物理显示延迟另需相机或系统级可靠测量。不得把 1000/rAF p95 或 business frame cadence 换名为整图真实 FPS。

trace 诊断 pass 与无 trace 的正式 latency/GPU pass 分开，保留同一数据与操作计划，注明 trace 仪器开销，禁止将 trace 慢值拼到无 trace 的整体曲线。

## 8. 流式、公平 ACK 与 native source readiness

公共 NDJSON 的获取/解码/解析/pack 同样经过真实 Worker；每臂的业务格式转换也属于自己的计时成本。主比较固定相同 batchSize，例如 2048，最多一个未 ACK 批次，并明确每臂 ACK 的语义：

- GeoPulse：所有本批 geometry revision 已完成实际上传提交；不等于 GPU completion。
- deck/custom layer：匹配的数据 revision 已用于实际 layer update/render，且具体提交完成证据已记录。
- MapLibre GeoJSON：对应 diff 已被 pinned native source 处理，相关业务 revision 被整图 render 使用；单次 updateData 调用返回不能自动当成 upload ACK。

MapLibre updateData 的唯一 ID、best-effort 与返回类型按本次固定版本实际实现核验，不能用最新 API 的 Promise 约定推断旧版；官方 [GeoJSONSource API](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeoJSONSource/#updatedata) 描述了 diff 入口。必须关联 batchId/revision；普通 render 或任意 sourcedata 事件可能来自底图或前一批，不能解除本批背压。

固定 2048 的反复 source 更新可能重复 native 切片/重建，这是该公共分批策略下的真实代价；不能为它每批重建、却为另一臂提前一次 pack 全量，同时声称比较了同一流式任务。也不要把 MapLibre 的库内重建秒数全部标成 GPU upload CPU。

如果百万固定微批 source 路径超过预声明 timeout，保存 incomplete/timeout、已完成批数、最后 phase 和清理证据，不能无限等待、改成全量后覆盖旧结果或将其报成完成。如果另测合理优化的 native 分块/合并策略，新增独立策略臂、manifest 和结果。分别展示公共 batch 政策的受控比较与各方案预声明合理设置的系统比较，后者不再是单变量实验。

stream-cold 与 cached/replay 是不同情景。stream-cold 使用真实 HTTP、no-store、实际 Worker 和提交链路；业务数据不能事先在某臂 pack。cached/replay 保持同样数据与操作，仅按 manifest 缓存项复用。网络是否冷、底图是否冷、shader 是否冷、几何是否冷四项分别记录，不用一个 cold 布尔值代替。

## 9. 终点、质量门禁与场景覆盖

端点分别记录：底图 ready、业务请求开始、首次业务提交、首次完整批 ACK、reader EOF、最后 batch ACK、Worker done、最终业务 revision 被整图 draw、空间索引 ready、GPU query result 可用、实际导出保存。

last ACK/Worker done 可能先于后台建树 ready；steady 准备时必须报告空间 readiness 的等待和 CPU，不把这段从 end-to-end 记录中丢掉。map idle 不能单独证明业务完整；告警动画可使地图永不 idle。最终业务数据契约用独立 record/vertex/revision 计数验证，而不是要求全部记录都可见。

至少声明加载、稀疏静止、持续平移/缩放、全可见、密集重叠、少量位置更新、大批位置更新和删除/恢复的覆盖状态。共享比较无法实现的业务语义写 not-comparable，不把未执行填为通过。试验规模从小材料 smoke 到目标规模，每次扩大都保留独立 stem。执行矩阵可以按用户范围缩小，但报告逐项列出实际已测、失败、未测，不以全部已跑过用例通过掩盖未覆盖矩阵。

质量在正式性能前通过：相同原始数据、相同公共视觉语义、完整记录数、合理 clipping/透明次序、没有 LOD 抽样差、明确的 ID/更新语义、最后 revision/readiness、取消/失败清理。全 RGBA/上传镜像或独立数组检查放在质量 pass，性能 pass 只用低开销计数与必要状态门禁；reference shader 复用的限制保留。

## 10. 报告、档案与结论规则

正式输出建议 schema 为 geo-pulse/whole-map-benchmark-1.0。报告同时包含 manifest、phaseDefinitions、phaseCoverage、phaseSpans/batches、wholeMapFrames、GPU 查询原样本、callbackCadence、trace references、quality、sourceBefore/sourceAfter、limitations 与每条失败。

每阶段汇总包含 n、sumCpuMs 或 sumWaitWallMs（明确性质）、p50/p95/max 和 unavailable/invalid 样本数。每轨迹内帧分布先汇总，再跨独立 repeat 比较；不把成千上万的帧当独立重复。冷首轮单列且保留，臂顺序轮换；小差异报告时钟粒度与重复范围，不默认为显著改善。对照差值可显示，但 base-only 时间不能简单从另臂扣除后命名为准确业务成本，调度、cache 与 GPU 状态可能不同。

使用新输出目录和 stem，拒绝覆盖既有 reports。保存工具/hook/fixture/library/served 模块 SHA、原始报告、trace、截图和失败/partial；修采集器后用新工具 SHA 与新 stem 重跑受影响区间。生产身份变化须明确报告，不把修改期望 hash 当同源码复验。服务/页面/Worker/GL query 的释放与最后 active streams 也入报告。

结论至少区分：
- wholeMapExecution：整图路径是否实际执行并到达预声明终点。
- phaseCoverage：哪些阶段实测、combined、not-applicable、unavailable 或 invalid。
- qualityPassed：公共质量与数据契约是否通过。
- timingValid：计时身份、仪器和 GPU query 是否有效。
- comparisonScope：允许在哪种数据/底图/操作/规模/缓存政策下比较。

整体优选需要整图墙钟、整图 render CPU/GPU、实际帧节奏或其不可得限制、初始化/准备代价及质量共同支持。业务局部 GPU 更快不能替代该结论。报告仍可诚实得出场景性优势、明确代价、无明显差异、timeout 或没有足够证据。
