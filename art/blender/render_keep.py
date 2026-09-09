"""Render via blender.blender_run_script only. No shell Blender invocation."""
import argparse
import json
import math
from pathlib import Path
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parent))
import bpy
from mathutils import Vector
from geometry import PROJECTIONS, PALETTE, face_colour
from materials import material, add_uv, tinted, contact_shadow
from keep_study import keep_study

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--only',choices=['square','hero','ground'])
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    root=Path(__file__).resolve().parents[1]; (root/'hero').mkdir(exist_ok=True)
    timings={}
    for kind in ([args.only] if args.only else ['square','hero','ground']):
        start=time.perf_counter()
        bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
        square=kind=='square'; projection=PROJECTIONS['square' if square else 'diamond']
        scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE' if square else 'CYCLES'
        if not square:
            scene.cycles.device='CPU'; scene.cycles.samples=32; scene.cycles.use_denoising=True
        scene.render.film_transparent=True; scene.render.resolution_percentage=100
        scene.render.resolution_x=scene.render.resolution_y=256 if square else 1024
        scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'
        scene.render.image_settings.color_depth='8'; scene.render.image_settings.compression=90
        scene.view_settings.view_transform='Standard' if square else 'AgX'
        scene.view_settings.look='None'; scene.view_settings.exposure=0; scene.view_settings.gamma=1
        scene.world.use_nodes=True
        scene.world.node_tree.nodes.get('Background').inputs[0].default_value=(.22,.30,.42,1)
        scene.world.node_tree.nodes.get('Background').inputs[1].default_value=.35
        camera=bpy.data.objects.new('Keep camera',bpy.data.cameras.new('Keep orthographic'))
        scene.collection.objects.link(camera); scene.camera=camera; camera.data.type='ORTHO'
        camera.data.ortho_scale=2 if square else 5.9
        target=Vector((0,0,0 if square else 1.18))
        el,az=math.radians(60),math.radians(0 if square else -45)
        camera.location=target+Vector((10*math.cos(el)*math.cos(az),10*math.cos(el)*math.sin(az),10*math.sin(el)))
        camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler()
        for name,loc,colour,energy,size in [('Warm key',(-3,-4,7),(1,.82,.59),850,4),('Cool fill',(4,1,5),(.55,.72,1),220,5)]:
            light=bpy.data.objects.new(name,bpy.data.lights.new(name,'AREA')); scene.collection.objects.link(light)
            light.location=loc; light.rotation_euler=(target-light.location).to_track_quat('-Z','Y').to_euler()
            light.data.color=colour; light.data.energy=energy; light.data.shape='DISK'; light.data.size=size
        sources=keep_study(ground=kind=='ground',square=square); mats={}
        for source in sources:
            mesh=bpy.data.meshes.new(source.name); mesh.from_pydata([projection.vertex(v) for v in source.vertices],[],source.faces); mesh.update(); add_uv(mesh,source)
            obj=bpy.data.objects.new(source.name,mesh); scene.collection.objects.link(obj)
            for poly,face in zip(mesh.polygons,source.faces):
                if square: rgb=tinted(face_colour(source,face),source.family)
                else:
                    h=PALETTE[source.family][3 if source.family=='stone' else source.value if source.value is not None else 1].lstrip('#')
                    rgb=tuple(int(h[i:i+2],16) for i in (0,2,4))
                key=(rgb,source.family)
                if key not in mats: mats[key]=material(rgb,source.alpha,source.family,'kit' if square else 'hero')
                mesh.materials.append(mats[key]); poly.material_index=len(mesh.materials)-1
            if not square and source.family in ('stone','slate') and len(source.faces)>2:
                bevel=obj.modifiers.new('Soft worn arris','BEVEL'); bevel.width=.013; bevel.segments=2
                bevel.affect='EDGES'
                normal=obj.modifiers.new('Weighted broad faces','WEIGHTED_NORMAL')
        if square: contact_shadow(sources,projection,scene)
        else:
            light=bpy.data.objects.new('Brazier glow',bpy.data.lights.new('Brazier glow','POINT')); scene.collection.objects.link(light)
            light.location=(.48,-.38,2.60); light.data.energy=9; light.data.color=(1,.26,.035); light.data.shadow_soft_size=.18
        path=root/'renders-square/keep-2x2.png' if square else root/'hero'/('keep-hero-ground.png' if kind=='ground' else 'keep-hero.png')
        scene.render.filepath=str(path); bpy.ops.render.render(write_still=True)
        timings[kind]={'seconds':round(time.perf_counter()-start,3),'path':str(path.relative_to(root)), 'size':[scene.render.resolution_x]*2,'engine':scene.render.engine,'elevation':60,'azimuth':0 if square else -45,'ortho_scale':camera.data.ortho_scale}
        if square: timings[kind].update(footprint=[2,2],cell_pixels_2x=128,anchor=[.5,.5])
    (root/'hero'/(f'render-{args.only}.json' if args.only else 'render-manifest.json')).write_text(json.dumps({'blender_version':bpy.app.version_string,'renders':timings},indent=2)+'\n')
    print(json.dumps(timings))

if __name__=='__main__': main()
