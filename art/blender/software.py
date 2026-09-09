"""Explicit CPU fallback when a sandbox cannot initialise Blender's GPU.

Rasterises exactly the source meshes, camera and four face-value bands used by
kit.py. This is a deliverable preview, NOT evidence that EEVEE was executed.
Opaque surfaces use a z-buffer; translucent meshes use sorted alpha blending.
2x supersampling averages premultiplied colour, avoiding black alpha fringes.
"""
import argparse
import json
import math
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from pngio import write_png
from geometry import ASSETS, ELEVATION, AZIMUTH, ORTHO_SCALE, asset, sample_board, face_colour

def cross(a,b,c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])

def triangles(points):
    """Ear-clipping preserves notched flags and concave chevrons."""
    ids=list(range(len(points)))
    area=sum(points[i][0]*points[(i+1)%len(points)][1]-points[(i+1)%len(points)][0]*points[i][1] for i in ids)
    if abs(area)<1e-9: return
    if area<0: ids.reverse()
    while len(ids)>3:
        for j in range(len(ids)):
            a,b,c=ids[j-1],ids[j],ids[(j+1)%len(ids)]
            if cross(points[a],points[b],points[c])<=1e-9: continue
            if any(all(v>=-1e-9 for v in (cross(points[a],points[b],points[k]),cross(points[b],points[c],points[k]),cross(points[c],points[a],points[k]))) for k in ids if k not in (a,b,c)):
                continue
            yield points[a],points[b],points[c]
            ids.pop(j)
            break
        else: raise ValueError("Cannot triangulate source polygon")
    yield tuple(points[i] for i in ids)

def render(meshes,size=128,ortho=ORTHO_SCALE,aa=2):
    n=size*aa; pixels=bytearray(n*n*4); depth=[-math.inf]*(n*n)
    el,az=math.radians(ELEVATION),math.radians(AZIMUTH)
    right=(-math.sin(az),math.cos(az),0)
    up=(-math.sin(el)*math.cos(az),-math.sin(el)*math.sin(az),math.cos(el))
    view=(math.cos(el)*math.cos(az),math.cos(el)*math.sin(az),math.sin(el))
    def project(v):
        return (n/2+sum(a*b for a,b in zip(v,right))*n/ortho,
                n/2-sum(a*b for a,b in zip(v,up))*n/ortho,
                sum(a*b for a,b in zip(v,view)))
    faces=[]
    for mesh in meshes:
        points=[project(v) for v in mesh.vertices]
        for face in mesh.faces:
            colour=face_colour(mesh,face)
            for tri in triangles([points[i] for i in face]):
                faces.append((sum(v[2] for v in tri)/3,tri,colour,mesh.alpha))
    faces.sort(key=lambda f:f[0])
    for _,(a,b,c),colour,alpha in faces:
        denominator=cross(a,b,c)
        if abs(denominator)<1e-9: continue
        if denominator<0: b,c=c,b; denominator=-denominator
        for y in range(max(0,int(min(a[1],b[1],c[1]))),min(n,math.ceil(max(a[1],b[1],c[1])))):
            for x in range(max(0,int(min(a[0],b[0],c[0]))),min(n,math.ceil(max(a[0],b[0],c[0])))):
                p=(x+.5,y+.5)
                w0,w1,w2=cross(b,c,p)/denominator,cross(c,a,p)/denominator,cross(a,b,p)/denominator
                if min(w0,w1,w2)<-1e-9: continue
                z=w0*a[2]+w1*b[2]+w2*c[2]; index=y*n+x; offset=index*4
                if z<depth[index]-1e-8: continue
                # Do not blend twice along the shared diagonal of a polygon.
                if alpha<1 and abs(z-depth[index])<1e-8: continue
                old_alpha=pixels[offset+3]/255
                new_alpha=alpha+old_alpha*(1-alpha)
                for k in range(3):
                    pixels[offset+k]=round((colour[k]*alpha+pixels[offset+k]*old_alpha*(1-alpha))/new_alpha)
                pixels[offset+3]=round(new_alpha*255); depth[index]=z
    result=bytearray(size*size*4)
    for y in range(size):
        for x in range(size):
            offsets=[((y*aa+dy)*n+x*aa+dx)*4 for dy in range(aa) for dx in range(aa)]
            total=sum(pixels[o+3] for o in offsets); dest=(y*size+x)*4
            if total:
                for k in range(3): result[dest+k]=round(sum(pixels[o+k]*pixels[o+3] for o in offsets)/total)
            result[dest+3]=round(total/(aa*aa))
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only",choices=ASSETS)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]; out=root/"renders"; out.mkdir(exist_ok=True)
    start=time.perf_counter(); names=[args.only] if args.only else ASSETS
    for name in names:
        write_png(out/f"{name}.png",128,128,render(asset(name)))
        print(f"CPU {name}",flush=True)
    if args.only: return
    write_png(out/"sample-board.png",384,384,render(sample_board(),384,ORTHO_SCALE*3.12))
    elapsed=time.perf_counter()-start
    report={"engine":"cpu-fallback","blender_render_verified":False,"render_seconds":round(elapsed,3),
            "frame_count":len(names),"asset_size":[128,128],"sample_size":[384,384],"supersampling":2,"frames":names}
    (out/"render-manifest.json").write_text(json.dumps(report,indent=2)+"\n")
    print(f"CPU fallback rendered {len(names)} assets + sample in {elapsed:.3f}s",flush=True)

if __name__=="__main__": main()
