/** No-dependency asset/preview contract check, using the repo's installed Pixi.
 * Builds the actual page's scene graph with real Pixi Sprite/Graphics/Container.
 * DOM and GPU Application are test adapters: this does NOT verify browser output.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import * as PIXI from 'pixi.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const python=process.env.ART_PYTHON||'/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13';
const geometry=spawnSync(python,[`${root}art/check_assets.py`],{encoding:'utf8'});
assert.equal(geometry.status,0,geometry.stderr||geometry.stdout);
process.stdout.write(geometry.stdout);
const data=JSON.parse(readFileSync(`${root}public/assets/siege/atlas.json`));
const png=readFileSync(`${root}public/assets/siege/atlas.png`);
const page=readFileSync(`${root}public/art-preview.html`,'utf8');
assert(page.includes('https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js'));
const script=page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
new vm.Script(script,{filename:'public/art-preview.html'});
const expected=vm.runInNewContext(page.match(/const FRAME_NAMES = ([\s\S]*?\n    \]);/)[1]);
assert.deepEqual(Object.keys(data.frames).sort(),Array.from(expected).sort());
assert.equal(data.meta.scale,'2');
assert(png.byteLength<2_000_000);
const source=new PIXI.TextureSource({width:data.meta.size.w,height:data.meta.size.h});
const sheet=new PIXI.Spritesheet({texture:new PIXI.Texture({source}),data});
await sheet.parse();
for(const [name,texture] of Object.entries(sheet.textures)) {
  assert.equal(texture.width,64,name); assert.equal(texture.height,64,name);
  assert.equal(texture.defaultAnchor.x,.5,name); assert.equal(texture.defaultAnchor.y,.5,name);
}

class Element {
  constructor(tag='div'){ this.tag=tag; this.children=[]; this.style={}; this.events={}; this.checked=false; this.textContent=''; }
  append(...items){ this.children.push(...items); }
  addEventListener(name,callback){ this.events[name]=callback; }
}
const ids=Object.fromEntries([...page.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
ids.raiders.checked=ids.tide.checked=true;
const applications=[];
class HeadlessApplication {
  constructor(){ this.stage=new PIXI.Container(); this.canvas=new Element('canvas'); this.renders=0; applications.push(this); }
  async init(options){ this.options=options; }
  render(){ this.renders++; }
}
const classes=new Set();
const document={getElementById:id=>ids[id],createElement:tag=>new Element(tag),body:{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}};
const browser={PIXI:true,addEventListener:()=>{}};
const errors=[];
const context={window:browser,document,PIXI:{...PIXI,Application:HeadlessApplication,Assets:{load:async()=>sheet}},
  fetch:async()=>({ok:true,arrayBuffer:async()=>png}),console:{error:error=>errors.push(error.message)}};
await vm.runInNewContext(script,context,{timeout:3000,filename:'public/art-preview.html'});
assert.deepEqual(errors,[]);
assert.equal(browser.__ENCLAVE_ART_QA__?.ready,true);
assert.equal(ids.catalog.children.length,31);
assert.equal(applications.length,3);
const count=name=>applications.reduce((sum,app)=>sum+app.stage.children[0].children.filter(child=>child.label===name).length,0);
assert.equal(count('enemy-raider'),9); assert.equal(count('enemy-tide'),15); assert.equal(count('enemy-target'),6);
ids.raiders.checked=false; ids.raiders.events.change(); assert.equal(count('enemy-raider'),0); assert.equal(count('enemy-tide'),15);
ids.tide.checked=false; ids.tide.events.change(); assert.equal(count('enemy-tide'),0); assert.equal(count('enemy-target'),0);
ids.grid.checked=true; ids.grid.events.change();
ids.mono.checked=true; ids.mono.events.change(); assert(classes.has('mono'));
ids.raiders.checked=ids.tide.checked=true; ids.raiders.events.change();
applications[0].stage.emit('pointermove',{global:{x:304+(1-2)*32,y:48+(1+2)*32*Math.sin(Math.PI/3)}});
assert.match(ids.inspector.textContent,/Row 3, column 2 · wall-10 · D R/);
const report={pixiVersion:PIXI.VERSION,frameCount:Object.keys(sheet.textures).length,atlasBytes:png.byteLength,
  checks:['preview script syntax','exact preview/atlas name match','Pixi spritesheet parse','all textures 64x64 with center anchors','three actual Pixi scene graphs','all catalog entries','raider/tide toggles','intent visibility','grid control','greyscale CSS class','inverse projected cell inspection'],
  browserVerified:false,limitation:'DOM and GPU Application are adapters. No browser was launched; actual CDN, GPU rendering and responsive CSS require a separate visual check.'};
writeFileSync(`${root}art/verification/preview.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(`Pixi ${PIXI.VERSION}: ${report.frameCount} frames parsed; preview scene graphs and controls passed. Browser output remains unverified.`);
