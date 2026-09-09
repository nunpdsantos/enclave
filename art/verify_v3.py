"""Square v3 acceptance: atlas extraction, ground registration, measured pixels.
Pillow/NumPy assemble inspection images; every input sprite is Blender MCP output.
"""
import ast,hashlib,json,math,re,sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'blender'))
from geometry import ASSETS,PROJECTIONS
from v3 import asset,wall,WALL_WIDTH,PALETTE
OUT=ROOT/'verification'

def load(version=''):
    base=ROOT.parent/'public/assets/siege'
    data=json.loads((base/f'atlas-square{version}.json').read_text()); atlas=Image.open(base/data['meta']['image']).convert('RGBA')
    frames={}
    for name,item in data['frames'].items():
        f=item['frame'];frames[name]=atlas.crop((f['x'],f['y'],f['x']+f['w'],f['y']+f['h']))
    return data,atlas,frames

def registered(im,frame):
    canvas=Image.new('RGBA',(320,384));a=frame['anchor'];canvas.alpha_composite(im,(round(160-im.width*a['x']),round(256-im.height*a['y'])))
    return canvas

def main():
    data,atlas,frames=load();old,oldatlas,before=load('-v2')
    for version in ('v1','v2'):
        expected=json.loads((OUT/f'square-{version}.json').read_text())['png_sha256']
        assert hashlib.sha256((ROOT.parent/f'public/assets/siege/atlas-square-{version}.png').read_bytes()).hexdigest()==expected
    assert set(frames)==set(ASSETS)
    assert atlas.width==data['meta']['size']['w'] and atlas.height==data['meta']['size']['h']
    band_luma={}
    for family,ramp in PALETTE.items():
        values=[sum(int(h[i:i+2],16)*weight for i,weight in zip((1,3,5),(.299,.587,.114))) for h in ramp]
        assert all(a<b for a,b in zip(values,values[1:])),(family,'unordered value bands')
        band_luma[family]=values
    bounds={};shadow={};totals=[];per={};union_values=[]
    for name,im in frames.items():
        expected=(256,288) if name=='keep' else (192,192)
        assert im.size==expected,(name,im.size)
        assert im.tobytes()==Image.open(ROOT/f'renders-square/{name}.png').convert('RGBA').tobytes(),name
        ar=np.asarray(im); a=ar[:,:,3]
        assert a.max()==255 or name=='enemy-tide'; assert (a==0).any()
        # No alpha from geometry or projected shadow may meet the frame edge.
        assert max(a[0].max(),a[-1].max(),a[:,0].max(),a[:,-1].max())<=1,(name,'clipped alpha')
        anchor=data['frames'][name]['anchor']; ox=im.width*anchor['x'];oy=im.height*anchor['y']
        points=[(ox+128*x,oy-128*y-64*z) for m in asset(name) for x,y,z in m.vertices]
        limits=[min(p[0] for p in points),min(p[1] for p in points),max(p[0] for p in points),max(p[1] for p in points)]
        assert 0<=limits[0]<limits[2]<im.width and 0<=limits[1]<limits[3]<im.height,(name,limits)
        bounds[name]=limits
        assert all(0<=v<=1 for v in anchor.values())
        # Compare same named frames registered on their ground anchors. Raw
        # packed coordinates are invalid when a frame moves or grows.
        v2=np.asarray(registered(before[name],old['frames'][name])).astype(float)
        v3=np.asarray(registered(im,data['frames'][name])).astype(float)
        common=(v2[:,:,3]==255)&(v3[:,:,3]==255)
        delta=np.abs(v2[:,:,:3]-v3[:,:,:3])[common]
        if delta.size: totals.append(delta.reshape(-1));per[name]=float(delta.mean())
        union=(v2[:,:,3]>=250)|(v3[:,:,3]>=250)
        bg=np.array([88,109,131]); comp2=v2[:,:,:3]*v2[:,:,3:4]/255+bg*(1-v2[:,:,3:4]/255)
        comp3=v3[:,:,:3]*v3[:,:,3:4]/255+bg*(1-v3[:,:,3:4]/255)
        union_values.append(np.abs(comp2-comp3)[union].reshape(-1))
        if not name.startswith(('floor-','enemy-tide','enemy-target')):
            shade=(a>80)&(a<160)&(ar[:,:,2]>ar[:,:,0]+15)
            assert shade.sum()>15,(name,'no cast shadow');shadow[name]=int(shade.sum())
    for mask in range(16):
        vs=wall(mask)[0].vertices
        for axis,sign,bit in ((1,1,1),(1,-1,2),(0,-1,4),(0,1,8)):
            assert math.isclose(max(sign*v[axis] for v in vs),.5 if mask&bit else WALL_WIDTH/2)
    assert len({im.tobytes() for n,im in frames.items() if n.startswith('wall-')})==16
    a=np.asarray(frames['floor-stone'])[:,:,3]
    assert np.where(a[96]>=128)[0].tolist()==list(range(32,160))
    assert np.where(a[:,96]>=128)[0].tolist()==list(range(32,160))
    assert data['enclave']['columnStep']==[64,0] and data['enclave']['rowStep']==[0,64]
    ka=np.asarray(frames['keep'])[:,:,3]; ys,xs=np.where(ka>=250)
    ratio=(int(ys.max()-ys.min())+1)/(int(xs.max()-xs.min())+1)
    mad=float(np.concatenate(totals).mean());union_mad=float(np.concatenate(union_values).mean())
    # Wall front course profile at 2x asset resolution, away from edges / merlons.
    wall_im=np.asarray(frames['wall-12']).astype(float)
    # A single broad horizontal course crosses the full front. Sample central
    # mortar rows against adjacent block interiors (explicit pixel coordinates).
    luma=wall_im[:,:,:3]@np.array([.299,.587,.114])
    profile=np.median(luma[121:148,48:144],axis=1)
    contrast=1-float(profile.min()/profile.max())
    # Before/after at phone DPR3: 32 CSS px cell => 96 device px, .75 of source.
    names=['keep','wall-12','wall-03','wall-06','floor-stone','floor-courtyard-a','gate-n','enemy-raider']
    sheet=Image.new('RGBA',(640,1000),'#586D83');d=ImageDraw.Draw(sheet)
    for i,name in enumerate(names):
        col=i%2;row=i//2;x=col*320;y=row*250
        d.text((x+12,y+8),f'{name} | v2 (left), v3 (right)',fill='white')
        for j,(ims,meta) in enumerate(((before,old),(frames,data))):
            im=registered(ims[name],meta['frames'][name]);im=im.resize((240,288),Image.Resampling.LANCZOS)
            # ground registration at y=192. Frame fits one cell comparison panel.
            sheet.alpha_composite(im,(x+j*150-40,y-3))
    sheet.convert('RGB').save(OUT/'before-after-v3.png')
    keep=frames['keep'].resize((192,216),Image.Resampling.LANCZOS)
    kb=Image.new('RGBA',keep.size,'#586D83');kb.alpha_composite(keep);kb.convert('RGB').save(OUT/'keep-v3-3x.png')
    board(frames,data)
    report={'four_band_luma':band_luma,'difference':{'method':'RGB mean absolute channel delta, matched frame names registered by ground anchor; intersection alpha ==255; no resizing; excludes transparent padding and translucent shadows','opaque_intersection_mad':mad,'opaque_union_composited_mad':union_mad,'per_frame':per,'threshold':40},'keep':{'opaque_threshold':250,'opaque_width':int(xs.max()-xs.min()+1),'opaque_height':int(ys.max()-ys.min()+1),'ratio':ratio,'frame':[256,288],'anchor':data['frames']['keep']['anchor']},'wall_courses':{'method':'wall-12 front at native 2x: median luma across x48:144, y121:148; 1 - min/max','contrast':contrast,'profile':profile.tolist()},'shadow_pixels':shadow,'projected_bounds':bounds,'checks':['atlas source bytes match','v1/v2 hashes preserved','16 distinct joins with correct extents','opaque and shadow alpha clear of all frame edges','128x128 cell raster','per-frame ground anchors','360 CSS px DPR 1 and 3 composites'],'composites':'Pillow atlas composites, not device screenshots'}
    (OUT/'acceptance-v3.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'opaque_mad':mad,'union_mad':union_mad,'keep_ratio':ratio,'course_contrast':contrast}))
    assert mad>=40,('difference too small',mad)
    assert 1.3<=ratio<=1.6,('keep proportion',ratio)
    assert .25<=contrast<=.35,('course contrast',contrast)

def board(frames,data):
    preview=(ROOT.parent/'public/art-preview.html').read_text()
    def constant(name): return ast.literal_eval(re.search(rf'const {name} = (.*);',preview).group(1))
    rows=constant('ROWS'); objects=[]
    def walled(r,c): return 0<=r<9 and 0<=c<9 and rows[r][c]=='w'
    for r in range(9):
        for c in range(9):
            if walled(r,c):
                mask=sum(bit for dr,dc,bit in ((-1,0,1),(1,0,2),(0,-1,4),(0,1,8)) if walled(r+dr,c+dc));objects.append((r,c,f'wall-{mask:02d}',0))
            if rows[r][c]=='k':objects.append((r,c,'keep',0))
            if rows[r][c]=='r':objects.append((r,c,'ruin-b' if c%2 else 'ruin-a',0))
    objects += [(r,c,f'gate-{d}',0) for r,c,d in constant('GATES')]
    objects += [(r,c,'enemy-raider',0) for r,c in constant('RAIDERS')]
    objects += [(r,c,f'banner-{owner}',16.64 if walled(r,c) else 0) for r,c,owner in constant('BANNERS')]
    for dpr in (1,3):
        canvas=Image.new('RGBA',(360*dpr,360*dpr),'#586D83');scale=dpr/4
        def draw(name,r,c,raise_by=0):
            im=frames[name]; a=data['frames'][name]['anchor'];w=round(im.width*scale);h=round(im.height*scale)
            im=im.resize((w,h),Image.Resampling.LANCZOS)
            x=(52+32*c)*dpr;y=(52+32*r-raise_by/2)*dpr
            canvas.alpha_composite(im,(round(x-w*a['x']),round(y-h*a['y'])))
        for r in range(9):
            for c in range(9):draw(('floor-courtyard-b' if (r+c)%3==0 else 'floor-courtyard-a') if rows[r][c] in 'ck' else 'floor-stone',r,c)
        for r,c in constant('TIDE'): draw('enemy-tide',r,c)
        for r,c,n,z in sorted(objects):draw(n,r,c,z)
        for r,c in constant('TARGETS'):draw('enemy-target',r,c)
        canvas.convert('RGB').save(OUT/f'board-phone-v3-dpr{dpr}.png')

if __name__=='__main__':main()
