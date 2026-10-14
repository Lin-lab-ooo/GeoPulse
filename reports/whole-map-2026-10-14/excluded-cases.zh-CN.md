# 历史排除、失败与诊断

这些身份均保留原SHA，原始档案未覆盖；没有把旧 `passed=true` 自动解释为真实整张地理地图有效或正式性能通过。以下不进入最新主要分数。具体原状态、数量与SHA见 [excluded-cases.json](data/excluded-cases.json)。

| 档案标签 | 原 passed | trial 数 | 排除角色/原因 |
| --- | --- | ---: | --- |
| preflight1 | true | 1 | Basemap/resource preflight only; excluded from performance scoring. |
| preflight2 | true | 1 | Complete native camera resource-coverage validation only; excluded from performance scoring. |
| smoke-headed1 | false | 4 | Smoke/protocol diagnostic with failed correctness/confirmation cases; excluded from formal scoring. |
| smoke-headed-native2 | true | 1 | Native source smoke only; raw passed does not promote it into formal whole-map performance. |
| smoke-headed-native3 | true | 1 | Native source smoke only; raw passed does not promote it into formal whole-map performance. |
| baidu-mixed1 | true | 6 | Invalid scene: empty business geographic basemap was blank. Original passed was protocol only, with missing whole-map GL coverage; excluded. |
| baidu-scene-diagnostic1 | false | 0 | Invalid scene: geographic basemap gate failed, no formal trials. |
| baidu-defaultstyle-diagnostic1 | false | 0 | Failed/partial style diagnostic, scene invalid, no formal trials. |
| baidu-defaultstyle-diagnostic2 | true | 1 | Single diagnostic trial, no 3-repeat formal scoring. |
| baidu-production-standard1 | true | 6 | Earlier valid production scene, retained historically. Loading whole-map GPU window had reset-boundary coverage gaps; its nulls must not be filled with target-context GPU timings. Not latest primary result. |

最初 smoke/preflight只有协议、正确性、相机覆盖或资源诊断意义。灰/空白地图是 invalid-scene：旧 baidu-mixed1 即使protocol passed，也没有可验证空业务地理底图，未用于整图结论。SDK ready与业务custom layer draw都不能代替地理场景证据。

早期 source-check分析尝试发现生产renderer字节已因百度样式初始化调整而漂移；后续 update分析绑定精确原冻结SHA并保留原trial。没有改旧身份，也不声称整个新源码已重跑旧共同地图性能路径。

native strict逐批render/idle确认约13.3s业务流属于完整保留的[历史合同对照](primary.zh-CN.md)，并非无效场景，但不是最新主要批量对照，也不能泛化为产品固有最大吞吐。主要使用共同batch+原生合理合并的真实终态确认。

百度 complete1本次有效scene也保留负面信息：初始tile requests10、failed2、成功完成8、inflight0；整次run requestFailures3，run.errors0，两种计数不同。失败没有可靠trial窗口归属，无法断言全部发生在某个流窗口。结束时browser cleanup超时10000ms记为cleanupError，未从公开摘要删除。网络安静门禁只证明评分前观察到的资源完成/无在途/安静，不保证相机后永远无新请求或所有瓦片语义完整。

百度 standard1场景有效但loading GPU覆盖缺口保留null；旧raw未回填。reset时renderer._gl暂为null造成同context底图前缀被误归other且query未完整覆盖，与SDK实际多context不同。新complete1独立实测修正后的覆盖：loading695/750、55null；camera4419/4419。
