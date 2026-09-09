"""Reference-derived large Keep, shared by the two-cell study and hero art."""
import math
from geometry import Mesh, box, cylinder, transform

def cloth():
    # Folded hanging cobalt cloth with two squared tails and a deep notch.
    xs=(-.25,-.125,0,.125,.25)
    ys=(-.853,-.895,-.86,-.885,-.85)
    bottoms=(1.15,1.15,1.39,1.15,1.15)
    vs=[(x,y,z) for x,y,b in zip(xs,ys,bottoms) for z in (2.13,b)]
    return Mesh("hanging-notched-cloth",vs,[(2*i,2*i+1,2*i+3,2*i+2) for i in range(4)],"cobalt",1)

def keep_study(ground=False, square=False):
    m=[box("buttressed-plinth",0,0,0,2.06,1.98,.16),
       box("keep-shaft",0,0,.16,1.60,1.60,1.96),
       box("crown-cornice",0,0,2.08,1.78,1.78,.14),
       box("roof-well",0,0,2.225,1.46,1.46,.025,"slate",0)]
    # Tapered buttresses read as structural feet, not little surface ornaments.
    for x in (-.67,.67):
        for y in (-.83,.83):
            vs=[(x+dx*w,y+dy*d,z) for w,d,z in ((.35,.42,.12),(.25,.22,1.10)) for dx,dy in ((-.5,-.5),(.5,-.5),(.5,.5),(-.5,.5))]
            m.append(Mesh("tapered-buttress",vs,[(0,3,2,1),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7),(4,5,6,7)]))
    for x in (-.78,.78):
        m.append(box("parapet-side",x,0,2.20,.18,1.72,.18))
    for y in (-.78,.78):
        m.append(box("parapet-front",0,y,2.20,1.38,.18,.18))
    for t in (-.74,0,.74):
        for s in (-.76,.76):
            m.append(box("crown-merlon",t,s,2.38,.28,.25,.28))
            if t==0: m.append(box("crown-merlon",s,t,2.38,.25,.28,.28))
    # Arched doorway with a dark recessed visual and five broad voussoirs.
    m += [box("door-recess",0,-.806,.16,.45,.012,.60,"slate",0),
          box("door-jamb",-.29,-.85,.16,.12,.14,.62),
          box("door-jamb",.29,-.85,.16,.12,.14,.62)]
    for i in range(5):
        a,b=i*math.pi/5,(i+1)*math.pi/5
        vs=[(r*math.cos(t),y,.76+r*math.sin(t)) for y in (-.91,-.79) for r,t in ((.225,a),(.35,a),(.35,b),(.225,b))]
        m.append(Mesh("door-arch-stone",vs,[(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]))
    arch=[(-.225,-.808,.76),(.225,-.808,.76)]+[(.225*math.cos(i*math.pi/8),-.808,.76+.225*math.sin(i*math.pi/8)) for i in range(9)]
    m.append(Mesh("arched-door-recess",arch,[tuple(range(len(arch)))],"slate",0))
    m.append(box("threshold",0,-1.02,.03,.68,.43,.10))
    # Broad dark slits and a light sill on front and both sides.
    for y in (-.38,.38):
        for x in (-.806,.806):
            for z in (.65,1.45):
                m.append(box("arrow-slit",x,y,z,.016,.085,.28,"slate",0))
                m.append(box("slit-sill",x,y,z-.025,.045,.14,.04))
    for x in (-.55,.55):
        m.append(box("front-arrow-slit",x,-.807,1.43,.08,.015,.29,"slate",0))
    m.append(cloth())
    m.append(cylinder("flag-pole",-.56,.20,2.25,.022,1.14,"slate",8))
    # Billowing flag, two squared tails, visible in both projections.
    vs=[(-.56,.20,3.34),(-.88,.15,3.32),(-1.20,.22,3.38),(-1.20,.22,2.99),(-1.05,.18,2.99),(-.98,.17,3.12),(-.88,.15,2.99),(-.56,.20,3.02)]
    m.append(Mesh("cobalt-notched-flag",vs,[(0,1,6,7),(1,2,3,4,5,6)],"cobalt",1))
    m.append(cylinder("brazier-bowl",.48,-.38,2.25,.12,.13,"slate",8,.16))
    for a in range(6):
        t=a*math.pi/3
        m.append(box("brazier-bars",.48+.13*math.cos(t),-.38+.13*math.sin(t),2.28,.022,.022,.23,"slate",0))
    m.append(cylinder("brazier-fire",.48,-.38,2.38,.12,.29,"torch",7,0,3))
    m.append(cylinder("brazier-core",.45,-.41,2.38,.07,.19,"torch",5,0,3))
    if ground:
        for i in range(8):
            for j in range(8):
                m.append(box("forecourt-paver",(i-3.5)*.43,(j-3.5)*.43,-.045,.418,.418,.042,"stone",2))
    if square:
        m=[Mesh(s.name,[(x*.58,y*.58,z*.32) for x,y,z in s.vertices],s.faces,s.family,s.value,s.alpha) for s in m]
    return m
