"""Validate source geometry and generate atlas-composite inspection PNGs.

These are CPU composites of the shipped atlas, not browser screenshots.
Scene constants are read from the preview itself to avoid a second sample map.
"""
import ast
import json
import math
from pathlib import Path
import re
import sys

from pngio import read_png,write_png
sys.path.insert(0,str(Path(__file__).resolve().parent/"blender"))
from geometry import ASSETS, PALETTE, ELEVATION, AZIMUTH, ORTHO_SCALE, asset, wall

ROOT=Path(__file__).resolve().parent

def resized(pixels,width,size):
    """Integer area reduction, with premultiplied colour at transparent edges."""
    factor=width//size
    if factor==1: return pixels
    assert size*factor==width
    out=bytearray(size*size*4)
    for y in range(size):
        for x in range(size):
            ids=[((y*factor+dy)*width+x*factor+dx)*4 for dy in range(factor) for dx in range(factor)]
            total=sum(pixels[i+3] for i in ids); dest=(y*size+x)*4
            if total:
                for k in range(3): out[dest+k]=round(sum(pixels[i+k]*pixels[i+3] for i in ids)/total)
            out[dest+3]=round(total/(factor*factor))
    return out

def composite(dest,width,height,source,size,x,y):
    x,y=round(x-size/2),round(y-size/2)
    for sy in range(size):
        if not 0<=y+sy<height: continue
        for sx in range(size):
            if not 0<=x+sx<width: continue
            a=(sy*size+sx)*4; b=((y+sy)*width+x+sx)*4; alpha=source[a+3]/255
            if not alpha: continue
            for k in range(3): dest[b+k]=round(source[a+k]*alpha+dest[b+k]*(1-alpha))

def main():
    atlas_path=ROOT.parent/"public/assets/siege"
    data=json.loads((atlas_path/"atlas.json").read_text())
    aw,ah,atlas=read_png(atlas_path/"atlas.png")
    assert [aw,ah]==[data["meta"]["size"]["w"],data["meta"]["size"]["h"]]
    # A palette band must be equally bright across material hues.
    luma={}
    for family,ramp in PALETTE.items():
        values=[]
        for colour,target in zip(ramp,(32,76,142,206)):
            rgb=[int(colour[i:i+2],16) for i in (1,3,5)]
            value=sum(a*b for a,b in zip(rgb,(.299,.587,.114)))
            assert abs(value-target)<2,(family,colour,value,target)
            values.append(round(value,3))
        luma[family]=values
    # Geometry must hit the join boundary exactly, with the right mask bit.
    for mask in range(16):
        body=wall(mask)[0].vertices
        for axis,sign,bit in ((1,1,1),(1,-1,2),(0,-1,4),(0,1,8)):
            extent=max(sign*v[axis] for v in body)
            assert math.isclose(extent,.5 if mask&bit else .22), (mask,bit,extent)
    sprites={}; bounds={}
    el,az=math.radians(ELEVATION),math.radians(AZIMUTH)
    for name in ASSETS:
        w,h,pixels=read_png(ROOT/"renders"/f"{name}.png"); sprites[name]=pixels
        rect=data["frames"][name]["frame"]
        for row in range(128):
            a=((rect["y"]+row)*aw+rect["x"])*4
            assert atlas[a:a+128*4]==pixels[row*128*4:(row+1)*128*4], name
        points=[]
        for mesh in asset(name):
            for x,y,z in mesh.vertices:
                px=64+(-math.sin(az)*x+math.cos(az)*y)*128/ORTHO_SCALE
                py=64-(-math.sin(el)*math.cos(az)*x-math.sin(el)*math.sin(az)*y+math.cos(el)*z)*128/ORTHO_SCALE
                points.append((px,py))
        limits=[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]
        assert all(-1e-7<=v<=128+1e-7 for v in limits),(name,"clipped",limits)
        bounds[name]=[round(v,3) for v in limits]
    assert len({bytes(sprites[f"wall-{i:02d}"]) for i in range(16)})==16
    tide_alpha=sprites["enemy-tide"][3::4]
    assert any(145<a<180 for a in tide_alpha),"Tide lost its translucent interior"
    preview=(ROOT.parent/"public/art-preview.html").read_text()
    def constant(name): return ast.literal_eval(re.search(rf"const {name} = (.*);",preview).group(1))
    rows=constant("ROWS"); gates=constant("GATES"); raiders=constant("RAIDERS")
    tide=constant("TIDE"); targets=constant("TARGETS"); banners=constant("BANNERS")
    assert len(rows)==9 and all(len(row)==9 for row in rows)
    def walled(r,c): return 0<=r<9 and 0<=c<9 and rows[r][c]=="w"
    def mask(r,c): return sum(bit for dr,dc,bit in ((-1,0,1),(1,0,2),(0,-1,4),(0,1,8)) if walled(r+dr,c+dc))
    for scale,width,height,filename in ((.5,304,282,"board-phone.png"),(1,608,560,"board-1x.png"),(2,1216,1120,"board-2x.png")):
        size=int(64*scale); resized_sprites={name:resized(p,128,size) for name,p in sprites.items()}
        canvas=bytearray([27,32,38,255])*(width*height)
        def draw(name,r,c,raise_by=0):
            x=width/2+(c-r)*32*scale; y=(48+(c+r)*32*math.sin(math.pi/3)-raise_by)*scale
            composite(canvas,width,height,resized_sprites[name],size,x,y)
        for r in range(9):
            for c in range(9):
                name=("floor-courtyard-b" if (r+c)%3==0 else "floor-courtyard-a") if rows[r][c] in "ck" else "floor-stone"
                draw(name,r,c)
        for r,c in tide: draw("enemy-tide",r,c)
        objects=[]
        for r in range(9):
            for c in range(9):
                if walled(r,c): objects.append((r,c,f"wall-{mask(r,c):02d}",0))
                if rows[r][c]=="k": objects.append((r,c,"keep",0))
                if rows[r][c]=="r": objects.append((r,c,"ruin-b" if c%2 else "ruin-a",0))
        objects += [(r,c,f"gate-{d}",0) for r,c,d in gates]
        objects += [(r,c,"enemy-raider",0) for r,c in raiders]
        objects += [(r,c,f"banner-{owner}",5.66 if walled(r,c) else 0) for r,c,owner in banners]
        objects.sort(key=lambda a:(a[0]+a[1],a[1],a[3]))
        for r,c,name,raise_by in objects: draw(name,r,c,raise_by)
        for r,c in targets: draw("enemy-target",r,c)
        write_png(ROOT/"verification"/filename,width,height,canvas)
        if scale==.5:
            grey=bytearray(canvas)
            for i in range(0,len(grey),4):
                y=round(.299*grey[i]+.587*grey[i+1]+.114*grey[i+2]); grey[i:i+3]=bytes([y]*3)
            write_png(ROOT/"verification"/"board-phone-greyscale.png",width,height,grey)
    report={"checks":["all 16 join extents","16 distinct wall images","atlas regions match source PNG bytes","no projected mesh clipping","translucent tide interior","all hues within 2/255 of four luma bands","9x9 preview scene shape"],"luma":luma,"projected_bounds":bounds,"images":"CPU atlas composites, not browser screenshots"}
    (ROOT/"verification"/"geometry.json").write_text(json.dumps(report,indent=2)+"\n")
    print("Geometry, PNG regions, transparency, four value bands and atlas composites verified.")

if __name__=="__main__": main()
