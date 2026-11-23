import * as THREE from 'three';
import {context2d} from './dom.ts';
import type {ReceiptRecord} from '../shared/api.ts';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {Paper, ROWS, COLS, WIDTH, LENGTH} from './paper.ts';
import {drawReceipt} from './receipt.ts';
import {PaperRoll, PAGE_HEIGHT} from './roll.ts';

const clamp = THREE.MathUtils.clamp;

export class ReceiptScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly onMotion: (direction: number) => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly raycaster: THREE.Raycaster;
  private readonly pointer: THREE.Vector2;
  private readonly dragPlane: THREE.Plane;
  private readonly dragOffset: THREE.Vector3;
  private previousHit: THREE.Vector3 | null;
  private readonly roll: PaperRoll<ReceiptRecord>;
  private time: number;
  private accumulator: number;
  private lastFrame: number;
  private frameId: number;
  private paused: boolean;
  private direction: number;
  private readonly paper: Paper;
  private contextLost = false;
  private compact = matchMedia('(max-width:650px), (max-height:500px) and (max-width:1000px)').matches;
  private connected = false;
  private displayState = '';
  private reportAgeMs = 0;
  private reportSyncedAt?: number;
  private displayCanvas!: HTMLCanvasElement;
  private displayTexture!: THREE.CanvasTexture;
  // Created synchronously by the setup methods called in the constructor.
  private environment!: THREE.WebGLRenderTarget;
  private printer!: THREE.Group;
  private roller!: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  private ledMaterial!: THREE.MeshStandardMaterial;
  private sheet!: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  constructor(canvas: HTMLCanvasElement, onMotion: (direction: number) => void) {
    this.canvas = canvas;
    this.onMotion = onMotion;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.compact ? 1.5 : 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.world = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 70);
    this.camera.position.set(5.4, 6.7, 15);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(10, 10);
    this.dragPlane = new THREE.Plane();
    this.dragOffset = new THREE.Vector3();
    this.previousHit = null;
    this.roll = new PaperRoll();
    this.time = 0;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.frameId = 0;
    this.paused = false;
    this.direction = 0;
    this.paper = new Paper();
    this.setupLighting();
    this.buildPrinter();
    this.buildPaper();
    this.rebuildAtlas();
    this.resize();
    this.bindPointer();
    new ResizeObserver(() => { this.resize(); this.requestFrame(); }).observe(canvas);
    document.addEventListener('visibilitychange', () => {
      this.lastFrame = 0; this.accumulator = 0;
      if (!document.hidden) this.requestFrame();
    });
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.contextLost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.contextLost = false; this.lastFrame = 0; this.requestFrame(); });
    this.requestFrame();
  }

  get pages() { return this.roll.pages; }
  get position() { return this.roll.position; }

  setupLighting() {
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, .06, .1, 100, {size: this.compact ? 128 : 256});
    this.world.environment = this.environment.texture;
    this.world.environmentIntensity = .38;
    room.dispose(); pmrem.dispose();
    this.world.add(new THREE.HemisphereLight(0xfffcf2, 0x6b7065, 1.15));
    const key = new THREE.DirectionalLight(0xfff8e9, 3.2);
    key.position.set(-3.5, 8, 5);
    key.castShadow = true;
    const shadowSize = this.compact ? 512 : 1024;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    Object.assign(key.shadow.camera, {left: -6, right: 6, top: 7, bottom: -5, near: .1, far: 25});
    key.shadow.bias = -.00015;
    key.shadow.normalBias = .014;
    key.shadow.radius = 13;
    key.shadow.blurSamples = this.compact ? 8 : 16;
    this.world.add(key);
    const fill = new THREE.DirectionalLight(0xdce6ee, .65);
    fill.position.set(5, 3, -4); this.world.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({color: 0x32392d, opacity: .13}));
    floor.rotation.x = -Math.PI / 2; floor.position.y = .004; floor.receiveShadow = true; this.world.add(floor);
    const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
    const ctx = context2d(shadowCanvas), gradient = ctx.createRadialGradient(64, 64, 13, 64, 64, 64);
    gradient.addColorStop(0, '#29322385'); gradient.addColorStop(.5, '#29322336'); gradient.addColorStop(1, '#29322300');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 4.3), new THREE.MeshBasicMaterial({map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false, opacity: .6}));
    contact.rotation.x = -Math.PI / 2; contact.position.y = .009; this.world.add(contact);
  }

  buildPrinter() {
    this.printer = new THREE.Group(); this.world.add(this.printer);
    const grain = makeGrain();
    const shell = new THREE.MeshStandardMaterial({color: 0x2d3330, roughness: .62, metalness: .02, bumpMap: grain, bumpScale: .006});
    const lid = new THREE.MeshStandardMaterial({color: 0x383f37, roughness: .57, metalness: .02, bumpMap: grain, bumpScale: .006});
    const rubber = new THREE.MeshStandardMaterial({color: 0x111713, roughness: .85});
    const seam = new THREE.MeshStandardMaterial({color: 0x1b231c, roughness: .65});
    const metal = new THREE.MeshStandardMaterial({color: 0xa6aaa0, roughness: .28, metalness: .85});
    const box = (size: [number, number, number], position: [number, number, number], material: THREE.MeshStandardMaterial, radius = .08) => {
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 4, radius), material);
      mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
      this.printer.add(mesh); return mesh;
    };
    for (const x of [-1.4, 1.4]) for (const z of [-1.0, 1.0]) box([.42,.2,.48],[x,.12,z],rubber,.07);
    box([3.59, .16, 2.65], [0,.28,0], seam, .035);
    box([3.65, 1.02, 2.75], [0,.84,0], shell, .13);
    box([3.64, .035, 2.74], [0,1.315,0], seam, .015);
    box([3.66, .43, 2.76], [0,1.545,0], lid, .13);
    // A fine molded cover joint, following the top face rather than a painted line.
    const cover = new THREE.Shape();
    cover.moveTo(-1.46,-1.12);cover.lineTo(1.46,-1.12);cover.quadraticCurveTo(1.59,-1.12,1.59,-.99);
    cover.lineTo(1.59,.98);cover.quadraticCurveTo(1.59,1.11,1.46,1.11);
    cover.lineTo(-1.46,1.11);cover.quadraticCurveTo(-1.59,1.11,-1.59,.98);
    cover.lineTo(-1.59,-.99);cover.quadraticCurveTo(-1.59,-1.12,-1.46,-1.12);
    const joint = new THREE.CatmullRomCurve3(cover.getPoints(64).map(point=>new THREE.Vector3(point.x,1.760,point.y)),true);
    this.printer.add(new THREE.Mesh(new THREE.TubeGeometry(joint,180,.005,4,true),seam));
    // Separate front fascia and a small recessed label make the scale legible.
    box([3.18,.63,.024], [0,.84,1.375], shell, .06);
    const badge = makeLabel(512, 140, ctx => {
      ctx.fillStyle = '#c5cbb8'; ctx.font = '600 52px Arial'; ctx.fillText('honeyprinter', 12, 60);
      ctx.fillStyle = '#85907c'; ctx.font = '18px monospace'; ctx.fillText('NETWORK RECEIPT TERMINAL', 14, 103);
    }, 1.61, .44);
    badge.position.set(-.65,.87,1.395); this.printer.add(badge);
    const serial = makeLabel(256, 96, ctx => {
      ctx.fillStyle = '#a5ae97'; ctx.font = '23px monospace'; ctx.fillText('HP–001', 12, 37);
      ctx.fillStyle = '#68765e'; ctx.font = '15px monospace'; ctx.fillText('80 mm / DIRECT THERMAL', 12, 66);
    }, .70, .26);
    serial.position.set(1.09,.69,1.394); this.printer.add(serial);
    // The slot is an actual recess with a roller and raised tear bar.
    box([2.70,.022,.36], [0,1.763,.23], rubber, .06);
    const roller = new THREE.Mesh(new THREE.CylinderGeometry(.047,.047,2.48,24), rubber);
    roller.rotation.z = Math.PI/2; roller.position.set(0,1.785,.23); this.printer.add(roller); this.roller = roller;
    box([2.56,.025,.053], [0,1.79,.435], metal, .009);
    const teeth = [];
    for (let i = 0; i < 68; i++) {
      const x = -1.255 + i * .037;
      teeth.push(x,1.804,.414, x+.018,1.813,.40, x+.035,1.804,.414);
    }
    const teethGeo = new THREE.BufferGeometry(); teethGeo.setAttribute('position', new THREE.Float32BufferAttribute(teeth,3)); teethGeo.computeVertexNormals();
    const blade = new THREE.Mesh(teethGeo, new THREE.MeshStandardMaterial({color:0xbcc0b4,metalness:.8,roughness:.4,side:THREE.DoubleSide})); this.printer.add(blade);
    // The glass sits behind a thin molded rim, aligned with the serial label.
    box([.96,.30,.012], [1.09,.96,1.393], rubber, .025);
    for (const y of [.816,1.104]) box([.96,.026,.014], [1.09,y,1.405], seam, .008);
    for (const x of [.623,1.557]) box([.026,.262,.014], [x,.96,1.405], seam, .008);
    this.displayCanvas = document.createElement('canvas');
    this.displayCanvas.width = 440; this.displayCanvas.height = 120;
    this.displayTexture = new THREE.CanvasTexture(this.displayCanvas);
    this.displayTexture.colorSpace = THREE.SRGBColorSpace;
    this.displayTexture.anisotropy = Math.min(4,this.renderer.capabilities.getMaxAnisotropy());
    const display = new THREE.Mesh(new THREE.PlaneGeometry(.902,.242), new THREE.MeshStandardMaterial({map:this.displayTexture,roughness:.48}));
    display.position.set(1.09,.96,1.401); this.printer.add(display);
    this.updateDisplay();
    this.ledMaterial = new THREE.MeshStandardMaterial({color:0xa58c60, emissive:0x977d50, emissiveIntensity:.08, roughness:.25});
    box([.12,.017,.12],[1.32,1.765,.78],rubber,.04);
    const led = new THREE.Mesh(new THREE.SphereGeometry(.037,16,12),this.ledMaterial);
    led.scale.y=.35; led.position.set(1.32,1.78,.78); this.printer.add(led);
    const statusLabel = makeLabel(128,40,ctx => {ctx.fillStyle='#929c84';ctx.font='20px monospace';ctx.fillText('STATUS',12,26);},.30,.095);
    statusLabel.rotation.x=-Math.PI/2;statusLabel.position.set(1.32,1.768,1.0);this.printer.add(statusLabel);
    for (let i=0;i<9;i++) box([.014,.35,.045],[1.824,.79,-.85+i*.105],rubber,.007);
    box([.07,.25,.45],[1.826,1.39,.44],seam,.025);
    // Connector and soft cable resting on the same surface as the feet.
    box([.3,.22,.24],[1.2,.48,-1.42],rubber,.04);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.2,.48,-1.52),new THREE.Vector3(1.6,.2,-1.95),new THREE.Vector3(2.4,.075,-1.7),
      new THREE.Vector3(2.9,.07,-.6),new THREE.Vector3(3.6,.065,-.45),new THREE.Vector3(4.35,.055,-.95),
    ]);
    const cable = new THREE.Mesh(new THREE.TubeGeometry(curve,70,.028,8,false),rubber);cable.castShadow=true;this.printer.add(cable);
  }

  buildPaper() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(this.paper.positions,3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv',new THREE.BufferAttribute(new Float32Array((ROWS+1)*(COLS+1)*2),2).setUsage(THREE.DynamicDrawUsage));
    const indices=[];
    for(let row=0;row<ROWS;row++) for(let col=0;col<COLS;col++) {
      const a=row*(COLS+1)+col,b=a+1,c=a+COLS+1,d=c+1;
      indices.push(a,b,c,b,d,c);
    }
    geometry.setIndex(indices);geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({color:0xffffff,roughness:.9,metalness:0,side:THREE.DoubleSide});
    // Thermal paper is opaque. The back has only a hint of show-through.
    material.onBeforeCompile = shader => {
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
        if (!gl_FrontFacing) diffuseColor.rgb = mix(vec3(0.94, 0.93, 0.88), diffuseColor.rgb, 0.035);`);
    };
    this.sheet = new THREE.Mesh(geometry,material);
    this.sheet.castShadow=true;this.sheet.receiveShadow=true;this.sheet.frustumCulled=false;
    this.world.add(this.sheet);
  }

  rebuildAtlas() {
    const pages=this.pages.length ? this.pages : [null];
    const resolution=Math.min(3,this.renderer.capabilities.maxTextureSize/(pages.length*370));
    const canvas=document.createElement('canvas');canvas.width=Math.round(230*resolution);canvas.height=Math.round(pages.length*370*resolution);
    const ctx=context2d(canvas);ctx.scale(resolution,resolution);
    pages.forEach((receipt,index)=>{ctx.save();ctx.translate(0,index*370);drawReceipt(ctx,receipt);ctx.restore();});
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    texture.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
    texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
    this.sheet.material.map?.dispose();this.sheet.material.map=texture;this.sheet.material.needsUpdate=true;
    this.updatePaper();
  }

  updatePaper() {
    const uv=this.sheet.geometry.attributes.uv;
    const length=Math.max(1,this.pages.length)*PAGE_HEIGHT;
    for(let row=0;row<=ROWS;row++) for(let col=0;col<=COLS;col++) uv.setXY(row*(COLS+1)+col,col/COLS,1-(this.position-row/ROWS*LENGTH)/length);
    uv.needsUpdate=true;
    this.sheet.geometry.attributes.position.needsUpdate=true;
    this.sheet.geometry.computeVertexNormals();
  }

  resize() {
    const {width,height}=this.canvas.getBoundingClientRect();
    const mobile=matchMedia('(max-width:650px), (max-height:500px) and (max-width:1000px)').matches;
    this.compact = mobile;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
    this.renderer.setSize(width,height,false);
    const scale=Math.max(1,Math.min(width/(mobile?5.7:10.5),(height-(mobile?48:235))/5.5,105));
    const centerX=width*(mobile?.46:.53),groundY=mobile?height-42:height*.76-16;
    const offsetX=(width/2-centerX)/scale,offsetY=(groundY-height/2)/scale;
    this.camera.left=-width/scale/2+offsetX;this.camera.right=width/scale/2+offsetX;
    this.camera.top=height/scale/2+offsetY;this.camera.bottom=-height/scale/2+offsetY;
    this.camera.updateProjectionMatrix();
  }

  bindPointer() {
    const canvas=this.canvas;
    const locate=(event: PointerEvent)=>{
      const rect=canvas.getBoundingClientRect();
      this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
      this.raycaster.setFromCamera(this.pointer,this.camera);
    };
    const paperHit=()=>{
      const paper=this.raycaster.intersectObject(this.sheet)[0];
      if(!paper)return null;
      const body=this.raycaster.intersectObject(this.printer,true)[0];
      return body && body.distance<paper.distance ? null : paper;
    };
    canvas.addEventListener('pointermove',event=>{
      locate(event);
      if(this.paused)return;
      if(this.paper.grab) {
        const point=new THREE.Vector3();
        if(this.raycaster.ray.intersectPlane(this.dragPlane,point)) this.paper.grab.target=point.add(this.dragOffset).toArray();
      } else {
        const hit=paperHit();
        canvas.classList.toggle('grabbable',!!hit);
        if(hit && this.previousHit) {
          const force=hit.point.clone().sub(this.previousHit).multiplyScalar(90).clampLength(0,18);
          this.paper.gust={x:hit.point.x,y:hit.point.y,z:hit.point.z,force:force.toArray()};
        }
        this.previousHit=hit?.point.clone()??null;
      }
      this.requestFrame();
    });
    canvas.addEventListener('pointerdown',event=>{
      locate(event);const hit=paperHit();
      if(this.paused)return;
      if(!hit?.face)return;
      const vertices=[hit.face.a,hit.face.b,hit.face.c];
      let nearest=vertices[0],distance=Infinity;
      for(const index of vertices) {
        const point=new THREE.Vector3().fromArray(this.paper.positions,index*3),d=point.distanceTo(hit.point);
        if(d<distance){nearest=index;distance=d;}
      }
      const row=Math.floor(nearest/(COLS+1)),col=nearest%(COLS+1);
      if(row<3)return;
      const point=new THREE.Vector3().fromArray(this.paper.positions,nearest*3);
      this.dragPlane.setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()),hit.point);
      this.dragOffset.copy(point).sub(hit.point);
      this.paper.grab={row,col,target:point.toArray()};
      canvas.setPointerCapture(event.pointerId);canvas.classList.add('grabbing');
      event.preventDefault();
    });
    const release=()=>{this.paper.grab=null;canvas.classList.remove('grabbing');};
    canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
    canvas.addEventListener('pointerleave',()=>{this.previousHit=null;canvas.classList.remove('grabbable');});
  }

  showReceipt(receipt: ReceiptRecord,animate=true,direction=1) {
    if(!receipt)return;
    this.roll.select(receipt,direction,animate&&!this.paused);
    this.direction=this.roll.direction;this.onMotion(this.direction);
    this.rebuildAtlas();this.requestFrame();
  }

  private updateDisplay() {
    const text = this.paused ? 'PAUSED' : this.direction < 0 ? 'REWINDING' : this.direction > 0 ? 'PRINTING' : this.connected ? 'NEXT REPORT' : 'CONNECTING';
    const progress = this.connected && this.reportSyncedAt !== undefined
      ? clamp((this.reportAgeMs + performance.now() - this.reportSyncedAt) / 60_000,0,1) : 0;
    const filled = Math.round(356 * progress);
    const state = `${text}:${filled}`;
    if (state === this.displayState) return;
    this.displayState = state;
    const ctx = context2d(this.displayCanvas);
    const glass = ctx.createLinearGradient(0,0,0,120);
    glass.addColorStop(0,'#6a775d'); glass.addColorStop(.18,'#859273'); glass.addColorStop(1,'#7c896c');
    ctx.fillStyle = glass; ctx.fillRect(0,0,440,120);
    ctx.fillStyle = '#344130'; ctx.font = '36px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text,220,48);
    ctx.fillStyle = '#6a775e'; ctx.fillRect(42,89,356,7);
    ctx.fillStyle = '#44523a'; ctx.fillRect(42,89,filled,7);
    this.displayTexture.needsUpdate = true;
  }

  setReportTiming(createdAt: number, serverTime: number) {
    // Follow the observed report cadence, not the minute boundary. Hold at full
    // until a new receipt arrives rather than inventing a "preparing" state.
    this.reportAgeMs = Math.max(0,serverTime - createdAt);
    this.reportSyncedAt = performance.now();
    this.requestFrame();
  }

  setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.ledMaterial.color.setHex(connected ? 0xa9bd79 : 0xa58c60);
    this.ledMaterial.emissive.setHex(connected ? 0xa7c76e : 0x977d50);
    this.requestFrame();
  }

  setPaused(paused: boolean) {
    this.paused=paused;
    this.paper.grab=null;this.canvas.classList.remove('grabbing','grabbable');
    if(paused){this.roll.settle();this.direction=0;this.onMotion(0);this.paper.reset();this.updatePaper();}
    this.lastFrame=0;this.accumulator=0;this.requestFrame();
  }

  requestFrame() {
    if(!this.frameId&&!document.hidden&&!this.contextLost)this.frameId=requestAnimationFrame(timestamp=>this.frame(timestamp));
  }

  frame(timestamp: number) {
    this.frameId=0;
    if(document.hidden||this.contextLost)return;
    const dt=this.lastFrame?Math.min((timestamp-this.lastFrame)/1000,.05):1/60;
    // Render at 30 Hz on phones; fixed-step paper physics still runs at 60 Hz.
    if(!this.paused&&this.lastFrame&&dt<1/(this.compact?32:65)){this.requestFrame();return;}
    this.lastFrame=timestamp;
    if(!this.paused){
      this.accumulator+=dt;
      const previousDirection=this.direction;
      while(this.accumulator>=1/60){
        this.time+=1/60;
        this.roll.advance((.95+.16*Math.sin(this.time*33))/60);
        this.direction=this.roll.direction;
        this.paper.step(1/60,this.direction!==0);this.accumulator-=1/60;
      }
      if(previousDirection!==this.direction)this.onMotion(this.direction);
      this.updatePaper();
    }
    this.ledMaterial.emissiveIntensity = !this.connected ? .08 : !this.paused && this.direction !== 0 ? .4 + .15 * Math.sin(this.time * 8) : .32;
    this.updateDisplay();
    this.roller.rotation.x=-this.position/.047;
    this.renderer.render(this.world,this.camera);
    if(!this.paused)this.requestFrame();
  }
}

function makeLabel(width: number,height: number,paint: (context: CanvasRenderingContext2D) => void,worldWidth: number,worldHeight: number) {
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  paint(context2d(canvas));
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=4;
  return new THREE.Mesh(new THREE.PlaneGeometry(worldWidth,worldHeight),new THREE.MeshStandardMaterial({map,transparent:true,roughness:.7,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1}));
}

function makeGrain() {
  let seed=17;
  const data=new Uint8Array(64*64*4);
  for(let i=0;i<data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;const value=115+(seed>>>28);data[i]=data[i+1]=data[i+2]=value;data[i+3]=255;}
  const texture=new THREE.DataTexture(data,64,64);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  texture.repeat.set(6,6);texture.needsUpdate=true;return texture;
}
