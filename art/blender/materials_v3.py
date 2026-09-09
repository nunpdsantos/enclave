"""Square v3: broad courses modulate, never replace, the four face bands.

UVs are logical world coordinates so neighbouring wall modules share courses.
No random noise texture. Hero uses the same course graph with diffuse lighting.
"""
import bpy

COURSE_CONTRAST = {"kit": .60, "hero": .24}
AO_STRENGTH = .16

def linear(v):
    v /= 255
    return v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4

def material(rgb, alpha, family, mode="kit"):
    m=bpy.data.materials.new(f"{mode}-{family}-{rgb}-{alpha}"); m.use_nodes=True
    tree=m.node_tree; tree.nodes.clear(); n=tree.nodes; l=tree.links
    output=n.new("ShaderNodeOutputMaterial")
    base=tuple(linear(v) for v in rgb)
    colour=n.new("ShaderNodeRGB"); colour.outputs[0].default_value=(*base,1)
    signal=colour.outputs[0]
    if family == "stone":
        uv=n.new("ShaderNodeTexCoord")
        brick=n.new("ShaderNodeTexBrick"); brick.name="Broad ashlar courses"
        l.new(uv.outputs["UV"],brick.inputs["Vector"])
        brick.inputs["Scale"].default_value=1
        brick.inputs["Brick Width"].default_value=.36 if mode=="kit" else .30
        brick.inputs["Row Height"].default_value=.20 if mode=="kit" else .14
        brick.inputs["Mortar Size"].default_value=.012 if mode=="kit" else .007
        brick.inputs["Mortar Smooth"].default_value=.002
        contrast=COURSE_CONTRAST[mode]
        brick.inputs["Color1"].default_value=(1,1,1,1)
        brick.inputs["Color2"].default_value=(1-contrast*.12,)*3+(1,)
        brick.inputs["Mortar"].default_value=(1-contrast,)*3+(1,)
        mix=n.new("ShaderNodeMixRGB"); mix.blend_type="MULTIPLY"; mix.inputs[0].default_value=1
        l.new(signal,mix.inputs[1]); l.new(brick.outputs["Color"],mix.inputs[2]); signal=mix.outputs[0]
    if mode=="kit" and family=='stone':
        # Broad cool right-side falloff in logical coordinates. This remains
        # fixed across masks rather than rotating a baked sprite's lighting.
        sep=n.new('ShaderNodeSeparateXYZ'); l.new(uv.outputs['UV'],sep.inputs[0])
        ramp=n.new('ShaderNodeMapRange'); ramp.inputs['From Min'].default_value=.08; ramp.inputs['From Max'].default_value=.44
        ramp.inputs['To Min'].default_value=0; ramp.inputs['To Max'].default_value=.48
        l.new(sep.outputs['X'],ramp.inputs[0])
        tint=n.new('ShaderNodeMixRGB'); l.new(ramp.outputs[0],tint.inputs[0])
        tint.inputs[1].default_value=(1,1,1,1); tint.inputs[2].default_value=(.40,.60,.83,1)
        multiply=n.new('ShaderNodeMixRGB'); multiply.blend_type='MULTIPLY'; multiply.inputs[0].default_value=1
        l.new(signal,multiply.inputs[1]); l.new(tint.outputs[0],multiply.inputs[2]); signal=multiply.outputs[0]
    if mode=="kit" and alpha==1:
        ao=n.new("ShaderNodeAmbientOcclusion"); ao.samples=16
        ao.inputs["Distance"].default_value=.16
        remap=n.new("ShaderNodeMapRange")
        remap.inputs["To Min"].default_value=1-AO_STRENGTH
        remap.inputs["To Max"].default_value=1
        l.new(ao.outputs["AO"],remap.inputs["Value"])
        mix=n.new("ShaderNodeMixRGB"); mix.blend_type="MULTIPLY"; mix.inputs[0].default_value=1
        l.new(signal,mix.inputs[1]); l.new(remap.outputs[0],mix.inputs[2]); signal=mix.outputs[0]
    if mode=="hero":
        shader=n.new("ShaderNodeBsdfPrincipled")
        shader.inputs["Roughness"].default_value=.87
        l.new(signal,shader.inputs["Base Color"])
        if family=="stone":
            bump=n.new("ShaderNodeBump"); bump.inputs["Strength"].default_value=.28; bump.inputs["Distance"].default_value=.025
            l.new(brick.outputs["Fac"],bump.inputs["Height"]); bump.invert=True
            l.new(bump.outputs[0],shader.inputs["Normal"])
        if family=="torch":
            l.new(signal,shader.inputs["Emission Color"]); shader.inputs["Emission Strength"].default_value=2
    else:
        shader=n.new("ShaderNodeEmission"); l.new(signal,shader.inputs["Color"])
    socket=shader.outputs[0]
    if alpha<1:
        m.surface_render_method="BLENDED"
        transparent=n.new("ShaderNodeBsdfTransparent")
        mix=n.new("ShaderNodeMixShader"); mix.inputs[0].default_value=alpha
        l.new(transparent.outputs[0],mix.inputs[1]); l.new(socket,mix.inputs[2]); socket=mix.outputs[0]
    l.new(socket,output.inputs["Surface"])
    return m

def add_uv(mesh, source):
    uv=mesh.uv_layers.new(name="Logical courses")
    for poly, face in zip(mesh.polygons,source.faces):
        vs=[source.vertices[i] for i in face]
        spans=[max(v[a] for v in vs)-min(v[a] for v in vs) for a in range(3)]
        horizontal=spans[2]<1e-6
        axis=0 if spans[0]>=spans[1] else 1
        for loop,vert in zip(poly.loop_indices,vs):
            uv.data[loop].uv=(vert[0],vert[1]) if horizontal else (vert[axis],vert[2])

def tinted(rgb, family):
    return rgb  # v3 ramp already contains sampled warm / cool values.

def contact_shadow(source_meshes, projection, scene):
    """Directional projected convex silhouette, transparent cool cast shadow.

    Projects vertices along a fixed upper-left light onto the ground. Convex
    hull intentionally merges subpixel crenel gaps, avoiding shadow noise.
    All shadow pixels are rendered through Blender with the asset.
    """
    pts=sorted(set((round(x+.25*z,6),round(y-.16*z,6)) for m in source_meshes for x,y,z in m.vertices))
    if len(pts)<3: return None
    def cross(o,a,b): return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
    lower=[]; upper=[]
    for p in pts:
        while len(lower)>1 and cross(lower[-2],lower[-1],p)<=0: lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper)>1 and cross(upper[-2],upper[-1],p)<=0: upper.pop()
        upper.append(p)
    hull=lower[:-1]+upper[:-1]
    mesh=bpy.data.meshes.new('Cool directional cast shadow')
    mesh.from_pydata([projection.vertex((x,y,-.003)) for x,y in hull],[],[tuple(range(len(hull)))])
    obj=bpy.data.objects.new(mesh.name,mesh); scene.collection.objects.link(obj)
    mesh.materials.append(material((22,39,60),.48,'shadow'))
    return obj
