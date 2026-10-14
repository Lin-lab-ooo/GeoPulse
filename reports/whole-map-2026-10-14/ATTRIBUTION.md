# 底图与图像归属

报告中的 Innsbruck 地图截图与同 fixture 的性能图使用 OpenMapTiles / OpenStreetMap 地理数据，沿用固定 fixture 的原 attribution：

© [OpenMapTiles](https://openmaptiles.org/) © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)。数据许可为 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1.0/)，设计许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。字体为 Noto Sans Regular（SIL Open Font License 1.1），底图 fixture 来源代码许可按原 manifest 记录为 BSD 3-Clause。

数据来自 maplibre/demotiles 固定 revision `601ae60796ceceda2cbd2ed3d2ea92d17a84be4b`，OpenMapTiles 3.13.1，地域 bounds `[11, 47, 12, 48]`。用于正式测试的 25 tile、style、glyph 与许可文件原始 SHA 保存在 [来源索引](source-index.json)。本报告不包含 SDK 或矢量瓦片分发包。

百度地图截图为真实生产应用中的标准百度底图，截图内保留百度原标识与数据归属；底图版权和数据归属按截图供应方标注。报告的业务要素为测试生成的合成点/线/矩形。截图未经图像生成或编辑。

图表来自测量聚合的原 matplotlib 输出。原始图文件 SHA 与分析器 SHA 见 [source-index.json](source-index.json)。
