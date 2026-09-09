#!/usr/bin/env python3
"""Pack/validate the siege atlas with no third-party packages.

Run with Blender's bundled Python or any Python >=3.10. No rotation, trimming
or resampling. Two extruded texels and a two-texel gutter prevent bleed.
sample-board.png is a review composite, not a gameplay atlas frame.
"""
import hashlib
import json
import math
from pathlib import Path
import sys

from pngio import read_png,write_png
sys.path.insert(0,str(Path(__file__).resolve().parent/"blender"))
from geometry import ASSETS

def main():
    root=Path(__file__).resolve().parent; source=root/"renders"
    dest=root.parent/"public"/"assets"/"siege"; dest.mkdir(parents=True,exist_ok=True)
    report=json.loads((source/"render-manifest.json").read_text())
    if report["frames"]!=ASSETS: raise ValueError("Render manifest does not match geometry asset contract")
    found={p.stem for p in source.glob("*.png") if p.stem!="sample-board"}
    if found!=set(ASSETS): raise ValueError(f"Stale/missing PNGs: {found ^ set(ASSETS)}")
    tile=128; pad=2; gutter=2; step=tile+pad*2+gutter; columns=8
    width=columns*step; height=math.ceil(len(ASSETS)/columns)*step
    atlas=bytearray(width*height*4); frames={}; hashes={}
    for i,name in enumerate(ASSETS):
        path=source/f"{name}.png"; w,h,pixels=read_png(path)
        if (w,h)!=(tile,tile): raise ValueError(f"Wrong frame size: {name} {w}x{h}")
        alphas=pixels[3::4]
        if not any(alphas) or not any(a==0 for a in alphas): raise ValueError(f"Empty/non-transparent asset: {name}")
        x,y=(i%columns)*step+pad,(i//columns)*step+pad
        for dy in range(-pad,tile+pad):
            for dx in range(-pad,tile+pad):
                a=(min(tile-1,max(0,dy))*tile+min(tile-1,max(0,dx)))*4
                b=((y+dy)*width+x+dx)*4
                atlas[b:b+4]=pixels[a:a+4]
        frames[name]={"frame":{"x":x,"y":y,"w":w,"h":h},"rotated":False,"trimmed":False,
                      "spriteSourceSize":{"x":0,"y":0,"w":w,"h":h},"sourceSize":{"w":w,"h":h},"anchor":{"x":.5,"y":.5}}
        hashes[name]=hashlib.sha256(path.read_bytes()).hexdigest()
    data={"frames":frames,"meta":{"app":"ENCLAVE procedural siege kit","version":"1.0","image":"atlas.png",
          "format":"RGBA8888","size":{"w":width,"h":height},"scale":"2"},
          "enclave":{"engine":report["engine"],"cellUnit":1,"cellPixels":64,"elevation":60,"azimuth":-45,
                     "joinBits":{"up":1,"down":2,"left":4,"right":8},"enemyArt":"provisional"}}
    write_png(dest/"atlas.png",width,height,atlas)
    (dest/"atlas.json").write_text(json.dumps(data,indent=2)+"\n")
    size=(dest/"atlas.png").stat().st_size
    if size>=2_000_000: raise ValueError(f"Atlas exceeds 2 MB: {size}")
    aw,ah,check=read_png(dest/"atlas.png")
    if (aw,ah)!=(width,height) or check!=atlas: raise ValueError("Atlas PNG round trip failed")
    verification={"engine":report["engine"],"render_seconds":report["render_seconds"],"frame_count":len(frames),
                  "atlas_bytes":size,"atlas_dimensions":[width,height],"atlas_sha256":hashlib.sha256((dest/"atlas.png").read_bytes()).hexdigest(),
                  "source_sha256":hashes,"checks":["all source frames present","128x128 RGBA","nonempty with transparency","PNG CRC and lossless round trip","under 2 MB","untrimmed center anchors","meta.scale string 2"]}
    (root/"verification"/"pipeline.json").write_text(json.dumps(verification,indent=2)+"\n")
    print(f"Packed {len(frames)} frames: {width}x{height}, {size:,} bytes ({size/1024:.1f} KiB); engine={report['engine']}")

if __name__=="__main__": main()
