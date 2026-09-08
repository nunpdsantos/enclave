import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters';
import { GridPos } from '../core/types';
import { Layout } from './LayoutManager';
import { FONT_DISPLAY, FONT_MONO, THEME, lighten } from './Theme';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  size: number; color: number; alpha: number; life: number; maxLife: number;
}

interface SpeedLine {
  x: number; y: number; vx: number; vy: number;
  length: number; alpha: number; life: number; maxLife: number;
}

interface Shockwave {
  x: number; y: number; maxRadius: number; color: number; width: number;
  life: number; maxLife: number;
}

interface ScorePopup {
  text: Text;
  startY: number;
  life: number;
  maxLife: number;
}

const MAX_PARTICLES = 600;

/**
 * Particles, speed lines, shockwave rings and floating text.
 * The glow layer (particles + rings) runs through a bloom filter so bright
 * effects bleed light the way they would on a real screen of neon.
 */
export class AnimationManager {
  container: Container;
  private glowLayer: Container;
  private particles: Particle[] = [];
  private speedLines: SpeedLine[] = [];
  private shockwaves: Shockwave[] = [];
  private popups: ScorePopup[] = [];
  private particleGraphics: Graphics;
  private speedLineGraphics: Graphics;
  private ringGraphics: Graphics;
  private layout!: Layout;
  /** 1 is full density; reduced motion thins every burst by this factor */
  private particleScale = 1;

  constructor() {
    this.container = new Container();
    this.glowLayer = new Container();
    this.particleGraphics = new Graphics();
    this.speedLineGraphics = new Graphics();
    this.ringGraphics = new Graphics();
    this.glowLayer.addChild(this.ringGraphics);
    this.glowLayer.addChild(this.particleGraphics);
    this.glowLayer.addChild(this.speedLineGraphics);
    this.container.addChild(this.glowLayer);

    const bloom = new AdvancedBloomFilter({ threshold: 0.35, bloomScale: 1.1, brightness: 1.0, blur: 6, quality: 4 });
    bloom.resolution = 0.5;
    this.glowLayer.filters = [bloom];
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
  }

  /**
   * The single density seam. Shockwaves, outlines and score popups are left
   * alone: they carry information, the particles are decoration.
   */
  setParticleScale(scale: number): void {
    this.particleScale = Math.max(0, Math.min(1, scale));
  }

  /** Round up, and never to nothing, so a thinned burst still reads as one */
  private scaled(count: number): number {
    if (this.particleScale >= 1) return count;
    return Math.max(1, Math.ceil(count * this.particleScale));
  }

  /** Burst from each cell — 15 particles per cell at full density */
  spawnClearEffect(cells: GridPos[], color: number): void {
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const glowColor = lighten(color, 0.4);
    const glowCount = this.scaled(8);
    const coreCount = this.scaled(7);
    for (const cell of cells) {
      const cx = gridOriginX + cell.col * cellSize + cellSize / 2;
      const cy = gridOriginY + cell.row * cellSize + cellSize / 2;
      for (let i = 0; i < glowCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 30 + Math.random() * 50;
        this.addParticle({
          x: cx + (Math.random() - 0.5) * 4, y: cy + (Math.random() - 0.5) * 4,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          size: 2 + Math.random() * 3, color: glowColor, alpha: 1, life: 0, maxLife: 0.5 + Math.random() * 0.5,
        });
      }
      for (let i = 0; i < coreCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 50 + Math.random() * 100;
        this.addParticle({
          x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 20,
          size: 2 + Math.random() * 3, color, alpha: 1, life: 0, maxLife: 0.5 + Math.random() * 0.5,
        });
      }
    }
  }

  /** Gold sparkles rising from a claimed room's cells */
  spawnClaimSparkles(cells: GridPos[], perCell: number = 6): void {
    const { gridOriginX, gridOriginY, cellSize } = this.layout;
    const count = this.scaled(perCell);
    for (const cell of cells) {
      const cx = gridOriginX + cell.col * cellSize + cellSize / 2;
      const cy = gridOriginY + cell.row * cellSize + cellSize / 2;
      for (let i = 0; i < count; i++) {
        this.addParticle({
          x: cx + (Math.random() - 0.5) * cellSize * 0.8,
          y: cy + (Math.random() - 0.5) * cellSize * 0.8,
          vx: (Math.random() - 0.5) * 30,
          vy: -40 - Math.random() * 80,
          size: 1.5 + Math.random() * 2.5,
          color: Math.random() < 0.7 ? THEME.gold : 0xffffff,
          alpha: 1, life: 0, maxLife: 0.7 + Math.random() * 0.6,
        });
      }
    }
  }

  spawnExplosion(cx: number, cy: number, count: number): void {
    const n = this.scaled(count);
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 100 + Math.random() * 200;
      this.addParticle({
        x: cx + (Math.random() - 0.5) * 20, y: cy + (Math.random() - 0.5) * 20,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        size: 3 + Math.random() * 4,
        color: [0xff4444, 0xfbbf24, 0x4a7af7, 0xffffff][Math.floor(Math.random() * 4)],
        alpha: 1, life: 0, maxLife: 0.8 + Math.random() * 0.6,
      });
    }
  }

  spawnSpeedLines(cx: number, cy: number, count: number = 10): void {
    const n = this.scaled(count);
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 200 + Math.random() * 300;
      this.speedLines.push({
        x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        length: 15 + Math.random() * 20, alpha: 0.3 + Math.random() * 0.2, life: 0, maxLife: 0.2,
      });
    }
  }

  /** Expanding ring, fading as it grows */
  spawnShockwave(cx: number, cy: number, maxRadius: number, color: number, width: number = 4, duration: number = 0.5): void {
    this.shockwaves.push({ x: cx, y: cy, maxRadius, color, width, life: 0, maxLife: duration });
  }

  private addParticle(p: Particle): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  showScorePopup(score: number, x: number, y: number, isCombo: boolean): void {
    let fontSize: number;
    let maxLife: number;
    if (score >= 2000) { fontSize = 46; maxLife = 1.6; }
    else if (score >= 500) { fontSize = 40; maxLife = 1.4; }
    else if (score >= 100) { fontSize = 32; maxLife = 1.1; }
    else { fontSize = 24; maxLife = 0.9; }
    const color = isCombo ? THEME.gold : THEME.textPrimary;
    const text = new Text({
      text: `+${score.toLocaleString()}`,
      style: new TextStyle({
        fontFamily: FONT_MONO, fontSize, fill: color, letterSpacing: 1,
        stroke: { color: 0x0a0e20, width: Math.max(2, fontSize * 0.08) },
        dropShadow: { alpha: 0.6, blur: 10, color: isCombo ? THEME.gold : 0x3b82f6, distance: 0 },
      }),
    });
    text.anchor.set(0.5);
    text.x = x;
    text.y = y;
    this.container.addChild(text);
    this.popups.push({ text, startY: y, life: 0, maxLife });
  }

  showStreakPopup(streak: number, customLabel?: string): void {
    if (!this.layout) return;
    let label = customLabel || '';
    if (!customLabel) {
      if (streak >= 8) label = 'UNSTOPPABLE';
      else if (streak >= 5) label = 'INCREDIBLE';
      else if (streak >= 3) label = 'AMAZING';
      else if (streak >= 2) label = 'GREAT';
      else return;
    }
    const text = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: '800', fill: THEME.gold, letterSpacing: 6,
        stroke: { color: 0x0a0e20, width: 3 },
        dropShadow: { alpha: 0.7, blur: 12, color: THEME.gold, distance: 0 },
      }),
    });
    text.anchor.set(0.5);
    text.x = this.layout.width / 2;
    text.y = this.layout.height / 2 - 50;
    this.container.addChild(text);
    this.popups.push({ text, startY: text.y, life: 0, maxLife: 1.3 });
  }

  showTimeBonusPopup(label: string, x: number, y: number, fontSize: number = 16): void {
    const text = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: FONT_MONO, fontSize, fill: 0x4ade80, letterSpacing: 1,
        stroke: { color: 0x0a0e20, width: 2 },
        dropShadow: { alpha: 0.5, blur: 6, color: 0x20bf6b, distance: 0 },
      }),
    });
    text.anchor.set(0.5);
    text.x = x;
    text.y = y;
    this.container.addChild(text);
    this.popups.push({ text, startY: y, life: 0, maxLife: fontSize > 16 ? 0.9 : 0.6 });
  }

  showCenterAlert(label: string, color: number = 0xff4444, fontSize: number = 28): void {
    if (!this.layout) return;
    const text = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: FONT_DISPLAY, fontSize, fontWeight: '800', fill: color, letterSpacing: 4,
        stroke: { color: 0x0a0e20, width: 3 },
        dropShadow: { alpha: 0.8, blur: 14, color, distance: 0 },
      }),
    });
    text.anchor.set(0.5);
    text.x = this.layout.width / 2;
    text.y = this.layout.height / 2;
    this.container.addChild(text);
    this.popups.push({ text, startY: text.y, life: 0, maxLife: 1.0 });
  }

  update(dt: number): void {
    // Particles
    const g = this.particleGraphics;
    g.clear();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) { this.particles.splice(i, 1); continue; }
      const t = p.life / p.maxLife;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 150 * dt;
      p.alpha = 1 - easeIn(t);
      p.size *= 0.97;
      g.circle(p.x, p.y, p.size * 1.5);
      g.fill({ color: p.color, alpha: p.alpha * 0.2 });
      g.circle(p.x, p.y, p.size);
      g.fill({ color: p.color, alpha: p.alpha });
    }

    // Speed lines
    const sg = this.speedLineGraphics;
    sg.clear();
    for (let i = this.speedLines.length - 1; i >= 0; i--) {
      const l = this.speedLines[i];
      l.life += dt;
      if (l.life >= l.maxLife) { this.speedLines.splice(i, 1); continue; }
      const t = l.life / l.maxLife;
      l.x += l.vx * dt;
      l.y += l.vy * dt;
      const len = Math.hypot(l.vx, l.vy);
      const dx = (l.vx / len) * l.length;
      const dy = (l.vy / len) * l.length;
      sg.moveTo(l.x, l.y);
      sg.lineTo(l.x - dx, l.y - dy);
      sg.stroke({ color: 0xffffff, alpha: l.alpha * (1 - t), width: 1.5 });
    }

    // Shockwaves
    const rg = this.ringGraphics;
    rg.clear();
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.life += dt;
      if (s.life >= s.maxLife) { this.shockwaves.splice(i, 1); continue; }
      const t = easeOut(s.life / s.maxLife);
      const radius = s.maxRadius * t;
      rg.circle(s.x, s.y, radius);
      rg.stroke({ color: s.color, alpha: (1 - t) * 0.9, width: s.width * (1 - t * 0.5) });
      rg.circle(s.x, s.y, radius * 0.85);
      rg.stroke({ color: 0xffffff, alpha: (1 - t) * 0.35, width: 1.5 });
    }

    // Popups
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const popup = this.popups[i];
      popup.life += dt;
      if (popup.life >= popup.maxLife) {
        this.container.removeChild(popup.text);
        popup.text.destroy();
        this.popups.splice(i, 1);
        continue;
      }
      const t = popup.life / popup.maxLife;
      const scale = t < 0.15 ? 1 + 0.3 * easeOut(t / 0.15) : 1.3 - 0.3 * easeOut((t - 0.15) / 0.85);
      popup.text.y = popup.startY - 50 * easeOut(t);
      popup.text.alpha = t < 0.8 ? 1 : 1 - easeIn((t - 0.8) / 0.2);
      popup.text.scale.set(Math.max(0.5, scale));
    }
  }
}

function easeIn(t: number): number { return t * t; }
function easeOut(t: number): number { return 1 - (1 - t) * (1 - t); }
