# 可选浏览器复现

`npm test` 只运行核心 Node 测试。本文的浏览器工具独立运行，会启动自己的本地 HTTP 服务和单个 Chromium 页面；请串行运行，避免其他图形负载干扰结果。

## 安装与环境

本工具使用 Playwright Library。可在仓库根目录临时安装，不修改项目依赖声明：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

浏览器安装方式见 [Playwright 官方文档](https://playwright.dev/docs/library#usage)。应用启动和核心测试仍无需 Playwright。

如果已经安装，可通过 `PLAYWRIGHT_MODULE` 指定 Playwright 的模块入口文件，通过 `BROWSER_EXECUTABLE` 指定兼容 Chromium 的可执行文件；对应命令行选项为 `--playwright=...` 与 `--browser=...`。默认使用包解析和 Playwright 管理的 Chromium。这些路径由操作者本机配置，不写进仓库。

工具要求可用的原生 GPU，拒绝把 SwiftShader/llvmpipe 软件栅格器当作本机 GPU 结果。因此普通云 CI 不等同于此项验证。每次报告记录实际浏览器、图形信息与运行时指纹；跨机器耗时不能直接等同。

## 先验证正确性

```sh
node tools/chain-quality-browser-2.6.mjs --phase=quality
```

默认依次运行五种组合。使用独立标量几何模型核对全部 CPU 槽位的位置、RGBA、ID 和完整图元，并在两种视图下通过 `readPixels` 逐字节比较 RGBA。当前工具没有逐缓冲上传镜像核对；几何槽位检查不能单独证明每次 GPU 写入正确。像素参照使用当前着色器和关闭空间选择的规范数据，不能证明着色器本身完全正确。

链路包含混合 NDJSON、UTF-8 跨片、加载中修改、后续同 ID 追加、删除恢复、图层切换、取消后立即新 run、HTTP 503、数量不足、非法记录、坏 JSON，以及真实 UI 导出和服务器保存内容对账。移动和颜色修改只作用于已有绑定；后续同 ID 追加保留新输入，删除墓碑继续作用于追加。

扩大到 100000 条质量材料，可让各图元类型跨越更多存储页：

```sh
node tools/chain-quality-browser-2.6.mjs --phase=quality --quality-count=100000 --variants=current,hybrid,large,hybridBounds
```

## 组合与性能

| 选项名 | 实验设置 |
| --- | --- |
| `reference` | 固定 2048；关闭空间查询/空间拾取；位置脏范围 ranges；连续绘制 |
| `current` | 固定 2048；当前生产优化设置；按需绘制 |
| `hybrid` | 首批 2048，之后 8192；其余同 current |
| `large` | 固定 8192；其余同 current |
| `hybridBounds` | hybrid，加 liveBounds 和 movedFilter |

全部锁定 LOD=1、保留告警、相同可见图层与画布尺寸。`reference` 同时改变多项设置；整体比较不能拆成某一个优化的单独因果收益。研究 hook 仅附加到该工具服务的应用脚本，调整实际 Worker 的批次参数，生产文件保持原样。正式默认仍是固定 2048。

```sh
node tools/chain-quality-browser-2.6.mjs --phase=performance --variants=reference,current,hybrid,large,hybridBounds --sizes=100000,1000000 --repeats=3 --compression=alternate --delay=0
```

`--compression` 接受 `identity`、`gzip` 或按重复轮交替的 `alternate`。`--delay` 是合成源写入节拍，单位毫秒；它不是实际互联网延迟分布。性能阶段核对最终 CPU 几何摘要、计数、ACK、交互和导出，但不重复质量阶段的独立全槽/全 RGBA oracle。先通过质量再解释速度。

如需百度底图，把自己的浏览器端 AK 放入 `GEOPULSE_BAIDU_AK` 环境变量，来源白名单覆盖工具使用的本地地址，然后追加 `--sdk`。例如在已经配置该环境变量的终端运行：

```sh
node tools/chain-quality-browser-2.6.mjs --phase=performance --sdk --variants=current,hybrid,large,hybridBounds --sizes=100000 --repeats=3 --compression=identity --delay=8
```

工具只加载百度底图，拦截地点检索，不调用 LocalSearch。业务数据仍是合成数据；SDK 服务访问受个人账号配置约束。不要把 AK 写入命令参数、文档或提交记录。普通 SDK 加载不覆盖已知的强制 context loss 后页面 reload 问题。

## 输出与边界

默认输出名含时间戳，也可指定全新的 `--stem=my-chain-run`。同名报告已存在时拒绝覆盖。报告、实际导出、工具快照和本机截图保存在 `reports/`，默认不提交 Git。报告可能包含本机路径和运行环境，公开时应生成带原件 SHA 的衍生摘要，保留原始失败。

每次只有 `passed: true` 且全部预定检查完成才算该协议通过。首屏、完成时间、批次确认、CPU 更新、点击和帧时间分别解释；不能把上传 ACK 当作 GPU 完成，也不能把局部 CPU 或 GPU 耗时换算为整个百度地图 FPS。
