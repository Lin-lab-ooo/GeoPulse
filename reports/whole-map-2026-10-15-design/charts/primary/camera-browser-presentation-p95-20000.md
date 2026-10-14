# 相机交互：浏览器呈现反馈间隔 P95

20,000 点配置 · 同一真实底图 / MapLibre context · current、deck、source 固定 2048；hybrid 2048→8192

![相机交互：浏览器呈现反馈间隔 P95](../../figures/primary/camera-browser-presentation-p95-20000.png)

[PNG](../../figures/primary/camera-browser-presentation-p95-20000.png) · [SVG](../../figures/primary/camera-browser-presentation-p95-20000.svg) · [返回图表目录](../../README.md)

圆点为三次重复；空心标记为重复中位数；横线为完整最小–最大范围。

所有数值来自冻结的整图测量，没有运行新的测试。

纯底图业务为 0；20,000 仅为共同配置标签。

目标 renderer + authored phase anchors 精确切窗；呈现终点配对后去重。

浏览器 feedback 不是物理 scanout，PARTIAL 不保证每个业务 revision 完整显示。

数值来自 [2026-10-14 实测报告](../../../whole-map-2026-10-14/README.md)。本图仅重新排版，没有重新运行性能测试；精度、来源指针和三次原值见 [图表清单](../../chart-catalog.json)。
