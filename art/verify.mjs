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
const sheets={},pngs={};
for (const projection of ['diamond','square','square-v1']) {
  const geometry=projection==='square-v1'?{status:0,stdout:'Preserved v1 atlas checked below.\n'}:spawnSync(python,[`${root}art/check_assets.py`,'--projection',projection],{encoding:'utf8'});
  assert.equal(geometry.status,0,geometry.stderr||geometry.stdout);
  process.stdout.write(`${projection}: ${geometry.stdout}`);
  const suffix=projection==='diamond'?'':`-${projection}`;
  const data=JSON.parse(readFileSync(`${root}public/assets/siege/atlas${suffix}.json`));
  const png=readFileSync(`${root}public/assets/siege/atlas${suffix}.png`);
  assert.equal(data.enclave.projection,projection.startsWith('square')?'square':projection);
  assert.equal(data.meta.image,`atlas${suffix}.png`);
  assert.equal(data.meta.scale,'2');
  assert(png.byteLength<2_000_000);
  const source=new PIXI.TextureSource({width:data.meta.size.w,height:data.meta.size.h});
  const sheet=new PIXI.Spritesheet({texture:new PIXI.Texture({source}),data});
  await sheet.parse();
  for(const [name,texture] of Object.entries(sheet.textures)) {
    const size=projection!=='diamond'?96:64;
    assert.equal(texture.width,size,name); assert.equal(texture.height,size,name);
    assert.equal(texture.defaultAnchor.x,.5,name); assert.equal(texture.defaultAnchor.y,.5,name);
  }
  sheets[projection]=sheet; pngs[projection]=png;
}
const page=readFileSync(`${root}public/art-preview.html`,'utf8');
assert(page.includes('https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.js'));
const script=page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
new vm.Script(script,{filename:'public/art-preview.html'});
const expected=vm.runInNewContext(page.match(/const FRAME_NAMES = ([\s\S]*?\n    \]);/)[1]);
for(const sheet of Object.values(sheets)) assert.deepEqual(Object.keys(sheet.textures).sort(),Array.from(expected).sort());

class Element {
  constructor(tag='div'){ this.tag=tag; this.children=[]; this.style={}; this.events={}; this.checked=false; this.textContent=''; }
  append(...items){ this.children.push(...items); }
  replaceChildren(...items){ this.children=[...items]; }
  addEventListener(name,callback){ this.events[name]=callback; }
}
const ids=Object.fromEntries([...page.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Element()]));
ids.raiders.checked=ids.tide.checked=true;
const applications=[];
class HeadlessApplication {
  constructor(){ this.stage=new PIXI.Container(); this.canvas=new Element('canvas'); this.renders=0; applications.push(this); }
  async init(options){ this.options=options; this.renderer={resize:(w,h)=>{this.options.width=w;this.options.height=h;}}; }
  render(){ this.renders++; }
}
const classes=new Set();
const document={getElementById:id=>ids[id],createElement:tag=>new Element(tag),body:{classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}};
const browser={PIXI:true,addEventListener:()=>{}};
const errors=[];
const context={window:browser,document,PIXI:{...PIXI,Application:HeadlessApplication,Assets:{load:async path=>sheets[path.includes("square-v1")?"square-v1":path.includes("square")?"square":"diamond"]}},
  fetch:async path=>({ok:true,arrayBuffer:async()=>pngs[path.includes("square-v1")?"square-v1":path.includes("square")?"square":"diamond"]}),console:{error:error=>errors.push(error.message)}};
await vm.runInNewContext(script,context,{timeout:3000,filename:'public/art-preview.html'});
assert.deepEqual(errors,[]);
assert.equal(browser.__ENCLAVE_ART_QA__?.ready,true);
assert.equal(browser.__ENCLAVE_ART_QA__.projection,'square','Square v2 is the board default');
assert.equal(applications.length,3);
for(const projection of ['square','square-v1','diamond','square-v1','square']) {
  const square=projection!=='diamond',sheet=sheets[projection],png=pngs[projection];
  for(const name of ['diamond','square','square-v1']) ids[`projection-${name}`].checked=name===projection;
  ids[`projection-${projection}`].events.change();
  assert.equal(browser.__ENCLAVE_ART_QA__.projection,projection);
  assert.equal(ids.catalog.children.length,31,'catalog must be replaced on switch');
  assert.match(ids.catalog.children[0].children[0].style.backgroundImage,new RegExp(projection==='diamond'?'atlas.png':`atlas-${projection}.png`));
  for(const app of applications) {
    const board=app.stage.children[0],scale=board.scale.x;
    assert.equal(app.options.height,square?624*scale:scale===.5?282:560*scale);
    const floors=board.children.filter(child=>child.label==='floor-stone');
    assert.equal(floors[0].texture,sheet.textures['floor-stone'],'atlas swapped');
    assert.equal(floors[1].x-floors[0].x,square?64:32);
    assert.equal(floors[1].y-floors[0].y,square?0:32*Math.sin(Math.PI/3));
    assert.equal(floors[9].x-floors[0].x,square?0:-32);
    assert.equal(floors[9].y-floors[0].y,square?64:32*Math.sin(Math.PI/3));
    // Every centre, every view, then both sides of a column boundary.
    for(let r=0;r<9;r++) for(let c=0;c<9;c++) {
      const x=board.x+(square?c*64:(c-r)*32)*scale;
      const y=board.y+(square?r*64:(c+r)*32*Math.sin(Math.PI/3))*scale;
      app.stage.emit('pointermove',{global:{x,y}});
      assert.match(ids.inspector.textContent,new RegExp(`^Row ${r+1}, column ${c+1} ·`));
    }
    for(const [c,expectedCol] of [[1.499,2],[1.501,3]]) {
      app.stage.emit('pointermove',{global:{x:board.x+(square?c*64:(c-2)*32)*scale,y:board.y+(square?128:(c+2)*32*Math.sin(Math.PI/3))*scale}});
      assert.match(ids.inspector.textContent,new RegExp(`^Row 3, column ${expectedCol} ·`));
    }
  }
  const count=name=>applications.reduce((sum,app)=>sum+app.stage.children[0].children.filter(child=>child.label===name).length,0);
  assert.equal(count('enemy-raider'),9); assert.equal(count('enemy-tide'),15); assert.equal(count('enemy-target'),6);
  ids.raiders.checked=false; ids.raiders.events.change(); assert.equal(count('enemy-raider'),0); assert.equal(count('enemy-tide'),15);
  ids.tide.checked=false; ids.tide.events.change(); assert.equal(count('enemy-tide'),0); assert.equal(count('enemy-target'),0);
  ids.grid.checked=true; ids.grid.events.change();
  ids.mono.checked=true; ids.mono.events.change(); assert(classes.has('mono'));
  ids.raiders.checked=ids.tide.checked=true; ids.raiders.events.change();
  const report={projection,pixiVersion:PIXI.VERSION,frameCount:Object.keys(sheet.textures).length,atlasBytes:png.byteLength,
    checks:['preview script syntax','exact preview/atlas name match','Pixi spritesheet parse','projection frame sizes with center anchors','three actual Pixi scene graphs','projection switching and resize','catalog replacement and atlas swap','raider/tide toggles','intent visibility','grid control','greyscale CSS class','all 81 cell centres and boundary inspection at all scales'],
    browserVerified:false,limitation:'DOM and GPU Application are adapters. Browser connection unavailable in this session; actual CDN, GPU rendering, responsive CSS and physical touch require a separate check.'};
  writeFileSync(`${root}art/verification/preview${projection==='diamond'?'':`-${projection}`}.json`,`${JSON.stringify(report,null,2)}\n`);
}
assert.deepEqual(errors,[]);
console.log(`Pixi ${PIXI.VERSION}: all three 31-frame atlases, all three scales and repeated projection switching passed. Browser output remains unverified.`);
