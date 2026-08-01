#!/usr/bin/env python3
"""
LUT 偏好排序测试 · 构建期预渲染脚本（numpy 向量化版）

读 config.js 中的 32 个 LUT + 5 张基准图，输出：
  renders/{photoId}/{lutId}.jpg      (1000×667, q78)
  renders/{photoId}/_sm/{lutId}.jpg  (500×334,  q78)

G3 维护方式：
  1) 把新 .cube 放进 lut/（文件名见本文件 CUBE_FILE_MAP）
  2) 改 js/config.js 增删 LUT/photos/testId
  3) python3 tools/prerender.py
  4) git add renders/ && git commit && git push → Vercel 自动部署

依赖：Pillow, numpy
  pip3 install --user Pillow numpy
"""
import os, sys, re, time
from pathlib import Path
from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
LUT_DIR = ROOT / 'lut'
PHOTO_DIR = ROOT / 'photos'
RENDER_DIR = ROOT / 'renders'
CONFIG_JS = ROOT / 'js' / 'config.js'

# 显示名 → 实际 cube 文件路径（与 js/config.js 的 displayName 对应）
CUBE_FILE_MAP = {
    '人像琥珀提亮': 'classic/人像琥珀提亮.cube',
    '奥林帕斯': 'classic/奥林帕斯.cube',
    '富士NN': 'classic/富士NN.cube',
    '日系1996': 'classic/日系1996-f.cube',
    '柏林之冬': 'classic/柏林之冬.cube',
    '柯达金': 'classic/柯达金.cube',
    '港味': 'classic/港味-f.cube',
    '黑白纪实': 'classic/黑白纪实.cube',
    '低饱和蓝晒': 'colors/低饱和蓝晒.cube',
    '彩色反转T64': 'colors/彩色反转T64.cube',
    '彩色负片100T': 'colors/彩色负片100T.cube',
    '彩色负片': 'colors/彩色负片.cube',
    '摩卡': 'colors/摩卡-f.cube',
    '灰绿色调': 'colors/灰绿色调-f.cube',
    '蓝晒': 'colors/蓝晒-f.cube',
    '蓝调时光': 'colors/蓝调时光-f.cube',
    '蓝调空间': 'colors/蓝调空间.cube',
    '回忆录': 'retro/回忆录-f.cube',
    '复古风': 'retro/复古风.cube',
    '怀旧绿': 'retro/怀旧绿-f.cube',
    '黑白老照片 1': 'retro/黑白老照片 1.cube',
    '黑白老照片 2': 'retro/黑白老照片 2.cube',
    '交叉冲洗': 'lab/交叉冲洗.cube',
    '岛屿青雾': 'lab/岛屿青雾-f.cube',
    '漂白旁路': 'lab/漂白旁路.cube',
    '花束暖调': 'lab/花束暖调-f.cube',
    '千禧电影': 'movie/千禧电影.cube',
    '电影感': 'movie/电影感.cube',
    '重庆森林': 'movie/重庆森林.cube',
    '重庆森林 (f)': 'movie/重庆森林-f.cube',
    '霸王别姬·红': 'movie/霸王别姬-红.cube',
    '霸王别姬·蓝': 'movie/霸王别姬-蓝.cube',
}

# ----------- LUT 解析 -----------

def parse_cube(path):
    """返回 (size, flat_rgb_array，长度 size**3 * 3)"""
    size = None
    rgb = []
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'): continue
            m = re.match(r'LUT_3D_SIZE\s+(\d+)', line)
            if m: size = int(m.group(1)); continue
            if line.startswith('TITLE') or line.startswith('DOMAIN'): continue
            parts = line.split()
            if len(parts) == 3:
                try:
                    rgb.append(float(parts[0]))
                    rgb.append(float(parts[1]))
                    rgb.append(float(parts[2]))
                except ValueError: continue
    if size is None: raise RuntimeError(f'LUT_3D_SIZE 未找到: {path}')
    expected = size ** 3 * 3
    if len(rgb) < expected:
        raise RuntimeError(f'{path} 数据不足：期望 {expected}，实际 {len(rgb)}')
    flat = rgb[:expected]
    # 0..255 域 → 0..1
    if max(flat) > 1.5:
        flat = [v / 255.0 for v in flat]
    arr = np.asarray(flat, dtype=np.float32).reshape(size, size, size, 3)
    # .cube 文件数据排列为 Blue 最快变化、Red 最慢，但 numpy reshape 默认按
    # (R,G,B) 轴填充。交换 R(0) 与 B(2) 轴，使 lut[r,g,b,ch] 正确对应输入 (R,G,B)，
    # 否则会出现红蓝通道互换、整体偏蓝的问题。
    arr = arr.transpose(2, 1, 0, 3)
    return size, arr

# ----------- 渲染（向量化三线性插值） -----------

def apply_lut_vectorized(img_arr, lut):
    """img_arr: HxWx3 float32 in [0,1]; lut: NxNxNx3 float32 in [0,1]"""
    n = lut.shape[0]
    c = np.clip(img_arr, 0.0, 1.0)
    idx = c * (n - 1)
    i0 = np.floor(idx).astype(np.int32)
    i1 = np.minimum(i0 + 1, n - 1)
    t = idx - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    r1, g1, b1 = i1[..., 0], i1[..., 1], i1[..., 2]
    tr, tg, tb = t[..., 0], t[..., 1], t[..., 2]
    out = np.empty_like(c)
    for ch in range(3):
        c000 = lut[r0, g0, b0, ch]
        c100 = lut[r1, g0, b0, ch]
        c010 = lut[r0, g1, b0, ch]
        c110 = lut[r1, g1, b0, ch]
        c001 = lut[r0, g0, b1, ch]
        c101 = lut[r1, g0, b1, ch]
        c011 = lut[r0, g1, b1, ch]
        c111 = lut[r1, g1, b1, ch]
        c00 = c000 * (1 - tr) + c100 * tr
        c10 = c010 * (1 - tr) + c110 * tr
        c01 = c001 * (1 - tr) + c101 * tr
        c11 = c011 * (1 - tr) + c111 * tr
        c0 = c00 * (1 - tg) + c10 * tg
        c1 = c01 * (1 - tg) + c11 * tg
        out[..., ch] = c0 * (1 - tb) + c1 * tb
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)

def render_one(photo_path, lut_path, out_lg, out_sm):
    LG = (1000, 667); SM = (500, 334)
    img = Image.open(photo_path).convert('RGB').resize(LG, Image.LANCZOS)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    size, lut = parse_cube(lut_path)
    out = apply_lut_vectorized(arr, lut)
    img_out = Image.fromarray(out, 'RGB')
    out_lg.parent.mkdir(parents=True, exist_ok=True)
    out_sm.parent.mkdir(parents=True, exist_ok=True)
    img_out.save(out_lg, 'JPEG', quality=78, optimize=True, progressive=True)
    img_out.resize(SM, Image.LANCZOS).save(out_sm, 'JPEG', quality=78, optimize=True, progressive=True)

def extract_photo_ids():
    txt = CONFIG_JS.read_text(encoding='utf-8')
    # 抓 photos 里 id: 'xxx'
    return re.findall(r"id:\s*'(\w+)'", txt)[:5]

def main():
    if not LUT_DIR.exists(): sys.exit(f'lut 目录不存在: {LUT_DIR}')
    if not PHOTO_DIR.exists(): sys.exit(f'photos 目录不存在: {PHOTO_DIR}')
    displays = list(CUBE_FILE_MAP.keys())
    photo_ids = extract_photo_ids()
    if not photo_ids: sys.exit('未能从 config.js 提取 photo id')
    total = len(displays) * len(photo_ids)
    print(f'将渲染 {total} 张 ({len(displays)} LUT × {len(photo_ids)} photo) × 2 尺寸 = {total*2} 张 JPG')
    start = time.time()
    done = 0
    for pi in photo_ids:
        photo_path = PHOTO_DIR / f'{pi}.jpg'
        if not photo_path.exists():
            print(f'!! 缺基准图 {photo_path}，跳过'); continue
        for di, disp in enumerate(displays):
            cube_rel = CUBE_FILE_MAP[disp]
            lut_path = LUT_DIR / cube_rel
            if not lut_path.exists():
                print(f'!! 缺 LUT {lut_path}，跳过'); continue
            lut_id = f'l{di+1:02d}'
            out_lg = RENDER_DIR / pi / f'{lut_id}.jpg'
            out_sm = RENDER_DIR / pi / '_sm' / f'{lut_id}.jpg'
            t0 = time.time()
            try:
                render_one(photo_path, lut_path, out_lg, out_sm)
                done += 1
                if done % 20 == 0 or done == total:
                    print(f'  [{done}/{total}] {pi}/{lut_id} ({time.time()-t0:.2f}s)')
            except Exception as e:
                print(f'!! 失败 {pi}/{lut_id}: {e}')
    print(f'完成 {done}/{total}，用时 {time.time()-start:.1f}s')

if __name__ == '__main__':
    main()