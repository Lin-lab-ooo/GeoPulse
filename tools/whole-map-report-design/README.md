# 整图性能图表重画

将已发布的实测聚合重新排版为单主题图，并生成逐张阅读的 Markdown 页面与本地 HTML 画廊。输入为 `reports/whole-map-2026-10-14`；原报告、原图和测量数据保持字节不变。本工具不运行地图、网络请求或性能测试。

```sh
python -m pip install matplotlib numpy
python tools/whole-map-report-design/build.py --out /tmp/geopulse-chart-edition-new
```

Windows 将输出改为一个尚不存在的目录，例如 `--out "$env:TEMP/geopulse-chart-edition-new"`。打开输出中的 `index.html` 即可逐张浏览。GitHub/Gitee 阅读输出 `README.md` 的单图链接；代码托管页面不会直接运行 HTML。

工具首先核对原报告清单中的全部文件 SHA，检查各指标的每次原值与重复中位数、最小–最大，并在结束时再次确认原报告未变化。输出包含 PNG、SVG、每张图的说明、来源指针、主题覆盖记录和文件 SHA 清单。缺测保持缺测，单次启动观测和三次重复分开，CPU / GPU / 等待与不同提交合同不混合。

中文字体优先使用系统的 Microsoft YaHei、Noto Sans CJK SC 或 Source Han Sans SC。字体不存在时应先安装合适的 CJK 字体；发布前需要目视检查文字。字体文件不包含在仓库中。
