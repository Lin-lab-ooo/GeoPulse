"""Shared static chart layout. Values are measured; no benchmark is performed."""
from __future__ import annotations
import hashlib
import math
import statistics
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager, ticker

PALETTE = {
    'base': '#8896A8', 'geopulse-current': '#0D8C85',
    'geopulse-hybrid': '#59ACA3', 'current': '#0D8C85', 'hybrid': '#59ACA3',
    'deck': '#4F72C7', 'maplibre': '#C78643',
    'full': '#4F72C7', 'minimal': '#8CA0BB', 'startup': '#8CA0BB'
}
INK = '#172B42'
MUTED = '#64758A'
GRID = '#E7ECF2'


def setup():
    preferred = ['Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'SimHei', 'DejaVu Sans']
    available = {f.name for f in font_manager.fontManager.ttflist}
    selected = next((f for f in preferred if f in available), 'DejaVu Sans')
    plt.rcParams.update({
        'font.family': selected, 'font.size': 11, 'axes.unicode_minus': False,
        'axes.edgecolor': GRID, 'axes.labelcolor': MUTED, 'text.color': INK,
        'xtick.color': MUTED, 'ytick.color': INK, 'figure.facecolor': 'white',
        'axes.facecolor': 'white', 'svg.fonttype': 'path', 'svg.hashsalt': 'geopulse-design-20261015',
        'savefig.facecolor': 'white', 'savefig.dpi': 180,
    })
    return selected


FONT = setup()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def wrap_text(value, width=106):
    """Wrap by approximate display width, including Chinese, without dropping notes."""
    lines = []
    for paragraph in str(value).split('\n'):
        current = ''; used = 0
        for ch in paragraph:
            weight = 2 if ord(ch) > 127 else 1
            if used + weight > width:
                lines.append(current); current = ''; used = 0
            current += ch; used += weight
        lines.append(current)
    return '\n'.join(lines)


def value_text(value):
    if value is None: return '未测得'
    if value >= 100: return f'{value:,.1f}'
    if value >= 10: return f'{value:.2f}'
    return f'{value:.3f}'


def validate_stats(stats, name):
    """Retain nulls and check repeat aggregates against their published trial scalars."""
    if stats is None:
        return {'metric': name, 'available': False, 'status': 'unavailable'}
    values = stats.get('rawPerTrialValues', [])
    values = [v for v in values if v is not None]
    if not values:
        if stats.get('median') is not None:
            raise ValueError(name + ': finite median requires original trial values')
        return {'metric': name, 'available': False, 'status': 'unavailable'}
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        raise ValueError(name + ': invalid trial scalar')
    if stats.get('n') != len(values):
        raise ValueError(name + ': n does not match retained trial values')
    expected = {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
    for key, computed in expected.items():
        actual = stats.get(key)
        if actual is None or not math.isclose(actual, computed, rel_tol=1e-10, abs_tol=1e-8):
            raise ValueError(name + ': ' + key + ' mismatch')
    return {'metric': name, 'available': True, 'n': len(values), **expected,
            'rawPerTrialValues': values, 'status': 'verified'}


def color(row):
    return row.get('color') or PALETTE.get(row.get('engine', row.get('colorKey', 'base')), PALETTE['base'])


def frame(title, subtitle, notes, row_count=3, curve=False):
    note_lines = wrap_text('\n'.join(notes or []), 124)
    bottom_height = 1.0 + .23 * max(1, len(note_lines.splitlines()))
    body_height = max(2.65, row_count * .48) if not curve else 3.9
    height = 1.5 + body_height + bottom_height
    fig = plt.figure(figsize=(12.0, height))
    top_height = 1.3
    left = .235 if not curve else .095
    right = .815 if not curve else .953
    ax = fig.add_axes([left, bottom_height / height, right-left, body_height / height])
    fig.text(.055, 1-.25/height, 'GEOPULSE  /  整图性能实验', fontsize=9.3,
             color=MUTED, weight='medium', va='top')
    fig.text(.055, 1-.52/height, title, fontsize=20, weight='bold', va='top')
    fig.text(.055, 1-.99/height, wrap_text(subtitle, 123), fontsize=10.6,
             color=MUTED, va='top', linespacing=1.55)
    fig.add_artist(plt.Line2D([.055,.953], [1-top_height/height,1-top_height/height],
                             transform=fig.transFigure, color=GRID, lw=1))
    fig.text(.055, .21/height, note_lines, fontsize=9.3, color=MUTED,
             va='bottom', linespacing=1.65)
    for spine in ax.spines.values(): spine.set_visible(False)
    ax.tick_params(axis='both', length=0, pad=9)
    ax.set_axisbelow(True)
    ax.grid(axis='x' if not curve else 'y', color=GRID, lw=.8)
    return fig, ax


def save(fig, outdir, slug):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    files = []
    for extension in ['png', 'svg']:
        target = outdir / f'{slug}.{extension}'
        if target.exists():
            raise FileExistsError('Use a fresh output directory; refusing to replace ' + target.name)
        metadata = {'Date': None} if extension == 'svg' else None
        fig.savefig(target, dpi=180, metadata=metadata)
        files.append({'file': target.name, 'sha256': sha(target), 'bytes': target.stat().st_size})
    plt.close(fig)
    return files


def render_chart(outdir, slug, title, subtitle, rows, unit='ms', notes=None, log=False):
    """Horizontal single-metric interval plot; dots are individual trials, ring is median."""
    checks = [validate_stats(r.get('stats'), r['label']) for r in rows]
    default_notes = ['圆点：每次实测；空心标记：重复中位数；横线：最小–最大。不同方案的完成条件见对应说明。']
    fig, ax = frame(title, subtitle, notes if notes is not None else default_notes, len(rows))
    valid_values = [v for c in checks if c['available'] for v in c['rawPerTrialValues']]
    if not valid_values: valid_values = [1.0]
    top = max(valid_values)
    positive = [v for v in valid_values if v > 0]
    if log:
        if len(positive) != len(valid_values):
            raise ValueError('Log axis requires positive measurements: ' + slug)
        ax.set_xscale('log')
        ax.set_xlim(min(positive) / 1.5, top * 1.3)
        ax.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f'{x:g}'))
        ax.xaxis.set_minor_locator(ticker.NullLocator())
    else:
        ax.set_xlim(0, top * 1.16 if top > 0 else 1)
        ax.xaxis.set_major_locator(ticker.MaxNLocator(nbins=5))
        ax.xaxis.set_major_formatter(ticker.StrMethodFormatter('{x:,.0f}' if top >= 100 else '{x:g}'))
    ax.set_ylim(-.7, len(rows)-.35)
    ax.invert_yaxis()
    ax.set_yticks(range(len(rows)), [wrap_text(r['label'], 31) for r in rows], fontsize=11)
    ax.set_xlabel(unit + (' · 对数刻度' if log else ''), fontsize=10.5, labelpad=12)
    height = fig.get_figheight()
    observed = [c for c in checks if c['available']]
    value_heading = '单次观测' if observed and all(c['n'] == 1 for c in observed) else '重复中位数'
    fig.text(.905, 1-1.27/height, value_heading + ' / ' + unit, color=MUTED,
             fontsize=9.3, ha='center', va='bottom')
    for i, (row, check) in enumerate(zip(rows, checks)):
        c = color(row)
        if check['available']:
            low, median, high = check['min'], check['median'], check['max']
            ax.hlines(i, low, high, color=c, linewidth=3.0, alpha=.7, zorder=3, clip_on=False)
            ax.vlines([low, high], i-.065, i+.065, color=c, linewidth=1.3, zorder=3, clip_on=False)
            offsets = np.linspace(-.11,.11, check['n']) if check['n'] > 1 else np.array([0.0])
            ax.scatter(check['rawPerTrialValues'], i+offsets, color=c, s=28,
                       alpha=.86, edgecolors='white', linewidths=.7, zorder=4, clip_on=False)
            ax.scatter([median], [i], facecolors='white', edgecolors=c, marker=row.get('marker', 'o'),
                       linewidths=2.2, s=95, zorder=5, clip_on=False)
            label = value_text(median)
        else:
            label = '未测得'
        ax.text(1.155, i, label, transform=ax.get_yaxis_transform(), fontsize=13,
                color=c if check['available'] else MUTED, ha='center', va='center',
                weight='bold' if check['available'] else 'normal', clip_on=False)
    files = save(fig, outdir, slug)
    return {'slug': slug, 'title': title, 'subtitle': subtitle, 'unit': unit,
            'axisScale': 'log' if log else 'linear', 'notes': notes or default_notes,
            'rows': rows, 'checks': checks, 'files': files, 'font': FONT}


def render_lines(outdir, slug, title, subtitle, series, unit='%', xunit='ms', notes=None,
                 log=False, xzero=True, yzero=True):
    fig, ax = frame(title, subtitle, notes or [], curve=True)
    for row in series:
        x, y = row['x'], row['y']
        if len(x) != len(y) or not x:
            raise ValueError(slug + ': invalid point counts')
        if any(not math.isfinite(v) for v in x+y):
            raise ValueError(slug + ': nonfinite curve values')
        ax.plot(x, y, label=row['label'], color=color(row), linewidth=2.1,
                alpha=.93, drawstyle=row.get('drawstyle','default'))
    if log: ax.set_xscale('log')
    if xzero and not log: ax.set_xlim(left=0)
    if yzero: ax.set_ylim(bottom=0)
    ax.set_xlabel(xunit + (' · 对数刻度' if log else ''), labelpad=10, fontsize=10.5)
    ax.set_ylabel(unit, labelpad=10, fontsize=10.5)
    ax.legend(loc='best', frameon=False, fontsize=10.2)
    files = save(fig, outdir, slug)
    return {'slug':slug,'title':title,'subtitle':subtitle,'unit':unit,'xunit':xunit,
            'notes':notes or [],'series':series,'files':files,'font':FONT,
            'curvePoints':sum(len(r['x']) for r in series),'axisScale':'log' if log else 'linear'}
