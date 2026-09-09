import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Scene } from './SceneManager';
import { GameState } from '../core/GameState';
import { makePiece } from '../core/Pieces';
import { LayoutManager } from '../rendering/LayoutManager';
import { GridRenderer } from '../rendering/GridRenderer';
import { HandRenderer } from '../rendering/HandRenderer';
import { GhostRenderer } from '../rendering/GhostRenderer';
import { UIRenderer } from '../rendering/UIRenderer';
import { AnimationManager } from '../rendering/AnimationManager';
import { FXManager } from '../rendering/FXManager';
import { DragController, DragState } from '../input/DragController';
import { AudioManager } from '../audio/AudioManager';
import { INNER_CELLS } from '../core/Board';
import { FeedbackEvent, GridPos, PieceInstance, Region, RunEndCause, RunSummary } from '../core/types';
import { Difficulty, DIFFICULTY_LABELS, GameConfig } from '../core/Config';
import { getProgressStatus } from '../core/Progression';
import { loadSettings, updateSettings } from '../core/Settings';
import {
  MOTION_LABELS, MOTION_ORDER, REDUCED_PARTICLE_SCALE, isReducedMotion, onReducedMotionChange,
} from '../core/Accessibility';
import { reportRun } from '../core/Telemetry';
import { FONT_DISPLAY, THEME, drawPanel } from '../rendering/Theme';
import { createButton, createToggle, createCycleToggle, createBodyText } from '../rendering/Widgets';

type Phase = 'tutorial' | 'countdown' | 'playing' | 'gameOver';

/** What the ghost's current drop would seal, and what it would pay */
interface ClosePreview {
  regions: Region[];
  points: number;
}

/** 0.75 → "0.75", 0.5 → "0.5": two decimals, no trailing zeros */
function formatFactor(factor: number): string {
  return factor.toFixed(2).replace(/\.?0+$/, '');
}

export class GameScene implements Scene {
  container: Container;
  private gameContent: Container;
  private gameState: GameState;
  private layoutManager: LayoutManager;
  private gridRenderer: GridRenderer;
  private handRenderer: HandRenderer;
  private ghostRenderer: GhostRenderer;
  private uiRenderer: UIRenderer;
  private animationManager: AnimationManager;
  private fxManager: FXManager;
  private dragController: DragController;
  private audioManager: AudioManager;
  private canvas: HTMLCanvasElement;
  private onGameOver: (summary: RunSummary) => void;
  private onQuit: () => void;
  private bgColorSetter: ((color: number) => void) | null = null;

  private paused = false;
  private pauseOverlay: Container | null = null;
  private pauseBtn: Container | null = null;
  private tutorialOverlay: Container | null = null;

  private phase: Phase = 'countdown';
  private countdownTime = 3;
  private countdownText: Text | null = null;
  private lastCountdownNumber = 4;

  private alertsFired = { ten: false, five: false, two: false };
  private lastTickSecond = -1;
  private lastHapticSecond = -1;
  private progressTierIndex = 0;
  private skipCountdown: boolean;
  private hapticsEnabled: boolean;
  /** Unsubscribes the OS reduced-motion watcher while this scene is on screen */
  private stopMotionWatch: (() => void) | null = null;

  private gameOverSequenceActive = false;
  private gameOverElapsed = 0;
  /** Guards the one telemetry report per run (quit and death share a path) */
  private runReported = false;

  /**
   * Single-entry memo for the close preview. The ghost is redrawn on every
   * pointer move, but what a drop would claim only changes when the piece,
   * the cell under it, or the board does — so that is the key.
   */
  private previewKey = '';
  private previewValue: ClosePreview | null = null;
  private boardVersion = 0;

  private onVisibilityChange = () => {
    if (document.hidden && this.phase === 'playing' && !this.paused) this.pause();
  };
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      if (this.phase !== 'playing') return;
      if (this.paused) this.resume(); else this.pause();
      return;
    }
    if (this.phase !== 'playing' || this.paused) return;
    if (e.key === 'r' || e.key === 'R' || e.key === 'ArrowUp' || e.key === ' ') {
      e.preventDefault();
      this.rotate();
    } else if (e.key === 'h' || e.key === 'H' || e.key === 'Shift') {
      this.holdPiece();
    }
  };

  constructor(
    canvas: HTMLCanvasElement,
    layoutManager: LayoutManager,
    audioManager: AudioManager,
    config: GameConfig,
    difficulty: Difficulty,
    skipCountdown: boolean,
    onGameOver: (summary: RunSummary) => void,
    onQuit: () => void,
    bgColorSetter?: (color: number) => void,
  ) {
    this.canvas = canvas;
    this.layoutManager = layoutManager;
    this.audioManager = audioManager;
    this.onGameOver = onGameOver;
    this.onQuit = onQuit;
    this.skipCountdown = skipCountdown;
    this.bgColorSetter = bgColorSetter || null;
    this.container = new Container();
    this.hapticsEnabled = loadSettings().haptics;

    this.gameState = new GameState(config, difficulty);
    this.gridRenderer = new GridRenderer();
    this.handRenderer = new HandRenderer();
    this.ghostRenderer = new GhostRenderer();
    this.uiRenderer = new UIRenderer();
    this.animationManager = new AnimationManager();
    this.fxManager = new FXManager();
    this.dragController = new DragController(layoutManager, this.gameState.board);

    this.gameContent = new Container();
    this.container.addChild(this.fxManager.bgContainer);
    this.gameContent.addChild(this.gridRenderer.container);
    this.gameContent.addChild(this.ghostRenderer.container);
    this.gameContent.addChild(this.handRenderer.container);
    this.gameContent.addChild(this.uiRenderer.container);
    this.gameContent.addChild(this.animationManager.container);
    this.container.addChild(this.gameContent);
    this.container.addChild(this.fxManager.fgContainer);

    this.fxManager.setShakeTarget(this.gameContent);
    this.fxManager.setDifficultyMood(difficulty);
    if (this.bgColorSetter) this.fxManager.setBgColorSetter(this.bgColorSetter);
    this.applyMotionSetting();

    this.setupInput();
  }

  /**
   * Push the resolved motion preference into the two seams that own it: the
   * FX intensity and the particle density. Claim outlines, dissolves and the
   * score popups are untouched, because they say what just happened.
   */
  private applyMotionSetting(): void {
    const reduced = isReducedMotion();
    this.fxManager.setIntensityScale(reduced ? 0 : 1);
    this.animationManager.setParticleScale(reduced ? REDUCED_PARTICLE_SCALE : 1);
  }

  enter(): void {
    const layout = this.layoutManager.layout;
    this.gridRenderer.setLayout(layout);
    this.handRenderer.setLayout(layout);
    this.ghostRenderer.setLayout(layout);
    this.uiRenderer.setLayout(layout);
    this.animationManager.setLayout(layout);
    this.fxManager.setLayout(layout);
    this.buildPauseButton();

    this.gameState.start();
    this.boardVersion++; // the board just reset: any memoised preview is stale
    this.dragController.setCurrent(this.gameState.current);
    this.dragController.updateBoard(this.gameState.board);

    this.gridRenderer.drawBlocks(this.gameState.board.grid);
    if (this.gameState.config.territory.enabled) {
      this.gridRenderer.drawFloor(this.gameState.board.lit);
      this.uiRenderer.updateSurvey(0, INNER_CELLS, 0);
    }
    this.refreshHand(true);
    this.uiRenderer.updateScore(this.gameState.score);
    this.uiRenderer.updateHighScore(this.gameState.highScore);
    this.uiRenderer.updateStreak(0);
    if (this.gameState.config.clock.enabled) {
      this.uiRenderer.updateTimer(this.gameState.timeRemaining, this.gameState.maxTime, 0);
      this.uiRenderer.updateSpeedBar(1, this.gameState.config.timer.speedWindowSeconds, 0);
    }
    this.updateProgressPresentation(false);

    this.countdownTime = this.skipCountdown ? 0 : 3;
    this.lastCountdownNumber = 4;
    this.alertsFired = { ten: false, five: false, two: false };
    this.lastTickSecond = -1;
    this.lastHapticSecond = -1;
    this.progressTierIndex = getProgressStatus(this.gameState.difficulty, this.gameState.score).tierIndex;
    this.gameOverSequenceActive = false;
    this.gameOverElapsed = 0;
    this.runReported = false;

    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('keydown', this.onKeyDown);
    // Follow the OS switch too, so flipping it mid-run applies immediately
    this.stopMotionWatch = onReducedMotionChange(() => this.applyMotionSetting());

    // Debug hook for automated tests: ?debug in the URL exposes the run state
    if (new URLSearchParams(window.location.search).has('debug')) {
      (window as unknown as { __enclave: unknown }).__enclave = {
        state: this.gameState,
        makePiece,
        refresh: () => {
          this.refreshBoard();
          this.gridRenderer.drawFloor(this.gameState.board.lit);
          this.refreshHand(false);
          this.syncInput();
        },
      };
    }

    if (!loadSettings().tutorialSeen) {
      this.phase = 'tutorial';
      this.buildTutorialOverlay();
    } else if (this.skipCountdown) {
      this.beginPlay();
      this.fxManager.triggerFlash(0.16, 10);
      this.showCenterAlert(`${DIFFICULTY_LABELS[this.gameState.difficulty]} MODE`, THEME.accent, 22);
    } else {
      this.phase = 'countdown';
    }
  }

  exit(): void {
    this.dragController.detach(this.canvas);
    this.audioManager.stopMusic();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('keydown', this.onKeyDown);
    this.stopMotionWatch?.();
    this.stopMotionWatch = null;
    if (this.countdownText) {
      this.container.removeChild(this.countdownText);
      this.countdownText.destroy();
      this.countdownText = null;
    }
    this.removeTutorialOverlay();
    this.removePauseOverlay();
  }

  resize(width: number, height: number): void {
    const layout = this.layoutManager.recalculate(width, height);
    this.gridRenderer.setLayout(layout);
    this.handRenderer.setLayout(layout);
    this.ghostRenderer.setLayout(layout);
    this.uiRenderer.setLayout(layout);
    this.animationManager.setLayout(layout);
    this.fxManager.setLayout(layout);
    this.gridRenderer.drawBlocks(this.gameState.board.grid);
    this.refreshHand(false);
    this.updateProgressPresentation(false);
    this.buildPauseButton();
  }

  update(dt: number): void {
    if (this.paused) return;
    const animDt = this.fxManager.getAnimationDt(dt);
    this.handRenderer.update(animDt);
    this.gridRenderer.update(animDt);
    this.uiRenderer.update(dt);

    if (this.gameOverSequenceActive) {
      this.updateGameOverSequence(dt);
      this.fxManager.update(dt, this.gameState.drainRate, this.gameState.gameElapsed);
      this.animationManager.update(animDt);
      return;
    }
    if (this.phase === 'tutorial') { this.fxManager.update(dt, 1, 0); return; }
    if (this.phase === 'countdown') { this.updateCountdown(dt); this.fxManager.update(dt, 1, 0); return; }

    this.animationManager.update(animDt);
    if (this.gameState.tick(dt)) { this.startGameOverSequence(); return; }

    this.fxManager.update(dt, this.gameState.drainRate, this.gameState.gameElapsed);
    // Without a clock there is no bar to fill, no urgency to announce and no
    // second to tick: the budget readout is refreshed by the hand instead.
    // Everything downstream of the clock still reads a resting timeRemaining,
    // which keeps the glow and the music in their calm state rather than NaN.
    if (this.gameState.config.clock.enabled) {
      this.uiRenderer.updateTimer(this.gameState.timeRemaining, this.gameState.maxTime, dt);
      this.uiRenderer.updateSpeedBar(
        this.gameState.currentSpeedFraction,
        this.gameState.config.timer.speedWindowSeconds,
        this.gameState.pieceElapsed,
      );
      this.updateCountdownTicks();
      this.updateCriticalAlerts();
    }
    this.audioManager.updateMusic(
      this.gameState.drainRate,
      this.gameState.streakCount,
      this.gameState.timeRemaining / this.gameState.maxTime,
      this.fxManager.currentFlowIntensity,
    );
    this.gridRenderer.updateGlow(dt, this.gameState.timeRemaining, this.gameState.board.occupiedCount() / 81);

    if (this.gameState.config.clock.enabled && this.gameState.timeRemaining <= 5) {
      const sec = Math.ceil(this.gameState.timeRemaining);
      if (sec !== this.lastHapticSecond && sec > 0) { this.lastHapticSecond = sec; this.haptic(16); }
    }
  }

  private beginPlay(): void {
    this.phase = 'playing';
    this.dragController.attach(this.canvas);
    this.audioManager.startMusic();
  }

  // ── Tutorial ──

  private buildTutorialOverlay(): void {
    const layout = this.layoutManager.layout;
    const overlay = new Container();
    const bg = new Graphics();
    bg.rect(0, 0, layout.width, layout.height);
    bg.fill({ color: THEME.overlay, alpha: 0.84 });
    bg.eventMode = 'static';
    bg.on('pointerdown', (e) => e.stopPropagation());
    overlay.addChild(bg);

    const panelW = Math.min(340, layout.width - 32);
    const panelH = 360;
    const px = layout.width / 2 - panelW / 2;
    const py = layout.height / 2 - panelH / 2;
    const panel = new Graphics();
    drawPanel(panel, px, py, panelW, panelH, 18, 0.92);
    overlay.addChild(panel);

    const title = new Text({
      text: 'HOW TO PLAY',
      style: new TextStyle({ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: '800', fill: THEME.textPrimary, letterSpacing: 5 }),
    });
    title.anchor.set(0.5, 0);
    title.x = layout.width / 2;
    title.y = py + 22;
    overlay.addChild(title);

    const steps = [
      ['1', 'DRAG the piece in your hand onto the board. Tap it, or the ROTATE button, to turn it.'],
      ['2', 'FENCE IN empty space with blocks to claim it. The room and its walls vanish, and you score the room\'s area squared: 3×3 is worth nine times a 1×1.'],
      ['3', 'THE CLOCK never stops. Placements add time, claims add more. Gold cells show where one block would close a room.'],
    ];
    let y = py + 64;
    for (const [n, body] of steps) {
      const badge = new Graphics();
      badge.circle(px + 30, y + 12, 12);
      badge.fill({ color: THEME.accent });
      overlay.addChild(badge);
      const num = new Text({ text: n, style: new TextStyle({ fontFamily: FONT_DISPLAY, fontSize: 13, fontWeight: '800', fill: THEME.textPrimary }) });
      num.anchor.set(0.5);
      num.x = px + 30;
      num.y = y + 12;
      overlay.addChild(num);
      const text = createBodyText(body, px + 52, y, { fontSize: 12.5, wrapWidth: panelW - 70, align: 'left' });
      overlay.addChild(text);
      y += text.height + 16;
    }

    overlay.addChild(createButton("LET'S GO", layout.width / 2, py + panelH - 40, () => {
      this.audioManager.unlock();
      this.audioManager.playUiClick();
      updateSettings({ tutorialSeen: true });
      this.removeTutorialOverlay();
      this.phase = 'countdown';
      this.countdownTime = 3;
      this.lastCountdownNumber = 4;
    }, { width: 180, height: 46, fontSize: 16 }));

    this.tutorialOverlay = overlay;
    this.container.addChild(overlay);
  }

  private removeTutorialOverlay(): void {
    if (this.tutorialOverlay) {
      this.container.removeChild(this.tutorialOverlay);
      this.tutorialOverlay.destroy({ children: true });
      this.tutorialOverlay = null;
    }
  }

  // ── Countdown ──

  private updateCountdown(dt: number): void {
    this.countdownTime -= dt;
    const currentNum = Math.ceil(this.countdownTime);
    if (currentNum !== this.lastCountdownNumber && currentNum > 0) {
      this.lastCountdownNumber = currentNum;
      this.showCountdownNumber(String(currentNum));
      this.audioManager.playTick();
    }
    if (this.countdownTime <= 0) {
      this.showCountdownNumber('GO!', true);
      this.audioManager.playGoChime();
      this.fxManager.triggerFlash(0.3, 6);
      this.beginPlay();
    }
  }

  private showCountdownNumber(text: string, isGo = false): void {
    if (this.countdownText) {
      this.container.removeChild(this.countdownText);
      this.countdownText.destroy();
    }
    const layout = this.layoutManager.layout;
    const t = new Text({
      text,
      style: new TextStyle({
        fontFamily: FONT_DISPLAY, fontSize: 72, fontWeight: '800',
        fill: isGo ? THEME.gold : THEME.textPrimary, letterSpacing: 8,
        dropShadow: { alpha: 0.7, blur: 16, color: isGo ? THEME.gold : 0x3b82f6, distance: 0 },
      }),
    });
    t.anchor.set(0.5);
    t.x = layout.width / 2;
    t.y = layout.gridOriginY + layout.gridSize / 2;
    this.container.addChild(t);
    this.countdownText = t;
    const startTime = performance.now();
    const animate = () => {
      if (this.countdownText !== t) return;
      const k = (performance.now() - startTime) / 800;
      if (k >= 1) {
        if (t.parent) { this.container.removeChild(t); t.destroy(); this.countdownText = null; }
        return;
      }
      t.scale.set(1 + 0.3 * (1 - k));
      t.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  private updateCountdownTicks(): void {
    const time = this.gameState.timeRemaining;
    if (time > 6) return;
    const sec = Math.ceil(time);
    if (sec === this.lastTickSecond || sec <= 0) return;
    this.lastTickSecond = sec;
    this.audioManager.playUrgentTick(sec);
  }

  private updateCriticalAlerts(): void {
    const time = this.gameState.timeRemaining;
    if (time <= 10 && time > 9.5 && !this.alertsFired.ten) {
      this.alertsFired.ten = true;
      this.showCenterAlert('10 SECONDS', THEME.warning, 24);
    }
    if (time <= 5 && time > 4.5 && !this.alertsFired.five) {
      this.alertsFired.five = true;
      this.showCenterAlert('5 SECONDS!');
      this.audioManager.playAlertChime();
    }
    if (time <= 2 && time > 1.5 && !this.alertsFired.two) {
      this.alertsFired.two = true;
      this.showCenterAlert('2 SECONDS!');
      this.audioManager.playAlertChime();
      this.fxManager.triggerShake(3, 0.2);
    }
    if (time > 12) this.alertsFired = { ten: false, five: false, two: false };
  }

  private showCenterAlert(text: string, color: number = THEME.danger, fontSize: number = 28): void {
    this.animationManager.showCenterAlert(text, color, fontSize);
  }

  // ── Game over ──

  private startGameOverSequence(): void {
    this.gameOverSequenceActive = true;
    this.gameOverElapsed = 0;
    this.phase = 'gameOver';
    this.dragController.detach(this.canvas);
    this.audioManager.stopMusic();
    this.audioManager.playGameOver();
    this.ghostRenderer.hide();
    this.handRenderer.hideDragPiece();

    // Running out of ration is an ending, not a death: it gets the gold
    // treatment and none of the alarm the other two causes earn.
    const cause = this.gameState.deathCause;
    const complete = cause === 'complete';
    const endLabel = complete ? 'RATION SPENT' : cause === 'board_lock' ? 'NO ROOM LEFT' : "TIME'S UP";
    this.showCenterAlert(endLabel, complete ? THEME.gold : THEME.danger, 30);
    this.fxManager.triggerFlash(complete ? 0.35 : 0.6, 3, complete ? THEME.gold : undefined);
    this.fxManager.triggerShake(complete ? 4 : 12, complete ? 0.2 : 0.4);
    this.fxManager.triggerImpactFrame(0.2, 0.5);
    const layout = this.layoutManager.layout;
    this.animationManager.spawnExplosion(layout.gridOriginX + layout.gridSize / 2, layout.gridOriginY + layout.gridSize / 2, 50);
    this.haptic([50, 30, 80, 30, 120]);
  }

  private updateGameOverSequence(dt: number): void {
    this.gameOverElapsed += dt;
    if (this.gameOverElapsed >= 1.1) {
      this.gameOverSequenceActive = false;
      this.onGameOver(this.endRun());
    }
  }

  /**
   * The one place a run finishes, whether by death or by quitting. Telemetry
   * hangs off here so it can neither be missed nor sent twice.
   */
  private endRun(endCauseOverride?: RunEndCause): RunSummary {
    const summary = this.gameState.buildRunSummary(endCauseOverride);
    if (!this.runReported) {
      this.runReported = true;
      reportRun(summary);
    }
    return summary;
  }

  private haptic(pattern: number | number[]): void {
    if (!this.hapticsEnabled) return;
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch { /* */ } }
  }

  // ── Pause ──

  private buildPauseButton(): void {
    if (this.pauseBtn) {
      this.container.removeChild(this.pauseBtn);
      this.pauseBtn.destroy({ children: true });
    }
    const layout = this.layoutManager.layout;
    const btn = new Container();
    const size = 34;
    const x = layout.gridOriginX + layout.gridSize - size;
    const y = 8;
    const bg = new Graphics();
    bg.roundRect(x, y, size, size, 9);
    bg.fill({ color: 0x000000, alpha: 0.3 });
    bg.roundRect(x, y, size, size, 9);
    bg.stroke({ color: 0xffffff, alpha: 0.1, width: 1 });
    btn.addChild(bg);
    const icon = new Graphics();
    const cx = x + size / 2, cy = y + size / 2;
    icon.roundRect(cx - 6.5, cy - 7, 4, 14, 1.5);
    icon.fill({ color: THEME.textPrimary });
    icon.roundRect(cx + 2.5, cy - 7, 4, 14, 1.5);
    icon.fill({ color: THEME.textPrimary });
    btn.addChild(icon);
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointerdown', (e) => { e.stopPropagation(); if (this.phase === 'playing') this.pause(); });
    this.pauseBtn = btn;
    this.container.addChild(btn);
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dragController.detach(this.canvas);
    this.handRenderer.hideDragPiece();
    this.ghostRenderer.hide();
    this.refreshHand(false);
    this.audioManager.stopMusic();
    this.buildPauseOverlay();
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.removePauseOverlay();
    this.audioManager.unlock();
    if (this.phase === 'playing') {
      this.dragController.attach(this.canvas);
      this.audioManager.startMusic();
    }
  }

  private quit(): void {
    this.removePauseOverlay();
    this.paused = false;
    this.audioManager.stopMusic();
    const summary = this.endRun('quit');
    if (this.gameState.score > 0) this.onGameOver(summary);
    else this.onQuit();
  }

  private buildPauseOverlay(): void {
    const layout = this.layoutManager.layout;
    const overlay = new Container();
    const bg = new Graphics();
    bg.rect(0, 0, layout.width, layout.height);
    bg.fill({ color: THEME.overlay, alpha: 0.86 });
    bg.eventMode = 'static';
    bg.on('pointerdown', (e) => e.stopPropagation());
    overlay.addChild(bg);

    const title = new Text({
      text: 'PAUSED',
      style: new TextStyle({ fontFamily: FONT_DISPLAY, fontSize: 36, fontWeight: '800', fill: THEME.textPrimary, letterSpacing: 8 }),
    });
    title.anchor.set(0.5);
    title.x = layout.width / 2;
    title.y = layout.height * 0.3;
    overlay.addChild(title);
    overlay.addChild(createBodyText(
      `${DIFFICULTY_LABELS[this.gameState.difficulty]} · ${this.gameState.score.toLocaleString()} PTS`,
      layout.width / 2, layout.height * 0.3 + 28, { fontSize: 12, color: THEME.textMuted },
    ));

    const cx = layout.width / 2;
    overlay.addChild(createButton('RESUME', cx, layout.height * 0.45, () => { this.audioManager.playUiClick(); this.resume(); }, { width: 200, height: 52 }));
    const toggleY = layout.height * 0.56;
    overlay.addChild(createToggle('SOUND', cx - 66, toggleY, this.audioManager.isSfxEnabled, (v) => { this.audioManager.setSfxEnabled(v); this.audioManager.playUiClick(); return v; }, 120));
    overlay.addChild(createToggle('MUSIC', cx + 66, toggleY, this.audioManager.isMusicEnabled, (v) => { this.audioManager.setMusicEnabled(v); this.audioManager.playUiClick(); return v; }, 120));
    overlay.addChild(createToggle('HAPTICS', cx, toggleY + 42, this.hapticsEnabled, (v) => { this.hapticsEnabled = v; updateSettings({ haptics: v }); this.audioManager.playUiClick(); if (v) this.haptic(20); return v; }, 140));

    // Motion is the one comfort setting worth reaching mid-run; colours and
    // handedness stay in the menu, where there is room to explain them.
    const motionY = toggleY + 84;
    overlay.addChild(createCycleToggle(
      'MOTION', cx, motionY, MOTION_LABELS, Math.max(0, MOTION_ORDER.indexOf(loadSettings().motion)),
      (i) => {
        updateSettings({ motion: MOTION_ORDER[i] });
        this.applyMotionSetting();
        this.audioManager.playUiClick();
      }, 180,
    ));

    // Keep QUIT clear of the new row on short screens
    const quitY = Math.max(layout.height * 0.72, motionY + 52);
    overlay.addChild(createButton('QUIT', cx, quitY, () => { this.audioManager.playUiClick(); this.quit(); }, { width: 200, height: 46, color: THEME.btnSecondary, glow: false, fontSize: 16 }));
    overlay.addChild(createBodyText('Desktop: R rotate · H hold · ESC pause', cx, quitY + 40, { fontSize: 10, color: THEME.textMuted }));

    this.pauseOverlay = overlay;
    this.container.addChild(overlay);
  }

  private removePauseOverlay(): void {
    if (this.pauseOverlay) {
      this.container.removeChild(this.pauseOverlay);
      this.pauseOverlay.destroy({ children: true });
      this.pauseOverlay = null;
    }
  }

  // ── Input ──

  private setupInput(): void {
    this.dragController.onDragStart = (state: DragState) => {
      this.handRenderer.setCurrentHidden(true);
      this.handRenderer.beginDrag(state.piece, state.pointerX, state.pointerY);
      this.showGhost(state);
      this.haptic(6);
    };
    this.dragController.onDragMove = (state: DragState) => {
      this.handRenderer.showDragPiece(state.piece, state.pointerX, state.pointerY);
      this.handRenderer.recordDragPosition(state.pointerX, state.pointerY);
      this.showGhost(state);
    };
    this.dragController.onDragEnd = (state: DragState) => {
      this.handRenderer.hideDragPiece();
      this.handRenderer.setCurrentHidden(false);
      this.ghostRenderer.hide();
      if (state.gridPos && state.isValid) {
        const events = this.gameState.tryPlace(state.gridPos.row, state.gridPos.col);
        this.processFeedback(events, state.gridPos);
      } else if (!state.cancelled && state.gridPos) {
        this.handleInvalidPlacement(state.gridPos, state);
      }
      this.syncInput();
    };
    this.dragController.onDragCancel = () => {
      this.handRenderer.hideDragPiece();
      this.handRenderer.setCurrentHidden(false);
      this.ghostRenderer.hide();
    };
    this.dragController.onRotate = () => this.rotate();
    this.dragController.onHold = () => this.holdPiece();
  }

  private rotate(): void {
    if (this.phase !== 'playing' || this.paused) return;
    this.gameState.rotate();
    this.audioManager.playUiClick();
    this.handRenderer.animateRotate();
    this.refreshHand(false);
    this.dragController.setCurrent(this.gameState.current);
    this.haptic(6);
  }

  private holdPiece(): void {
    if (this.phase !== 'playing' || this.paused) return;
    if (this.gameState.holdUsed) {
      this.audioManager.playInvalid();
      this.handRenderer.nudge();
      return;
    }
    const events = this.gameState.hold();
    this.processFeedback(events, null);
    this.syncInput();
  }

  private syncInput(): void {
    this.dragController.setCurrent(this.gameState.current);
    this.dragController.updateBoard(this.gameState.board);
  }

  private refreshHand(animate: boolean): void {
    this.handRenderer.drawHand(
      this.gameState.current, this.gameState.held, this.gameState.queue, animate,
      this.gameState.config.previewCount,
    );
    this.handRenderer.setCurrentUnplaceable(!this.gameState.canPlaceCurrentAnywhere());
    // The ration only moves when the hand does, so this is the one place it
    // needs recomputing — no per-frame text writes for a number that is still.
    const budget = this.gameState.config.pieceBudget;
    if (!this.gameState.config.clock.enabled && budget !== undefined) {
      this.uiRenderer.updatePieces(this.gameState.piecesRemaining, budget);
    }
  }

  private refreshBoard(): void {
    this.boardVersion++;
    this.gridRenderer.drawBlocks(this.gameState.board.grid);
    this.gridRenderer.setClosingCells(this.gameState.board.findClosingCells());
  }

  /** The ghost, plus the gold claim preview when the drop would seal a room */
  private showGhost(state: DragState): void {
    if (!state.gridPos) {
      this.ghostRenderer.hide();
      return;
    }
    this.ghostRenderer.show(state.piece.shape, state.gridPos.row, state.gridPos.col, state.piece.color, state.isValid);
    const preview = state.isValid
      ? this.closePreview(state.piece, state.gridPos.row, state.gridPos.col)
      : null;
    if (preview) this.ghostRenderer.showClosePreview(preview.regions, preview.points);
    else this.ghostRenderer.hidePreview();
  }

  /**
   * What this drop would claim, memoised on piece + cell + board so the
   * flood fill runs once per snapped position, not once per pointer event.
   */
  private closePreview(piece: PieceInstance, row: number, col: number): ClosePreview | null {
    const key = `${piece.typeId}:${piece.rotation}:${row}:${col}:${this.boardVersion}`;
    if (key === this.previewKey) return this.previewValue;
    this.previewKey = key;
    this.previewValue = null;

    const probe = this.gameState.board.clone();
    if (probe.canPlace(piece.shape, row, col)) {
      probe.place(piece.shape, row, col, piece.color);
      const regions = probe.findEnclosures();
      if (regions.length > 0) {
        this.previewValue = { regions, points: this.gameState.claimPoints(regions).turnScore };
      }
    }
    return this.previewValue;
  }

  private handleInvalidPlacement(gridPos: GridPos, state: DragState): void {
    this.audioManager.playInvalid();
    this.handRenderer.nudge();
    this.ghostRenderer.flashRejected(state.piece.shape, gridPos.row, gridPos.col, state.piece.color);
    this.fxManager.triggerShake(1.5, 0.08);
    this.haptic(12);
  }

  private showTimeBonusPopup(timeBonus: number, big: boolean): void {
    if (timeBonus <= 0) return;
    if (!big && timeBonus < 1.6) return;
    // Time gained always appears by the clock, bigger for claims, so it never
    // collides with the score and room popups in the middle of the board
    const label = `+${timeBonus.toFixed(1)}s`;
    const layout = this.layoutManager.layout;
    this.animationManager.showTimeBonusPopup(label, layout.gridOriginX + (big ? 96 : 80), layout.gridOriginY - 12, big ? 24 : 16);
  }

  // ── Feedback ──

  private processFeedback(events: FeedbackEvent[], origin: GridPos | null): void {
    const layout = this.layoutManager.layout;
    const gridCenterX = layout.gridOriginX + layout.gridSize / 2;
    const gridCenterY = layout.gridOriginY + layout.gridSize / 2;

    for (const event of events) {
      switch (event.type) {
        case 'place': {
          this.audioManager.playPlace(this.gameState.streakCount, event.speedFraction ?? 1);
          this.refreshBoard();
          this.haptic(10);
          if (event.placedCells && event.pieceColor !== undefined) {
            this.gridRenderer.popCells(event.placedCells, event.pieceColor);
          }
          if (event.speedFraction !== undefined && event.speedFraction >= 0.8 && event.placedCells?.length) {
            this.audioManager.playWhoosh();
            let cx = 0, cy = 0;
            for (const c of event.placedCells) {
              cx += layout.gridOriginX + c.col * layout.cellSize + layout.cellSize / 2;
              cy += layout.gridOriginY + c.row * layout.cellSize + layout.cellSize / 2;
            }
            this.animationManager.spawnSpeedLines(cx / event.placedCells.length, cy / event.placedCells.length, 8);
          }
          if (event.timeBonus) this.showTimeBonusPopup(event.timeBonus, false);
          this.updateProgressPresentation(true);
          if (event.streakBroken) {
            this.audioManager.playStreakBreak();
            this.showCenterAlert('STREAK LOST', THEME.textMuted, 18);
          }
          this.uiRenderer.updateStreak(this.gameState.streakCount, this.gameState.streakSafeMoves, this.gameState.config.scoring.streakWindow);
          this.fxManager.updateFlowState(this.gameState.streakCount);
          break;
        }

        case 'claim': {
          const claim = event.claim!;
          const rooms = claim.regions.length;
          const biggest = Math.max(...claim.regions.map(r => r.area));
          // Sound scales with the size of the claim; double closes add a higher run
          this.audioManager.playClaim(claim.totalArea, rooms, this.gameState.streakCount);
          if (this.gameState.streakCount >= 3) this.audioManager.playComboReverb(this.gameState.streakCount);
          this.haptic(biggest >= 9 ? [40, 30, 60] : 30);

          this.fxManager.triggerShake(Math.min(8, 2 + biggest * 0.4), 0.12);
          this.fxManager.triggerImpactFrame(0.1, 0.05);
          if (biggest >= 9 || rooms >= 2) this.fxManager.triggerZoomPulse(this.gameContent, gridCenterX, gridCenterY);
          if (biggest >= 6) this.fxManager.triggerFlash(Math.min(0.35, 0.1 + biggest * 0.015), 6);

          const o = origin ?? { row: 4, col: 4 };
          this.gridRenderer.animateClaim(claim.regions, claim.fenceCleared, claim.fenceColors, o);
          this.animationManager.spawnClearEffect(claim.fenceCleared, biggest >= 9 ? 0xF1C40F : 0x4A90D9);

          // Per room: sparkles, a shockwave ring, and a score popup at its centre
          for (const region of claim.regions) {
            let cx = 0, cy = 0;
            for (const c of region.cells) {
              cx += layout.gridOriginX + c.col * layout.cellSize + layout.cellSize / 2;
              cy += layout.gridOriginY + c.row * layout.cellSize + layout.cellSize / 2;
            }
            cx /= region.cells.length;
            cy /= region.cells.length;
            this.animationManager.spawnClaimSparkles(region.cells, region.area >= 9 ? 8 : 5);
            const ringRadius = layout.cellSize * (1.5 + Math.sqrt(region.area) * 1.1);
            this.animationManager.spawnShockwave(cx, cy, ringRadius, THEME.gold, 5, 0.45 + region.area * 0.02);
            if (region.area >= 9) this.animationManager.spawnShockwave(cx, cy, ringRadius * 1.6, 0xffffff, 3, 0.7);
            // What this room actually paid at base: relit floor pays less than area² × 10
            const pts = event.scoreBreakdown?.roomPoints[claim.regions.indexOf(region)]
              ?? region.area * region.area * this.gameState.config.scoring.pointsPerAreaSquared;
            this.animationManager.showScorePopup(pts, cx, cy, region.area >= 9);
          }
          // One label for everything that moved the price away from area² × 10:
          // the multipliers if there were any, the room's size if there were
          // not, and always the relit floor, which is the only part of the
          // price the board itself explains.
          const parts: string[] = [];
          const breakdown = event.scoreBreakdown;
          if (breakdown) {
            if (rooms >= 2) parts.push(`${rooms} ROOMS ×${breakdown.multiCloseMultiplier.toFixed(1)}`);
            if (breakdown.streakMultiplier > 1) parts.push(`STREAK ×${breakdown.streakMultiplier.toFixed(2)}`);
          }
          if (parts.length === 0 && biggest >= 9) {
            parts.push(biggest >= 16 ? 'MASSIVE ROOM' : 'BIG ROOM');
          }
          if (breakdown && breakdown.territoryFactor < 1) {
            parts.push(`RELIT ×${formatFactor(breakdown.territoryFactor)}`);
          }
          if (parts.length > 0) this.animationManager.showStreakPopup(0, parts.join('  ·  '));
          if (event.timeBonus) this.showTimeBonusPopup(event.timeBonus, true);

          this.refreshBoard();
          if (this.gameState.config.territory.enabled) {
            // The claim just lit its floor (and a survey may have wiped it)
            this.gridRenderer.drawFloor(this.gameState.board.lit);
            this.uiRenderer.updateSurvey(event.litCount ?? 0, INNER_CELLS, this.gameState.surveys);
          }
          this.updateProgressPresentation(true);
          this.uiRenderer.updateStreak(this.gameState.streakCount, this.gameState.streakSafeMoves, this.gameState.config.scoring.streakWindow);
          this.fxManager.boostFlow(Math.min(0.9, 0.2 + biggest * 0.06 + (rooms - 1) * 0.2));
          this.fxManager.updateFlowState(this.gameState.streakCount);
          break;
        }

        case 'survey': {
          // The lit map is already wiped, so the floor dissolves off the board
          // while the flash and the label say what it was worth.
          this.gridRenderer.surveyFadeOut();
          this.fxManager.triggerFlash(0.45, 3, THEME.gold);
          this.animationManager.showStreakPopup(
            0,
            `SURVEY COMPLETE  +${(event.surveyBonus ?? 0).toLocaleString()}`,
          );
          break;
        }

        case 'newBest': {
          this.audioManager.playNewBest();
          this.uiRenderer.markNewBest(this.gameState.score);
          this.showCenterAlert('NEW BEST!', THEME.gold, 30);
          this.fxManager.triggerFlash(0.25, 6);
          this.fxManager.boostFlow(0.5);
          this.animationManager.spawnExplosion(gridCenterX, gridCenterY - 40, 20);
          this.haptic([30, 40, 60]);
          break;
        }

        case 'hold':
          this.audioManager.playUiClick();
          this.haptic(8);
          break;

        case 'newHand':
          this.refreshHand(true);
          break;

        case 'gameOver':
          this.startGameOverSequence();
          break;
      }
    }
    if (this.gameState.newBestReached) this.uiRenderer.markNewBest(this.gameState.score);
  }

  private updateProgressPresentation(announceTier: boolean): void {
    this.uiRenderer.updateScore(this.gameState.score);
    this.uiRenderer.updateProgress(this.gameState.difficulty, this.gameState.score);
    const status = getProgressStatus(this.gameState.difficulty, this.gameState.score);
    if (announceTier && status.tierIndex > this.progressTierIndex) {
      const layout = this.layoutManager.layout;
      this.showCenterAlert(`${status.current.label}`, status.current.color, 30);
      this.audioManager.playTierUp();
      this.fxManager.triggerFlash(0.22, 8);
      this.fxManager.triggerShake(3, 0.1);
      this.fxManager.boostFlow(0.55);
      this.animationManager.spawnExplosion(layout.gridOriginX + layout.gridSize / 2, layout.gridOriginY + layout.gridSize / 2 - 20, 18);
    }
    this.progressTierIndex = status.tierIndex;
  }
}
