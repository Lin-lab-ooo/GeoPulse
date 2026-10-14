"""Build a new chart edition from frozen measured aggregates; never rerun a benchmark."""
from __future__ import annotations
import argparse
import hashlib
import html
import json
import re
from pathlib import Path
import charts_business
import charts_primary

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FAMILIES = {'matched': '共同策略与完成条件', 'updates': '已加载地图的位置更新',
            'baidu': '百度生产场景', 'primary': '默认策略与阶段归档'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_source(source):
    manifest = json.loads((source / 'manifest.report-files.json').read_text(encoding='utf-8'))
    for entry in manifest['files']:
        path = source / entry['file']
        if path.stat().st_size != entry['bytes'] or sha(path) != entry['sha256']:
            raise ValueError('Frozen source identity mismatch: ' + entry['file'])
    return sha(source / 'manifest.report-files.json')


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def docs_and_gallery(out, charts):
    pages = out / 'charts'
    pages.mkdir()
    for chart in charts:
        family, slug = chart['family'], chart['slug']
        folder = pages / family
        folder.mkdir(exist_ok=True)
        page = folder / (slug + '.md')
        png = next(f['file'] for f in chart['files'] if f['file'].endswith('.png'))
        svg = next(f['file'] for f in chart['files'] if f['file'].endswith('.svg'))
        chart['page'] = page.relative_to(out).as_posix()
        notes = '\n\n'.join(chart.get('notes', []))
        text = f"# {chart['title']}\n\n{chart['subtitle']}\n\n"
        text += f"![{chart['title']}](../../{png})\n\n"
        text += f"[PNG](../../{png}) · [SVG](../../{svg}) · [返回图表目录](../../README.md)\n\n{notes}\n\n"
        text += '数值来自 [2026-10-14 实测报告](../../../whole-map-2026-10-14/README.md)。'
        text += '本图仅重新排版，没有重新运行性能测试；精度、来源指针和三次原值见 [图表清单](../../chart-catalog.json)。\n'
        page.write_text(text, encoding='utf-8')
    index = '# GeoPulse 整图性能图表 · 2026-10-15 展示版\n\n'
    index += '本版将原分析图拆为独立主题，统一中文标题、配色、字号、数值栏和误差范围。'
    index += '全部数值取自 [2026-10-14 的已发布实测报告](../whole-map-2026-10-14/README.md)，原图和数据保留。'
    index += f'共有 {len(charts)} 张独立图，每张均提供 PNG 与 SVG；这是展示版更新，没有新增性能试验。\n\n'
    index += '[逐张浏览画廊](index.html) 可在下载仓库后直接用浏览器打开；代码托管页面按下面的单图链接阅读。每个单图页面只展示一张图。\n\n'
    index += '先看共同策略与位置更新，再看 CPU / GPU。三次散点和最小–最大范围不表示置信区间；'
    index += 'MapLibre 的原生合并与逐批确认合同分别展示，严格确认结果不能当作产品最大吞吐。'
    index += '百度为不同平台的单独验证；单次启动、已就绪底图后的业务流、CPU、GPU 和浏览器反馈分开计量。\n\n'
    for family, label in FAMILIES.items():
        index += f'## {label}\n\n| 单图主题 | PNG | SVG |\n| --- | --- | --- |\n'
        for chart in charts:
            if chart['family'] != family: continue
            png = next(f['file'] for f in chart['files'] if f['file'].endswith('.png'))
            svg = next(f['file'] for f in chart['files'] if f['file'].endswith('.svg'))
            index += f"| [{chart['title']}]({chart['page']}) | [查看]({png}) | [下载]({svg}) |\n"
        index += '\n'
    index += '## 来源与复现\n\n'
    index += '[精度和主题覆盖核验](verification.json) · [文件校验清单](manifest.json) · '
    index += '[原始数值证据](../whole-map-2026-10-14/measurements/README-evidence.md) · '
    index += '[重画命令](../../tools/whole-map-report-design/README.md)。\n\n'
    index += '没有根据局部时间估算整张地图 FPS；物理显示帧率保持未测。'
    index += '缺测不填零，阶段间重叠不相加，有限样本不作为全面领先证据。\n'
    (out / 'README.md').write_text(index, encoding='utf-8')
    template = (HERE / 'gallery-template.html').read_text(encoding='utf-8')
    gallery_charts = [{k: c[k] for k in ['family','slug','title','subtitle','unit','notes','files','page']} for c in charts]
    embedded = json.dumps(gallery_charts, ensure_ascii=False).replace('<', '\\u003c')
    (out / 'index.html').write_text(template.replace('__CHARTS__', embedded), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=REPO / 'reports/whole-map-2026-10-14')
    parser.add_argument('--out', type=Path, required=True, help='New directory outside the frozen source package')
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    if out.exists() or out == source or source in out.parents:
        parser.error('Choose a new output directory outside the frozen source')
    source_manifest = verify_source(source)
    out.mkdir(parents=True)
    business, business_audit = charts_business.render_all(source, out)
    primary, primary_audit = charts_primary.render_all(source, out)
    charts = business + primary
    for chart in charts:
        chart['family'] = chart.get('family', chart.get('group', 'primary'))
        if not re.fullmatch('[a-z0-9-]+', chart['slug']): raise ValueError('Unsafe chart slug')
        for file in chart['files']:
            if not file['file'].startswith('figures/'):
                file['file'] = 'figures/' + chart['family'] + '/' + file['file']
            if sha(out / file['file']) != file['sha256']: raise ValueError('Output SHA mismatch')
    covered = {family: sorted({c['oldFigure'] for c in charts if c['family'] == family}) for family in FAMILIES}
    assert sum(len(v) for v in covered.values()) == 22, 'Every original chart topic must remain covered'
    docs_and_gallery(out, charts)
    write_json(out / 'chart-catalog.json', {'schema':'geopulse/chart-design-catalog-1.0',
        'staticReplotOnly':True, 'physicalFps':None, 'sourcePackage':'whole-map-2026-10-14', 'charts':charts})
    write_json(out / 'verification.json', {'schema':'geopulse/chart-design-verification-1.0',
        'staticReplotOnly':True, 'newBenchmarkTrials':0, 'originalTopicsCovered':covered,
        'sourceManifestSha256':source_manifest, 'sourceManifestBeforeAfterEqual':verify_source(source)==source_manifest,
        'chartCount':len(charts), 'businessMetricChecks':business_audit['metricChecks'],
        'primaryMetricChecks':primary_audit['metricChecks'], 'physicalFps':None,
        'generatorFiles':[{'file':p.name,'sha256':sha(p)} for p in sorted(HERE.glob('*')) if p.is_file()]})
    files = [{'file':p.relative_to(out).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)}
             for p in sorted(out.rglob('*')) if p.is_file()]
    write_json(out / 'manifest.json', {'schema':'geopulse/chart-design-files-1.0',
        'scope':'All edition files except this manifest', 'fileCount':len(files),
        'totalBytes':sum(p['bytes'] for p in files), 'files':files})
    print(json.dumps({'charts':len(charts),'pngSvgFiles':sum(len(c['files']) for c in charts),
        'originalTopics':sum(len(v) for v in covered.values()), 'sourceUnchanged':True}, ensure_ascii=False))


if __name__ == '__main__': main()
