import { Container, Graphics } from 'pixi.js';
import { Difficulty } from '../core/Config';
import { Layout } from './LayoutManager';
import { THEME, lerpColor } from './Theme';

// ── Background particle ──
interface BgParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

export class FXManager {
  bgContainer: Container;
  fgContainer: Container;

  // ── Shake ──
  private shakeIntensity = 0;
  private shakeDuration = 0;
  private shakeElapsed = 0;
  private shakeTarget: Container | null = null;

  // ── Impact frame (slow-mo on clears, animation dt only) ──
  private impactTimeScale = 1;
  private impactDuration = 0;
  private impactElapsed = 0;

  // ── Screen flash ──
  private flashGraphics: Graphics;
  private flashAlpha = 0;
  private flashDecay = 0;

  // ── Background particles ──
  private bgParticles: BgParticle[] = [];
  private bgGfx: Graphics;
  private bgParticleCount = 25;

  // ── Vignette ──
  private vignetteGfx: Graphics;
  private vignetteAlpha = 0;

  // ── Color temperature ──
  private colorTempT = 0; // 0 = cool blue, 1 = warm
  private bgColorSetter: ((color: number) => void) | null = null;
  private coolColor = 0x3d4c9a;
  private warmColor = 0x7d3660;

  // ── Flow state (streak-driven) ──
  private flowIntensity = 0; // 0-1, driven by streak
  private flowDecayTarget = 0;

  private layout!: Layout;

  constructor() {
    this.bgContainer = new Container();
    this.fgContainer = new Container();

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
  }

  setShakeTarget(target: Container): void {
    this.shakeTarget = target;
  }

  setBgColorSetter(setter: (color: number) => void): void {
    this.bgColorSetter = setter;
  }

  setDifficultyMood(difficulty: Difficulty): void {
    switch (difficulty) {
      case 'classic':
        this.coolColor = 0x35658b;
        this.warmColor = 0x1b9b7d;
        this.bgParticleCount = 18;
        break;
      case 'blitz':
        this.coolColor = 0x46377d;
        this.warmColor = 0xae4028;
        this.bgParticleCount = 34;
        break;
      default:
        this.coolColor = 0x3d4c9a;
        this.warmColor = 0x7d3660;
        this.bgParticleCount = 25;
        break;
    }

    if (this.layout) {
      this.initBgParticles();
    }
  }

  // ── Triggers ──

  /** Screen shake: random displacement decaying over duration */
  triggerShake(intensity: number, duration: number): void {
    this.shakeIntensity = intensity;
    this.shakeDuration = duration;
    this.shakeElapsed = 0;
  }

  /** Impact frame: slow-motion for animation dt only */
  triggerImpactFrame(timeScale: number, duration: number): void {
    this.impactTimeScale = timeScale;
    this.impactDuration = duration;
    this.impactElapsed = 0;
  }

  /** White screen flash */
  triggerFlash(alpha: number = 0.4, decayRate: number = 8): void {
    this.flashAlpha = alpha;
    this.flashDecay = decayRate;
  }

  // ── Flow state update (called from GameScene) ──

  updateFlowState(streakCount: number): void {
    // Target intensity based on streak
    if (streakCount >= 10) this.flowDecayTarget = 1.0;
    else if (streakCount >= 8) this.flowDecayTarget = 0.85;
    else if (streakCount >= 5) this.flowDecayTarget = 0.6;
    else if (streakCount >= 3) this.flowDecayTarget = 0.35;
    else if (streakCount >= 2) this.flowDecayTarget = 0.15;
    else this.flowDecayTarget = 0;
  }

  boostFlow(intensity: number): void {
    this.flowIntensity = Math.max(this.flowIntensity, intensity);
    this.flowDecayTarget = Math.max(this.flowDecayTarget, intensity * 0.85);
  }

  get currentFlowIntensity(): number {
    return this.flowIntensity;
  }

  /** Get the adjusted dt accounting for impact frame slow-mo */
  getAnimationDt(realDt: number): number {
    if (this.impactElapsed < this.impactDuration) {
      return realDt * this.impactTimeScale;
    }
    return realDt;
  }

  // ── Main update ──

  update(dt: number, drainRate: number, gameElapsed: number): void {
    if (!this.layout) return;

    // Shake
    this.updateShake(dt);

    // Impact frame timer
    if (this.impactElapsed < this.impactDuration) {
      this.impactElapsed += dt;
    }

    // Flash
    this.updateFlash(dt);

    // Flow intensity smooth lerp
    const flowLerpSpeed = this.flowDecayTarget > this.flowIntensity ? 6 : 2;
    this.flowIntensity += (this.flowDecayTarget - this.flowIntensity) * Math.min(1, flowLerpSpeed * dt);

    // Background particles
    this.updateBgParticles(dt, drainRate);

    // Vignette
    this.updateVignette(drainRate);

    // Color temperature (shift over 4 minutes)
    this.colorTempT = Math.min(1, gameElapsed / 240);
    // Flow state accelerates color temp
    const effectiveT = Math.min(1, this.colorTempT + this.flowIntensity * 0.3);
    if (this.bgColorSetter) {
      const color = lerpColor(this.coolColor, this.warmColor, effectiveT);
      this.bgColorSetter(color);
    }
  }

  // ── Shake ──

  private updateShake(dt: number): void {
    if (!this.shakeTarget) return;
    if (this.shakeElapsed < this.shakeDuration) {
      this.shakeElapsed += dt;
      const t = this.shakeElapsed / this.shakeDuration;
      const decay = 1 - t;
      const angle = Math.random() * Math.PI * 2;
      const offset = this.shakeIntensity * decay;
      this.shakeTarget.x = Math.cos(angle) * offset;
      this.shakeTarget.y = Math.sin(angle) * offset;
    } else {
      this.shakeTarget.x = 0;
      this.shakeTarget.y = 0;
    }
  }

  // ── Flash ──

  private updateFlash(dt: number): void {
    const g = this.flashGraphics;
    g.clear();
    if (this.flashAlpha > 0.01) {
      g.rect(0, 0, this.layout.width, this.layout.height);
      g.fill({ color: 0xffffff, alpha: this.flashAlpha });
      this.flashAlpha -= this.flashDecay * dt;
      if (this.flashAlpha < 0) this.flashAlpha = 0;
    }
  }

  // ── Background particles ──

  private initBgParticles(): void {
    this.bgParticles = [];
    for (let i = 0; i < this.bgParticleCount; i++) {
      this.bgParticles.push(this.spawnBgParticle());
    }
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

    const speedMult = Math.max(1, drainRate);
    // Flow state boosts particles
    const flowBoost = 1 + this.flowIntensity * 3;
    const effectiveSpeed = speedMult * flowBoost;

    for (const p of this.bgParticles) {
      p.x += p.vx * dt * effectiveSpeed;
      p.y += p.vy * dt * effectiveSpeed;

      // Wrap
      if (p.y < -10) { p.y = this.layout.height + 10; p.x = Math.random() * this.layout.width; }
      if (p.x < -10) p.x = this.layout.width + 10;
      if (p.x > this.layout.width + 10) p.x = -10;

      // At high drain or flow, draw streaks
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
    // Vignette scales from 0 at drainRate 1.3 to 0.4 at drainRate 2.3
    const targetAlpha = Math.max(0, Math.min(0.4, (drainRate - 1.3)));
    // Flow state also adds vignette
    const flowVignette = this.flowIntensity * 0.15;
    this.vignetteAlpha += ((Math.max(targetAlpha, flowVignette)) - this.vignetteAlpha) * 0.05;

    const g = this.vignetteGfx;
    g.clear();
    if (this.vignetteAlpha < 0.01) return;

    const w = this.layout.width;
    const h = this.layout.height;
    const edgeSize = Math.min(w, h) * 0.15;

    // Top edge
    g.rect(0, 0, w, edgeSize);
    g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.8 });
    // Bottom edge
    g.rect(0, h - edgeSize, w, edgeSize);
    g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.8 });
    // Left edge
    g.rect(0, 0, edgeSize, h);
    g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.5 });
    // Right edge
    g.rect(w - edgeSize, 0, edgeSize, h);
    g.fill({ color: 0x000000, alpha: this.vignetteAlpha * 0.5 });
  }

  // ── Zoom pulse (applied to gameContent) ──

  triggerZoomPulse(target: Container, pivotX: number, pivotY: number): void {
    target.pivot.set(pivotX, pivotY);
    target.position.set(pivotX, pivotY);
    target.scale.set(1.02);
    // Ease back over 100ms — we'll handle in update
    const startTime = performance.now();
    const ease = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= 100) {
        target.scale.set(1);
        target.pivot.set(0, 0);
        target.position.set(0, 0);
        return;
      }
      const t = elapsed / 100;
      const s = 1.02 - 0.02 * t;
      target.scale.set(s);
      requestAnimationFrame(ease);
    };
    requestAnimationFrame(ease);
  }
}
