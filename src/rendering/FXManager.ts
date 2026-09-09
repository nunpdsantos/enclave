import { BlurFilter, Container, Graphics } from 'pixi.js';
import { Difficulty } from '../core/Config';
import { Layout } from './LayoutManager';
import { THEME, lerpColor } from './Theme';

interface BgParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

/** Soft coloured light drifting behind the board */
interface AuroraBlob {
  color: number;
  radius: number;
  alpha: number;
  /** Lissajous parameters */
  ax: number; ay: number; fx: number; fy: number; phase: number;
}

/**
 * Screen-level effects: shake, slow-mo, flash, vignette, background
 * colour temperature, drifting particles and an aurora glow layer.
 */
export class FXManager {
  bgContainer: Container;
  fgContainer: Container;

  private shakeIntensity = 0;
  private shakeDuration = 0;
  private shakeElapsed = 0;
  private shakeTarget: Container | null = null;

  private impactTimeScale = 1;
  private impactDuration = 0;
  private impactElapsed = 0;

  private flashGraphics: Graphics;
  private flashAlpha = 0;
  private flashDecay = 0;
  private flashColor = 0xffffff;

  private bgParticles: BgParticle[] = [];
  private bgGfx: Graphics;
  private bgParticleCount = 25;

  private auroraGfx: Graphics;
  private auroras: AuroraBlob[] = [];
  private auroraTime = 0;

  private vignetteGfx: Graphics;
  private vignetteAlpha = 0;

  private colorTempT = 0;
  private bgColorSetter: ((color: number) => void) | null = null;
  private coolColor = THEME.bg;
  private warmColor = 0x6d2f6a;

  private flowIntensity = 0;
  private flowDecayTarget = 0;

  /** 1 is full strength; 0 is reduced motion, where nothing here moves */
  private intensityScale = 1;

  private layout!: Layout;

  constructor() {
    this.bgContainer = new Container();
    this.fgContainer = new Container();

    // Aurora: big translucent discs blurred at low resolution (cheap on phones)
    this.auroraGfx = new Graphics();
    const blur = new BlurFilter({ strength: 48, quality: 3, resolution: 0.2 });
    this.auroraGfx.filters = [blur];
    this.bgContainer.addChild(this.auroraGfx);

    this.bgGfx = new Graphics();
    this.bgContainer.addChild(this.bgGfx);

    this.flashGraphics = new Graphics();
    this.fgContainer.addChild(this.flashGraphics);

    this.vignetteGfx = new Graphics();
    this.fgContainer.addChild(this.vignetteGfx);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    this.initBgParticles();
    this.initAurora();
  }

  setShakeTarget(target: Container): void {
    this.shakeTarget = target;
  }

  setBgColorSetter(setter: (color: number) => void): void {
    this.bgColorSetter = setter;
  }

  /**
   * The single motion seam. At 0 the shake, flash, zoom pulse and slow-motion
   * triggers all become no-ops; the vignette and the ambient background are
   * left alone because they carry state, not motion.
   */
  setIntensityScale(scale: number): void {
    this.intensityScale = Math.max(0, Math.min(1, scale));
    if (this.intensityScale === 0) {
      // Cancel whatever is mid-flight, so switching mid-run takes effect now
      this.shakeDuration = 0;
      this.shakeElapsed = 0;
      this.flashAlpha = 0;
      this.impactDuration = 0;
      this.impactElapsed = 0;
    }
  }

  setDifficultyMood(difficulty: Difficulty): void {
    switch (difficulty) {
      case 'blitz':
        this.coolColor = 0x3d2f7d;
        this.warmColor = 0x8a3428;
        this.bgParticleCount = 34;
        break;
      // Smoke and ember rather than night sky: the siege's board is already
      // red, and the backdrop should belong to it
      case 'siege':
        this.coolColor = 0x2a1f3a;
        this.warmColor = 0x7f1d1d;
        this.bgParticleCount = 20;
        break;
      default:
        this.coolColor = THEME.bg;
        this.warmColor = 0x6d2f6a;
        this.bgParticleCount = 25;
        break;
    }
    if (this.layout) {
      this.initBgParticles();
      this.initAurora();
    }
  }

  // ── Triggers ──

  triggerShake(intensity: number, duration: number): void {
    if (this.intensityScale <= 0) return;
    this.shakeIntensity = intensity * this.intensityScale;
    this.shakeDuration = duration;
    this.shakeElapsed = 0;
  }

  triggerImpactFrame(timeScale: number, duration: number): void {
    if (this.intensityScale <= 0) return;
    this.impactTimeScale = timeScale;
    this.impactDuration = duration;
    this.impactElapsed = 0;
  }

  /** White by default; a colour is for a moment that has its own identity */
  triggerFlash(alpha: number = 0.4, decayRate: number = 8, color: number = 0xffffff): void {
    if (this.intensityScale <= 0) return;
    this.flashAlpha = alpha * this.intensityScale;
    this.flashDecay = decayRate;
    this.flashColor = color;
  }

  updateFlowState(streakCount: number): void {
    if (streakCount >= 8) this.flowDecayTarget = 1.0;
    else if (streakCount >= 6) this.flowDecayTarget = 0.85;
    else if (streakCount >= 4) this.flowDecayTarget = 0.6;
    else if (streakCount >= 2) this.flowDecayTarget = 0.35;
    else if (streakCount >= 1) this.flowDecayTarget = 0.15;
    else this.flowDecayTarget = 0;
  }

  boostFlow(intensity: number): void {
    this.flowIntensity = Math.max(this.flowIntensity, intensity);
    this.flowDecayTarget = Math.max(this.flowDecayTarget, intensity * 0.85);
  }

  get currentFlowIntensity(): number {
    return this.flowIntensity;
  }

  getAnimationDt(realDt: number): number {
    if (this.impactElapsed < this.impactDuration) return realDt * this.impactTimeScale;
    return realDt;
  }

  // ── Main update ──

  update(dt: number, drainRate: number, gameElapsed: number): void {
    if (!this.layout) return;
    this.updateShake(dt);
    if (this.impactElapsed < this.impactDuration) this.impactElapsed += dt;
    this.updateFlash(dt);

    const flowLerpSpeed = this.flowDecayTarget > this.flowIntensity ? 6 : 2;
    this.flowIntensity += (this.flowDecayTarget - this.flowIntensity) * Math.min(1, flowLerpSpeed * dt);

    this.updateAurora(dt, drainRate);
    this.updateBgParticles(dt, drainRate);
    this.updateVignette(drainRate);

    this.colorTempT = Math.min(1, gameElapsed / 240);
    const effectiveT = Math.min(1, this.colorTempT + this.flowIntensity * 0.3);
    if (this.bgColorSetter) this.bgColorSetter(lerpColor(this.coolColor, this.warmColor, effectiveT));
  }

  private updateShake(dt: number): void {
    if (!this.shakeTarget) return;
    if (this.shakeElapsed < this.shakeDuration) {
      this.shakeElapsed += dt;
      const decay = 1 - this.shakeElapsed / this.shakeDuration;
      const angle = Math.random() * Math.PI * 2;
      const offset = this.shakeIntensity * decay;
      this.shakeTarget.x = Math.cos(angle) * offset;
      this.shakeTarget.y = Math.sin(angle) * offset;
    } else {
      this.shakeTarget.x = 0;
      this.shakeTarget.y = 0;
    }
  }

  private updateFlash(dt: number): void {
    const g = this.flashGraphics;
    g.clear();
    if (this.flashAlpha > 0.01) {
      g.rect(0, 0, this.layout.width, this.layout.height);
      g.fill({ color: this.flashColor, alpha: this.flashAlpha });
      this.flashAlpha = Math.max(0, this.flashAlpha - this.flashDecay * dt);
    }
  }

  // ── Aurora ──

  private initAurora(): void {
    const base = Math.min(this.layout.width, this.layout.height);
    const palette = [THEME.accentGlow, THEME.magenta, THEME.cyan, THEME.gold];
    this.auroras = palette.map((color, i) => ({
      color,
      radius: base * (0.28 + i * 0.05),
      alpha: i === 3 ? 0.05 : 0.10,
      ax: this.layout.width * (0.3 + i * 0.12),
      ay: this.layout.height * (0.25 + i * 0.1),
      fx: 0.05 + i * 0.013,
      fy: 0.037 + i * 0.011,
      phase: i * 1.7,
    }));
  }

  private updateAurora(dt: number, drainRate: number): void {
    this.auroraTime += dt * (0.8 + Math.max(0, drainRate - 1) * 0.6 + this.flowIntensity * 0.8);
    const g = this.auroraGfx;
    g.clear();
    const cx = this.layout.width / 2;
    const cy = this.layout.height * 0.42;
    for (const a of this.auroras) {
      const x = cx + Math.sin(this.auroraTime * a.fx * 2 * Math.PI + a.phase) * a.ax * 0.9;
      const y = cy + Math.cos(this.auroraTime * a.fy * 2 * Math.PI + a.phase) * a.ay * 0.9;
      const pulse = 1 + Math.sin(this.auroraTime * 0.6 + a.phase) * 0.08;
      g.circle(x, y, a.radius * pulse);
      g.fill({ color: a.color, alpha: a.alpha + this.flowIntensity * 0.06 });
    }
  }

  // ── Particles ──

  private initBgParticles(): void {
    this.bgParticles = [];
    for (let i = 0; i < this.bgParticleCount; i++) this.bgParticles.push(this.spawnBgParticle());
  }

  private spawnBgParticle(): BgParticle {
    return {
      x: Math.random() * this.layout.width,
      y: Math.random() * this.layout.height,
      vx: (Math.random() - 0.5) * 15,
      vy: -10 - Math.random() * 20,
      size: 1.5 + Math.random() * 2,
      alpha: 0.1 + Math.random() * 0.15,
    };
  }

  private updateBgParticles(dt: number, drainRate: number): void {
    const g = this.bgGfx;
    g.clear();
    const effectiveSpeed = Math.max(1, drainRate) * (1 + this.flowIntensity * 3);
    for (const p of this.bgParticles) {
      p.x += p.vx * dt * effectiveSpeed;
      p.y += p.vy * dt * effectiveSpeed;
      if (p.y < -10) { p.y = this.layout.height + 10; p.x = Math.random() * this.layout.width; }
      if (p.x < -10) p.x = this.layout.width + 10;
      if (p.x > this.layout.width + 10) p.x = -10;
      if (drainRate > 1.5 || this.flowIntensity > 0.5) {
        const streak = Math.min(12, effectiveSpeed * 3);
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * dt * streak, p.y - p.vy * dt * streak);
        g.stroke({ color: 0xffffff, alpha: p.alpha * 0.6, width: p.size * 0.5 });
      }
      g.circle(p.x, p.y, p.size);
      g.fill({ color: 0xffffff, alpha: p.alpha });
    }
  }

  // ── Vignette ──

  private updateVignette(drainRate: number): void {
    const targetAlpha = Math.max(0, Math.min(0.4, drainRate - 1.3));
    const flowVignette = this.flowIntensity * 0.15;
    this.vignetteAlpha += (Math.max(targetAlpha, flowVignette) - this.vignetteAlpha) * 0.05;
    const g = this.vignetteGfx;
    g.clear();
    if (this.vignetteAlpha < 0.01) return;
    const w = this.layout.width, h = this.layout.height;
    const edge = Math.min(w, h) * 0.15;
    g.rect(0, 0, w, edge); g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.8 });
    g.rect(0, h - edge, w, edge); g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.8 });
    g.rect(0, 0, edge, h); g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.5 });
    g.rect(w - edge, 0, edge, h); g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.5 });
  }

  // ── Zoom pulse ──

  triggerZoomPulse(target: Container, pivotX: number, pivotY: number): void {
    if (this.intensityScale <= 0) return;
    target.pivot.set(pivotX, pivotY);
    target.position.set(pivotX, pivotY);
    target.scale.set(1.02);
    const startTime = performance.now();
    const ease = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= 100) {
        target.scale.set(1);
        target.pivot.set(0, 0);
        target.position.set(0, 0);
        return;
      }
      target.scale.set(1.02 - 0.02 * (elapsed / 100));
      requestAnimationFrame(ease);
    };
    requestAnimationFrame(ease);
  }
}
