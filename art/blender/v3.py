"""Square v3 geometry. Historical Diamond / v1 / v2 sources stay unchanged."""
import math
import geometry as old
from geometry import Mesh, box, plane, cylinder, normal, unit
from keep_study import keep_study

PALETTE = dict(old.PALETTE, deck=('#1C201A','#344346','#455356','#66706A'), stone=('#1C201A','#343F40','#A5845E','#F5DBAE'),
               parchment=('#232019','#554B3A','#BBA98E','#C8BBA5'),
               slate=('#202C39','#586D83','#808F9F','#C2D0DE'))
WALL_WIDTH=.60
WALL_HEIGHT=.52
CRENEL_HEIGHT=.20

def face_colour(mesh,face):
    if mesh.value is None:
        n=normal([mesh.vertices[i] for i in face])
        intensity=.12+.76*max(0,sum(a*b for a,b in zip(n,unit(old.KEY))))+.12*max(0,sum(a*b for a,b in zip(n,unit(old.FILL))))
        level=sum(intensity>=t for t in (.20,.47,.72))
    else: level=mesh.value
    h=PALETTE[mesh.family][level].lstrip('#')
    return tuple(int(h[i:i+2],16) for i in (0,2,4))

def wall(mask):
    # Re-derive the occupancy and exposed faces with the new mass constants.
    saved=old.WALL_WIDTH,old.WALL_HEIGHT,old.CRENEL_HEIGHT
    old.WALL_WIDTH,old.WALL_HEIGHT,old.CRENEL_HEIGHT=WALL_WIDTH,WALL_HEIGHT,CRENEL_HEIGHT
    result=old.wall(mask)
    old.WALL_WIDTH,old.WALL_HEIGHT,old.CRENEL_HEIGHT=saved
    for m in result[1:]:
        cx=sum(v[0] for v in m.vertices)/len(m.vertices); cy=sum(v[1] for v in m.vertices)/len(m.vertices)
        m.vertices=[(cx+(x-cx)*1.25,cy+(y-cy)*1.25,z) for x,y,z in m.vertices]
    # A continuous inset track follows each join, on the upper walking surface.
    result.append(box('walkway-centre',0,0,WALL_HEIGHT+.001,.22,.22,.003,'stone',2))
    for bit,x,y,w,d in ((1,0,.30,.22,.40),(2,0,-.30,.22,.40),(4,-.30,0,.40,.22),(8,.30,0,.40,.22)):
        if mask&bit: result.append(box('walkway-line',x,y,WALL_HEIGHT+.001,w,d,.003,'stone',2))
    return result

def keep():
    result=[]
    for m in keep_study():
        # One cell wide, with a genuinely taller shaft. The flag stays inside
        # the cell width; height is allowed to overhang the previous row.
        vs=[(x*.46,y*.43,z*.46) for x,y,z in m.vertices]
        if m.name=='cobalt-notched-flag': vs=[(max(x,-.46),y,z) for x,y,z in vs]
        if m.name=='roof-well': m.value=0; m.family='deck'
        result.append(Mesh(m.name,vs,m.faces,m.family,m.value,m.alpha))
    # Deck slabs / inner walking border, visible rather than a roof void.
    for x in (-.19,.02,.23):
        for y in (-.17,.04,.25):
            result.append(box('roof-deck-slab',x,y,1.038,.197,.197,.012,'deck',1 if (x+y)<.1 else 2))
    for x,y,w,d in ((0,.29,.62,.055),(-.29,0,.055,.58),(.29,0,.055,.58)):
        result.append(box('roof-walkway-edge',x,y,1.052,w,d,.014,'stone',2))
    # Broad warm pool beneath the flame, a local authored light contribution.
    result.append(cylinder('brazier-warm-pool',.22,-.16,1.052,.105,.004,'torch',12,value=1))
    return [Mesh(m.name,[(x,y*.30/.43,z*.56/.46) for x,y,z in m.vertices],m.faces,m.family,m.value,m.alpha) for m in result]

def floor(kind):
    result=[plane('paving-bed',[(-.5,-.5),(.5,-.5),(.5,.5),(-.5,.5)],0,'stone',1)]
    # Six large offset slabs with clipped corners, stable irregular joints.
    for row,(y0,y1,split) in enumerate(((-.5,-.17,-.12),(-.17,.18,.10),(.18,.5,-.05))):
        for col,(x0,x1) in enumerate(((-.5,split),(split,.5))):
            g=.012; c=.035
            pts=[(x0+g+c,y0+g),(x1-g,y0+g),(x1-g,y1-g-c),(x1-g-c,y1-g),(x0+g,y1-g),(x0+g,y0+g+c)]
            m=plane('large-irregular-paver',pts,.006,'parchment',2 if (row+col)%3 else 3)
            result.append(m)
    if kind!='stone':
        result += [m for m in old.floor(kind) if m.name in ('cobalt-inlay','warm-square','inset','garden-bed','clipped-garden','warm-step')]
        for m in result[7:]: m.vertices=[(x,y,z+.012) for x,y,z in m.vertices]
    return result

def asset(name):
    if name.startswith('wall-'): return wall(int(name[-2:]))
    if name=='keep': return keep()
    if name.startswith('floor-'): return floor(name[6:])
    result=old.asset(name)
    if name.startswith(('gate-','ruin-')):
        result=[Mesh(m.name,[(x,y,z*1.23) for x,y,z in m.vertices],m.faces,m.family,m.value,m.alpha) for m in result]
    if name=='enemy-raider':
        result += [box('shield-boss',-.20,-.211,.40,.075,.034,.08,'slate',3),box('helmet-ridge',0,-.02,.79,.045,.24,.035,'slate',3)]
    return result

def sample_board():
    result=[]; walls={(0,0),(0,1),(0,2),(1,0),(2,0)}
    for r in range(3):
        for c in range(3):
            meshes=floor('courtyard-a' if r>0 and c>0 else 'stone')
            if (r,c) in walls:
                mask=sum(bit for dr,dc,bit in ((-1,0,1),(1,0,2),(0,-1,4),(0,1,8)) if (r+dr,c+dc) in walls)
                meshes+=wall(mask)
            if (r,c)==(1,1): meshes+=keep()
            if (r,c)==(2,2): meshes+=asset('enemy-raider')
            result+=old.transform(meshes,x=c-1,y=1-r)
    return result
