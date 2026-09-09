"""Run with Blender --background --factory-startup --python kit.py.

Builds every source mesh with bpy, using flat polygons and four pre-baked light
bands. EEVEE emission materials preserve those exact values across machines;
the named physical lights document the key/fill rig used in the face bake.
No external models, materials, textures, extensions or network calls.
"""
import argparse
import json
import math
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent))
from geometry import ASSETS, PROJECTIONS, KEY, FILL, asset, sample_board, face_colour

def main():
    import bpy
    from mathutils import Vector
    parser=argparse.ArgumentParser()
    parser.add_argument("--only",choices=ASSETS)
    parser.add_argument("--projection",choices=PROJECTIONS,default="diamond")
    parser.add_argument("--save-blend",action="store_true",help="Save the final 3x3 inspection scene")
    args=parser.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    projection=PROJECTIONS[args.projection]
    root=Path(__file__).resolve().parents[1]; out=root/f"renders{projection.suffix}"; out.mkdir(exist_ok=True)
    start=time.perf_counter()
    bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete(use_global=False)
    scene=bpy.context.scene
    scene.render.engine="BLENDER_EEVEE"
    scene.render.film_transparent=True
    scene.render.image_settings.file_format="PNG"
    scene.render.image_settings.color_mode="RGBA"
    scene.render.image_settings.color_depth="8"
    scene.render.image_settings.compression=90
    scene.render.resolution_percentage=100
    scene.render.resolution_x=scene.render.resolution_y=projection.frame_size
    scene.view_settings.view_transform="Standard"
    scene.view_settings.look="None"
    scene.view_settings.exposure=0; scene.view_settings.gamma=1
    scene.world.color=(0,0,0)
    camera=bpy.data.objects.new(f"Camera-{projection.name}-{projection.elevation:g}deg",bpy.data.cameras.new("Orthographic"))
    scene.collection.objects.link(camera); scene.camera=camera
    camera.data.type="ORTHO"; camera.data.ortho_scale=projection.ortho_scale
    el,az=math.radians(projection.elevation),math.radians(projection.azimuth)
    camera.location=(10*math.cos(el)*math.cos(az),10*math.cos(el)*math.sin(az),10*math.sin(el))
    camera.rotation_euler=(-camera.location).to_track_quat("-Z","Y").to_euler()
    for name,direction,energy in (("Key-baked-upper-left",KEY,.76),("Fill-baked-cool",FILL,.12)):
        light=bpy.data.objects.new(name,bpy.data.lights.new(name,"SUN"))
        scene.collection.objects.link(light); light.data.energy=energy
        light.rotation_euler=(-Vector(direction)).to_track_quat("-Z","Y").to_euler()
        light.data.angle=math.radians(8)
    # The four-band bake replaces continuous diffuse shading and cast shadows.
    # Light fixtures intentionally cannot alter emission values or alpha.
    materials={}; objects=[]
    def linear(v):
        v/=255
        return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
    def material(rgb,alpha):
        key=(*rgb,alpha)
        if key in materials: return materials[key]
        m=bpy.data.materials.new("band-"+"-".join(map(str,key))); m.use_nodes=True
        m.diffuse_color=(*[linear(v) for v in rgb],alpha)
        tree=m.node_tree; tree.nodes.clear()
        output=tree.nodes.new("ShaderNodeOutputMaterial")
        emission=tree.nodes.new("ShaderNodeEmission")
        emission.inputs["Color"].default_value=(*[linear(v) for v in rgb],1)
        emission.inputs["Strength"].default_value=1
        shader=emission.outputs[0]
        if alpha<1:
            m.surface_render_method="BLENDED"
            transparent=tree.nodes.new("ShaderNodeBsdfTransparent")
            mix=tree.nodes.new("ShaderNodeMixShader"); mix.inputs[0].default_value=alpha
            tree.links.new(transparent.outputs[0],mix.inputs[1]); tree.links.new(shader,mix.inputs[2])
            shader=mix.outputs[0]
        tree.links.new(shader,output.inputs["Surface"])
        materials[key]=m; return m
    def build(meshes):
        for obj in objects:
            mesh=obj.data; bpy.data.objects.remove(obj,do_unlink=True); bpy.data.meshes.remove(mesh)
        objects.clear()
        for source in meshes:
            mesh=bpy.data.meshes.new(source.name); mesh.from_pydata([projection.vertex(v) for v in source.vertices],[],source.faces); mesh.update()
            obj=bpy.data.objects.new(source.name,mesh); scene.collection.objects.link(obj); objects.append(obj)
            indices={}
            for poly,face in zip(mesh.polygons,source.faces):
                rgb=face_colour(source,face)
                if rgb not in indices:
                    indices[rgb]=len(mesh.materials); mesh.materials.append(material(rgb,source.alpha))
                poly.material_index=indices[rgb]; poly.use_smooth=False
    names=[args.only] if args.only else ASSETS
    for name in names:
        build(asset(name)); scene.render.filepath=str(out/f"{name}.png")
        bpy.ops.render.render(write_still=True)
    if args.only: return
    build(sample_board()); camera.data.ortho_scale=projection.ortho_scale*3.12
    scene.render.resolution_x=scene.render.resolution_y=384
    scene.render.filepath=str(out/"sample-board.png"); bpy.ops.render.render(write_still=True)
    if args.save_blend: bpy.ops.wm.save_as_mainfile(filepath=str(root/"blender"/f"kit{projection.suffix}.blend"))
    elapsed=time.perf_counter()-start
    report={"engine":"blender-eevee","blender_version":bpy.app.version_string,"blender_render_verified":True,
            "projection":projection.name,"elevation":projection.elevation,"azimuth":projection.azimuth,
            "ortho_scale":projection.ortho_scale,"ground_depth_compensation":1/math.sin(el) if projection.name=="square" else 1,
            "render_seconds":round(elapsed,3),"frame_count":len(names),"asset_size":[projection.frame_size]*2,"sample_size":[384,384],"frames":names}
    (out/"render-manifest.json").write_text(json.dumps(report,indent=2)+"\n")
    print(f"EEVEE rendered {len(names)} assets + sample in {elapsed:.3f}s")

if __name__=="__main__": main()
