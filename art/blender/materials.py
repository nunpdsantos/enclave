"""Square v2: broad courses modulate, never replace, the four face bands.

UVs are logical world coordinates so neighbouring wall modules share courses.
No random noise texture. Hero uses the same course graph with diffuse lighting.
"""
import bpy

COURSE_CONTRAST = {"kit": .10, "hero": .24}
AO_STRENGTH = .22

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
        brick.inputs["Brick Width"].default_value=.25 if mode=="kit" else .30
        brick.inputs["Row Height"].default_value=.125 if mode=="kit" else .14
        brick.inputs["Mortar Size"].default_value=.004 if mode=="kit" else .007
        brick.inputs["Mortar Smooth"].default_value=.004
        contrast=COURSE_CONTRAST[mode]
        brick.inputs["Color1"].default_value=(1,1,1,1)
        brick.inputs["Color2"].default_value=(1-contrast*.35,)*3+(1,)
        brick.inputs["Mortar"].default_value=(1-contrast,)*3+(1,)
        mix=n.new("ShaderNodeMixRGB"); mix.blend_type="MULTIPLY"; mix.inputs[0].default_value=1
        l.new(signal,mix.inputs[1]); l.new(brick.outputs["Color"],mix.inputs[2]); signal=mix.outputs[0]
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
    if family not in ("stone","parchment","slate"): return rgb
    # Subordinate warm key / cool fill tint; band spacing stays dominant.
    warm=sum(rgb)/3>115
    gain=(1.025,1.005,.975) if warm else (.97,1.005,1.045)
    return tuple(min(255,round(v*g)) for v,g in zip(rgb,gain))

def contact_shadow(source_meshes, projection, scene):
    """Soft transparent contact footprint; stays beneath the geometry.

    This authored shadow avoids baking a rectangular receiver into sprite alpha.
    Its gradient is rendered by Blender, not composited into source PNGs.
    """
    points=[v for m in source_meshes for v in m.vertices if v[2]<.08]
    if not points: return None
    lo=[min(v[i] for v in points) for i in (0,1)]
    hi=[max(v[i] for v in points) for i in (0,1)]
    cx,cy=[(a+b)/2 for a,b in zip(lo,hi)]
    rx,ry=[(b-a)/2+.035 for a,b in zip(lo,hi)]
    # Feathered concentric rounded rectangles, opacity interpolated by shader.
    mesh=bpy.data.meshes.new("Soft contact shadow")
    mesh.from_pydata([projection.vertex((cx+x*rx,cy+y*ry,-.003)) for x,y in ((-1,-1),(1,-1),(1,1),(-1,1))],[],[(0,1,2,3)])
    uv=mesh.uv_layers.new()
    for item,xy in zip(uv.data,((0,0),(1,0),(1,1),(0,1))): item.uv=xy
    obj=bpy.data.objects.new(mesh.name,mesh); scene.collection.objects.link(obj)
    m=bpy.data.materials.new("Feathered slate contact"); m.use_nodes=True; m.surface_render_method="BLENDED"
    n=m.node_tree.nodes; l=m.node_tree.links; n.clear()
    uvn=n.new("ShaderNodeTexCoord"); sub=n.new("ShaderNodeVectorMath"); sub.operation="SUBTRACT"; sub.inputs[1].default_value=(.5,.5,0); l.new(uvn.outputs["UV"],sub.inputs[0])
    absolute=n.new("ShaderNodeVectorMath"); absolute.operation="ABSOLUTE"; l.new(sub.outputs[0],absolute.inputs[0])
    sep=n.new("ShaderNodeSeparateXYZ"); l.new(absolute.outputs[0],sep.inputs[0])
    maximum=n.new("ShaderNodeMath"); maximum.operation="MAXIMUM"; l.new(sep.outputs[0],maximum.inputs[0]); l.new(sep.outputs[1],maximum.inputs[1])
    ramp=n.new("ShaderNodeMapRange"); ramp.interpolation_type="SMOOTHSTEP"; ramp.inputs["From Min"].default_value=.30; ramp.inputs["From Max"].default_value=.5; ramp.inputs["To Min"].default_value=.20; ramp.inputs["To Max"].default_value=0; l.new(maximum.outputs[0],ramp.inputs[0])
    trans=n.new("ShaderNodeBsdfTransparent"); dark=n.new("ShaderNodeEmission"); dark.inputs["Color"].default_value=(.008,.014,.022,1)
    mix=n.new("ShaderNodeMixShader"); l.new(ramp.outputs[0],mix.inputs[0]); l.new(trans.outputs[0],mix.inputs[1]); l.new(dark.outputs[0],mix.inputs[2])
    output=n.new("ShaderNodeOutputMaterial"); l.new(mix.outputs[0],output.inputs[0]); mesh.materials.append(m)
    return obj
