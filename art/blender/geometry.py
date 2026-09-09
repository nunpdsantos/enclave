"""ENCLAVE's source meshes. Standard-library only; shared by bpy and CPU QA.

One cell is one world unit. +X is right, +Y is up on the logical board.
Every polygon is deliberately broad. No imported models, noise or textures.
Change the proportions below, then regenerate both renderers from this file.
"""
from dataclasses import dataclass
import math

ELEVATION = 60.0
AZIMUTH = -45.0
ORTHO_SCALE = math.sqrt(2)  # a 1-unit square has a 64px-wide diamond at 1x
TILE = 128

@dataclass(frozen=True)
class Projection:
    name: str
    elevation: float
    azimuth: float
    ortho_scale: float
    frame_size: int

    def vertex(self, v):
        x, y, z = v
        # Rotate logical -Y toward a +X camera (azimuth 0), then undo
        # orthographic ground foreshortening. Heights remain unscaled.
        return (-y/math.sin(math.radians(self.elevation)), x, z) if self.name == "square" else v

    def pixel(self, v):
        x, y, z = self.vertex(v)
        el, az = math.radians(self.elevation), math.radians(self.azimuth)
        scale = self.frame_size/self.ortho_scale
        return (self.frame_size/2 + (-math.sin(az)*x+math.cos(az)*y)*scale,
                self.frame_size/2 - (-math.sin(el)*math.cos(az)*x-math.sin(el)*math.sin(az)*y+math.cos(el)*z)*scale)

    @property
    def suffix(self):
        return "-square" if self.name == "square" else ""

PROJECTIONS = {
    "diamond": Projection("diamond", ELEVATION, AZIMUTH, ORTHO_SCALE, TILE),
    "square": Projection("square", 60.0, 0.0, 1.5, 192),
}
WALL_WIDTH = .44
WALL_HEIGHT = .25
CRENEL_HEIGHT = .14
KEY = (-.45, -.60, .80)
FILL = (.7, .2, .5)

# Four discrete value steps per material family, dark to light. All opaque
# interiors resolve to these colours; antialiasing and transparency mix edges.
PALETTE = {
    "stone": ("#1F2023", "#514B42", "#9C8C73", "#DDCDAA"),
    "slate": ("#1B2026", "#424E5B", "#808F9F", "#C2D0DE"),
    "parchment": ("#232019", "#554B3A", "#A18C6B", "#DFCDAE"),
    "cobalt": ("#0C2146", "#294CA8", "#7093C8", "#C0D0EF"),
    "oxblood": ("#3C111D", "#902B42", "#C47485", "#EFC0C7"),
    "torch": ("#351717", "#85391D", "#D27E33", "#F3CC77"),
}

@dataclass
class Mesh:
    name: str
    vertices: list
    faces: list
    family: str = "stone"
    value: int | None = None
    alpha: float = 1.0

def unit(v):
    n = math.sqrt(sum(x*x for x in v))
    return tuple(x/n for x in v) if n else (0, 0, 1)

def normal(points):
    a = tuple(points[1][i]-points[0][i] for i in range(3))
    b = tuple(points[2][i]-points[0][i] for i in range(3))
    return unit((a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]))

def face_colour(mesh, face):
    """Bake a key + fill into four flat bands, identically in both engines."""
    if mesh.value is None:
        n = normal([mesh.vertices[i] for i in face])
        intensity = .12 + .76*max(0, sum(a*b for a,b in zip(n, unit(KEY))))
        intensity += .12*max(0, sum(a*b for a,b in zip(n, unit(FILL))))
        level = sum(intensity >= t for t in (.20, .47, .72))
    else:
        level = mesh.value
    h = PALETTE[mesh.family][level].lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def box(name, x, y, z, w, d, h, family="stone", value=None, angle=0):
    c, s = math.cos(angle), math.sin(angle)
    vertices = []
    for dz in (0, h):
        for dx, dy in ((-w/2,-d/2),(w/2,-d/2),(w/2,d/2),(-w/2,d/2)):
            vertices.append((x+dx*c-dy*s, y+dx*s+dy*c, z+dz))
    return Mesh(name, vertices, [(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)], family, value)

def plane(name, points, z, family, value, alpha=1):
    return Mesh(name, [(x,y,z) for x,y in points], [tuple(range(len(points)))], family, value, alpha)

def cylinder(name, x, y, z, radius, height, family, vertices=8, top_radius=None, value=None):
    top_radius = radius if top_radius is None else top_radius
    if top_radius == 0:
        vs = [(x+radius*math.cos(i*2*math.pi/vertices), y+radius*math.sin(i*2*math.pi/vertices), z) for i in range(vertices)]
        vs.append((x,y,z+height))
        fs = [tuple(reversed(range(vertices)))] + [(i,(i+1)%vertices,vertices) for i in range(vertices)]
        return Mesh(name,vs,fs,family,value)
    vs = [(x+rad*math.cos(i*2*math.pi/vertices), y+rad*math.sin(i*2*math.pi/vertices), z+dz)
          for rad,dz in ((radius,0),(top_radius,height)) for i in range(vertices)]
    fs = [tuple(reversed(range(vertices))), tuple(range(vertices,vertices*2))]
    fs += [(i,(i+1)%vertices,(i+1)%vertices+vertices,i+vertices) for i in range(vertices)]
    return Mesh(name, vs, fs, family, value)

def transform(meshes, angle=0, x=0, y=0, z=0):
    c,s = math.cos(angle), math.sin(angle)
    return [Mesh(m.name, [(x+a*c-b*s,y+a*s+b*c,z+h) for a,b,h in m.vertices], m.faces, m.family, m.value, m.alpha) for m in meshes]

def wall(mask):
    """U=1 D=2 L=4 R=8. Open ends reach exactly +/- .5; no end-cap seam.

    The 3x3 occupancy mesh avoids overlapping boxes and internal faces. On
    exposed edges, two broad merlons give a continuous, alternating silhouette.
    Each mask is rendered in world space, never rotated as a finished PNG.
    """
    a = WALL_WIDTH/2
    bounds = (-.5,-a,a,.5)
    occupied = {(1,1)}
    for bit,cell in ((1,(1,2)),(2,(1,0)),(4,(0,1)),(8,(2,1))):
        if mask & bit: occupied.add(cell)
    vs,fs = [],[]
    exposed = []
    for i,j in sorted(occupied):
        x0,x1,y0,y1 = bounds[i],bounds[i+1],bounds[j],bounds[j+1]
        quad = [(x0,y0),(x1,y0),(x1,y1),(x0,y1)]
        base = len(vs)
        vs += [(x,y,z) for z in (0,WALL_HEIGHT) for x,y in quad]
        fs += [tuple(base+k for k in (4,5,6,7))]
        for side,(di,dj) in enumerate(((0,-1),(1,0),(0,1),(-1,0))):
            if (i+di,j+dj) in occupied: continue
            # Joined perimeter is open. The neighbouring tile supplies it.
            if i+di not in range(3) or j+dj not in range(3): continue
            p,q = side,(side+1)%4
            fs.append(tuple(base+k for k in (p,q,q+4,p+4)))
            exposed.append((quad[p],quad[q]))
    result = [Mesh("wall-body",vs,fs)]
    # Flat walkway inset distinguishes thickness from the vertical face.
    for n,(p,q) in enumerate(exposed):
        length = math.dist(p,q)
        for k in range(2 if length>.35 else 1):
            t = (k+.5)/(2 if length>.35 else 1)
            x,y = p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t
            # Move square battlements inside the footprint.
            x += (-(q[1]-p[1])/length)*.055
            y += ((q[0]-p[0])/length)*.055
            result.append(box(f"merlon-{n}-{k}",x,y,WALL_HEIGHT,.14,.14,CRENEL_HEIGHT))
    return result

def banner(enemy=False, small=False):
    family = "oxblood" if enemy else "cobalt"
    # Player = two squared tails with a central notch. Enemy = a single spear
    # point. These silhouettes remain different when hue is removed.
    outline = [(.02,.76),(.37,.76),(.37,.30),(.25,.30),(.20,.44),(.14,.30),(.02,.30)]
    if enemy: outline = [(.02,.76),(.37,.76),(.37,.49),(.195,.26),(.02,.49)]
    vs = [(x,.02,z) for x,z in outline]
    result = [cylinder("iron-pole",0,0,0,.020,.80,"slate",6),
              Mesh("cloth",vs,[tuple(range(len(vs)))],family,1),
              box("cloth-header",.195,.014,.70,.35,.018,.06,family,0)]
    result = transform(result,angle=math.pi/4)
    if small:
        return [Mesh(m.name,[(x*.65,y*.65,z*.65) for x,y,z in m.vertices],m.faces,m.family,m.value,m.alpha) for m in result]
    return result

def flame(x,y,z):
    return [cylinder("brazier",x,y,z,.065,.06,"slate",6),
            cylinder("flame",x,y,z+.06,.065,.16,"torch",5,0,3)]

def keep():
    result = [box("keep-plinth",0,0,0,.67,.67,.065),
              box("keep-shaft",0,0,.065,.51,.51,.42),
              box("keep-crown",0,0,.485,.57,.57,.07),
              box("roof-well",0,0,.557,.35,.35,.015,"slate",0)]
    for x in (-.20,.20):
        for y in (-.20,.20):
            result.append(box("keep-merlon",x,y,.555,.14,.14,.13))
    # One oversized doorway, no tiny windows or brick textures.
    result.append(box("keep-door",0,-.258,.09,.17,.01,.23,"slate",0))
    result += transform(banner(small=True), x=-.18,y=.02,z=.19)
    result += flame(.24,-.20,.06)
    return result

def gate(direction):
    """An actual open, five-wedge arch. Passage follows local Y; N is +Y."""
    result = []
    for x in (-.29,.29):
        result.append(box("gate-pier",x,0,0,.22,.36,.32))
        result.append(box("gate-battlement",x,0,.49,.17,.30,.12))
    # Ring sectors form a real transparent hole, rather than a black decal.
    for i in range(5):
        t0,t1 = i*math.pi/5,(i+1)*math.pi/5
        vs = [(r*math.cos(t),y,.29+r*math.sin(t))
              for y in (-.18,.18) for r,t in ((.18,t0),(.34,t0),(.34,t1),(.18,t1))]
        result.append(Mesh("arch-voussoir",vs,[(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],"stone",2 if i%2==0 else 3))
    result += transform(banner(enemy=True,small=True),x=-.35,y=.09,z=.09)
    return transform(result, angle={"n":0,"e":-math.pi/2,"s":math.pi,"w":math.pi/2}[direction])

def ruin(variant):
    result = [box("old-foundation",0,0,0,.68,.58,.065,"slate",1)]
    if variant=="a":
        result += [box("broken-pier",-.20,.10,.065,.24,.26,.35),
                   box("fallen-lintel",.08,-.07,.065,.47,.22,.13,angle=-.35),
                   box("rubble",.24,.20,.065,.18,.20,.10,angle=.3)]
    else:
        result += [box("broken-pier",.23,.12,.065,.21,.25,.25),
                   box("fallen-block",-.12,-.08,.065,.32,.28,.18,angle=.35),
                   box("rubble",-.27,.21,.065,.18,.16,.07,angle=-.4)]
    return result

def floor(kind):
    # Large four-slab joints survive downsampling. Geometry touches the diamond
    # boundary intentionally; no bevel/gap is baked into the logical footprint.
    family = "slate" if kind=="stone" else "parchment"
    level = 1 if kind=="stone" else 2
    result = [plane("floor",[(-.5,-.5),(.5,-.5),(.5,.5),(-.5,.5)],0,family,level)]
    for x in (-.245,.245):
        for y in (-.245,.245):
            result.append(plane("broad-slab",[(x-.23,y-.23),(x+.23,y-.23),(x+.23,y+.23),(x-.23,y+.23)],.002,family,level))
    # Deliberately drawn structural seams, not small stone surface detail.
    for x,y,w,d in ((0,0,.026,1),(0,0,1,.026)):
        result.append(box("slab-joint",x,y,.003,w,d,.001,family,max(0,level-1)))
    if kind!="stone":
        # Player floors carry a cobalt right-angle motif plus warm inset.
        for x,y,w,d in ((-.34,0,.055,.73),(0,-.34,.73,.055)):
            result.append(box("cobalt-inlay",x,y,.006,w,d,.002,"cobalt",1))
        if kind=="courtyard-a":
            result.append(box("warm-square",.09,.09,.006,.30,.30,.002,"torch",2))
            result.append(box("inset",.09,.09,.01,.15,.15,.002,"parchment",3))
        else:
            result.append(box("garden-bed",.08,.08,.006,.31,.31,.04,"slate",0))
            result.append(cylinder("clipped-garden",.08,.08,.05,.18,.07,"cobalt",4,.11,1))
            result.append(box("warm-step",.12,-.16,.006,.31,.07,.002,"torch",2))
    return result

def raider():
    result = [box("boot-left",-.095,-.025,0,.13,.22,.085,"slate",0),
              box("boot-right",.095,.025,0,.13,.22,.085,"slate",0),
              cylinder("oxblood-cloak",0,.045,.065,.22,.33,"oxblood",5,.10),
              cylinder("iron-helm",0,-.015,.40,.125,.14,"slate",6,.09),
              box("visor",0,-.127,.43,.17,.014,.035,"slate",0),
              box("weapon-shaft",.26,0,.06,.035,.035,.49,"slate",1),
              box("axe-head",.28,0,.43,.16,.07,.15,"slate",3)]
    shield = [(-.24,-.10,.39),(-.045,-.10,.39),(-.045,-.13,.22),(-.15,-.16,.10),(-.24,-.13,.22)]
    result.append(Mesh("pointed-shield",shield,[(0,1,2,3,4)],"oxblood",2))
    # A figure is a gameplay token, deliberately oversized relative to masonry.
    # At 32px tile width this gives a ~19px silhouette rather than a tiny speck.
    return [Mesh(m.name,[(x*1.45,y*1.45,z*1.45) for x,y,z in m.vertices],m.faces,m.family,m.value,m.alpha) for m in result]

def tide():
    # Provisional overlay: contiguous oxblood ground, large directional wedges,
    # two smoke masses and three embers. No random particles or fine noise.
    result = [plane("tide",[(-.5,-.5),(.5,-.5),(.5,.5),(-.5,.5)],.015,"oxblood",1,.64)]
    for y in (-.22,.20):
        result.append(plane("enemy-chevron",[(-.33,y+.07),(0,y-.13),(.33,y+.07),(.20,y+.14),(0,y+.02),(-.20,y+.14)],.018,"oxblood",2,.85))
    for x,y,r in ((-.27,.20,.10),(.27,-.16,.075)):
        m = cylinder("smoke",x,y,.02,r,.17,"slate",5,r*.75,0)
        m.alpha=.40
        result.append(m)
    for x,y in ((-.26,-.27),(.22,.31),(.29,-.23)):
        result.append(plane("ember",[(x-.026,y),(x,y-.041),(x+.026,y),(x,y+.041)],.06,"torch",3))
    return result

def target():
    result = []
    # Four corner brackets identify a destination without hiding its occupant.
    for x in (-.32,.32):
        for y in (-.32,.32):
            # A dark keyline keeps a pale marker visible over sandstone caps.
            result += [box("intent-keyline",x-math.copysign(.065,x),y,.018,.22,.095,.008,"slate",0),
                       box("intent-keyline",x,y-math.copysign(.065,y),.018,.095,.22,.008,"slate",0),
                       box("intent-bracket",x-math.copysign(.065,x),y,.030,.18,.055,.008,"torch",3),
                       box("intent-bracket",x,y-math.copysign(.065,y),.030,.055,.18,.008,"torch",3)]
    result.append(plane("intent-point-outline",[(-.135,.46),(.135,.46),(0,.22)],.030,"slate",0))
    result.append(plane("intent-point",[(-.10,.44),(.10,.44),(0,.26)],.035,"oxblood",1))
    return result

ASSETS = [f"wall-{i:02d}" for i in range(16)] + ["keep"] + [f"gate-{d}" for d in "nesw"] + [
    "ruin-a","ruin-b","floor-stone","floor-courtyard-a","floor-courtyard-b",
    "banner-cobalt","banner-oxblood","enemy-raider","enemy-tide","enemy-target"]

def asset(name):
    if name.startswith("wall-"): return wall(int(name[-2:]))
    if name=="keep": return keep()
    if name.startswith("gate-"): return gate(name[-1])
    if name.startswith("ruin-"): return ruin(name[-1])
    if name.startswith("floor-"): return floor(name[6:])
    if name.startswith("banner-"): return banner(name.endswith("oxblood"))
    return {"enemy-raider":raider,"enemy-tide":tide,"enemy-target":target}[name]()

def sample_board():
    result = []
    walls = {(0,0),(0,1),(0,2),(1,0),(2,0)}
    for r in range(3):
        for c in range(3):
            meshes = floor("courtyard-a" if r>0 and c>0 else "stone")
            if (r,c) in walls:
                mask = sum(bit for dr,dc,bit in ((-1,0,1),(1,0,2),(0,-1,4),(0,1,8)) if (r+dr,c+dc) in walls)
                meshes += wall(mask)
            if (r,c)==(1,1): meshes += keep()
            if (r,c)==(2,2): meshes += raider()
            if (r,c)==(1,2): meshes += target()
            result += transform(meshes,x=c-1,y=1-r)
    return result
