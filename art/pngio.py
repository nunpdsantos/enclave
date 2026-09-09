"""Tiny RGBA8 PNG codec for the art pipeline; only Python's standard library.

Reads non-interlaced RGB/RGBA 8-bit PNGs (including Blender's filtered output).
Writing is deterministic, with no time, host or user metadata.
"""
from pathlib import Path
import struct
import zlib

SIGNATURE = b"\x89PNG\r\n\x1a\n"

def chunk(kind, data):
    return struct.pack(">I",len(data))+kind+data+struct.pack(">I",zlib.crc32(kind+data)&0xffffffff)

def write_png(path, width, height, rgba):
    assert len(rgba)==width*height*4
    stride=width*4
    # Sub filter compresses large solid polygons and alpha borders efficiently.
    rows=[]
    for y in range(height):
        row=rgba[y*stride:(y+1)*stride]
        rows.append(b"\x01"+bytes((v-(row[i-4] if i>=4 else 0))&255 for i,v in enumerate(row)))
    data=SIGNATURE+chunk(b"IHDR",struct.pack(">IIBBBBB",width,height,8,6,0,0,0))
    data+=chunk(b"sRGB",b"\x00")+chunk(b"IDAT",zlib.compress(b"".join(rows),9))+chunk(b"IEND",b"")
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    Path(path).write_bytes(data)

def read_png(path):
    data=Path(path).read_bytes()
    if data[:8]!=SIGNATURE: raise ValueError(f"Not a PNG: {path}")
    pos=8; compressed=bytearray(); width=height=channels=0
    while pos<len(data):
        size=struct.unpack_from(">I",data,pos)[0]
        kind=data[pos+4:pos+8]; body=data[pos+8:pos+8+size]
        crc=struct.unpack_from(">I",data,pos+8+size)[0]
        if zlib.crc32(kind+body)&0xffffffff!=crc: raise ValueError(f"PNG CRC failed: {path}")
        if kind==b"IHDR":
            width,height,depth,colour,comp,filt,interlace=struct.unpack(">IIBBBBB",body)
            if depth!=8 or colour not in (2,6) or comp or filt or interlace:
                raise ValueError("Expected non-interlaced RGB/RGBA8 PNG")
            channels=4 if colour==6 else 3
        if kind==b"IDAT": compressed.extend(body)
        pos+=12+size
    raw=zlib.decompress(compressed); stride=width*channels
    if len(raw)!=(stride+1)*height: raise ValueError("PNG row length mismatch")
    out=bytearray(); previous=bytearray(stride)
    for y in range(height):
        start=y*(stride+1); mode=raw[start]; row=bytearray(raw[start+1:start+1+stride])
        for x in range(stride):
            a=row[x-channels] if x>=channels else 0
            b=previous[x]; c=previous[x-channels] if x>=channels else 0
            if mode==1: predictor=a
            elif mode==2: predictor=b
            elif mode==3: predictor=(a+b)//2
            elif mode==4:
                p=a+b-c; pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
                predictor=a if pa<=pb and pa<=pc else b if pb<=pc else c
            elif mode==0: predictor=0
            else: raise ValueError(f"Invalid PNG filter {mode}")
            row[x]=(row[x]+predictor)&255
        if channels==4: out.extend(row)
        else:
            for x in range(0,stride,3): out.extend((*row[x:x+3],255))
        previous=row
    return width,height,out
