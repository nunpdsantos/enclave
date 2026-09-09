import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Layout } from './LayoutManager';
import { FONT_DISPLAY, FONT_MONO, SIEGE, THEME, drawPanel } from './Theme';
import { Difficulty } from '../core/Config';
import { getProgressStatus } from '../core/Progression';

/** Lit floor at which the survey readout turns gold: the home straight */
const SURVEY_GOLD_AT = 40;
/** Pieces left at which the budget readout turns gold: the last few moves */
const PIECES_LOW_AT = 5;
/** How long "SURVEY ✓ ×N" holds before the readout drops back to the count */
const SURVEY_FLASH_SECONDS = 2.2;

/** Steps from the Keep at which the siege HUD starts shouting */
export const BREACH_WARNING_STEPS = 2;

/**
 * Heads-up display for the game scene.
 *
 * Layout (top → bottom):
 *   ┌ TIER chip + progress ─── SCORE ─── BEST ┐
 *   │ SURVEY 23/49      STREAK ×N  ●●○        │
 *   │ 42s      PB PACE 1,240            ⚡1.0 │  ← pace sits between the two
 *   │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │  ← time bank (thick) + speed bonus (thin)
 *   └───────────────── board ─────────────────┘
 */
export class UIRenderer {
  container: Container;
  private scoreText: Text;
  private scoreLabelText: Text;
  private streakText: Text;
  private streakPips: Graphics;
  private bestLabelText: Text;
  private bestText: Text;
  private timerText: Text;
  private timerBarGfx: Graphics;
  private speedBarGfx: Graphics;
  private speedText: Text;
  private tierPanel: Graphics;
  private rankText: Text;
  private goalText: Text;
  private surveyText: Text;
  private paceText: Text;
  /** Siege: pieces left or turn number, above the clock bar */
  private siegeCountText: Text;
  /** Siege: enemies still on the board */
  private siegeEnemyText: Text;
  /** Siege: an enemy is within two steps of the Keep */
  private siegeBreachText: Text;
  private breachPhase = 0;
  private progressBarGfx: Graphics;
  private layout!: Layout;

  // Score punch animation
  private scorePunch = 0;
  private lastScore = 0;

  // Low-time pulse animation
  private pulsePhase = 0;

  // Survey readout: latest counts, plus the timer on the "✓ ×N" celebration
  private surveyLit = 0;
  private surveyTotal = 0;
  private surveyCount = 0;
  private surveyFlash = 0;

  constructor() {
    this.container = new Container();

    this.scoreLabelText = new Text({
      text: 'SCORE',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 11,
        fontWeight: '600',
        fill: THEME.textSecondary,
        letterSpacing: 3,
      }),
    });

    this.scoreText = new Text({
      text: '0',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 36,
        fontWeight: '400',
        fill: THEME.textPrimary,
        letterSpacing: 1,
        dropShadow: { alpha: 0.35, blur: 8, color: 0x000000, distance: 2 },
      }),
    });

    this.streakText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 15,
        fontWeight: '700',
        fill: THEME.gold,
        letterSpacing: 2,
        dropShadow: { alpha: 0.4, blur: 6, color: THEME.gold, distance: 0 },
      }),
    });
    this.streakPips = new Graphics();

    this.bestLabelText = new Text({
      text: 'BEST',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 10,
        fontWeight: '600',
        fill: THEME.textMuted,
        letterSpacing: 3,
      }),
    });

    this.bestText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 15,
        fontWeight: '400',
        fill: THEME.textSecondary,
        letterSpacing: 1,
      }),
    });

    this.timerText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 15,
        fontWeight: '400',
        fill: THEME.textPrimary,
        letterSpacing: 1,
      }),
    });

    this.speedText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 12,
        fontWeight: '400',
        fill: THEME.textMuted,
        letterSpacing: 1,
      }),
    });

    this.tierPanel = new Graphics();

    this.rankText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 11,
        fontWeight: '700',
        fill: THEME.accent,
        letterSpacing: 3,
      }),
    });

    this.goalText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 10,
        fontWeight: '500',
        fill: THEME.textMuted,
        letterSpacing: 1.5,
      }),
    });

    // Hidden until the first updateSurvey, so a run with territory off never
    // shows a readout for a mechanic it does not have
    this.surveyText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 10,
        fontWeight: '400',
        fill: THEME.textMuted,
        letterSpacing: 1,
      }),
    });
    this.surveyText.visible = false;

    // Hidden until a stored personal-best curve says what to race
    this.paceText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 10,
        fontWeight: '400',
        fill: THEME.textMuted,
        letterSpacing: 1,
      }),
    });
    this.paceText.visible = false;

    // The siege HUD. All three start hidden, so a Classic run never shows a
    // readout for a mode it is not in.
    this.siegeCountText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO, fontSize: 13, fill: THEME.textPrimary, letterSpacing: 1,
      }),
    });
    this.siegeCountText.visible = false;

    this.siegeEnemyText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: FONT_MONO, fontSize: 10, fill: THEME.textMuted, letterSpacing: 1,
      }),
    });
    this.siegeEnemyText.visible = false;

    this.siegeBreachText = new Text({
      text: 'BREACH',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY, fontSize: 12, fontWeight: '800',
        fill: SIEGE.threat, letterSpacing: 3,
        dropShadow: { alpha: 0.6, blur: 8, color: SIEGE.threat, distance: 0 },
      }),
    });
    this.siegeBreachText.visible = false;

    this.timerBarGfx = new Graphics();
    this.speedBarGfx = new Graphics();
    this.progressBarGfx = new Graphics();

    this.container.addChild(this.tierPanel);
    this.container.addChild(this.goalText);
    this.container.addChild(this.rankText);
    this.container.addChild(this.surveyText);
    this.container.addChild(this.progressBarGfx);
    this.container.addChild(this.bestLabelText);
    this.container.addChild(this.bestText);
    this.container.addChild(this.scoreLabelText);
    this.container.addChild(this.scoreText);
    this.container.addChild(this.streakText);
    this.container.addChild(this.streakPips);
    this.container.addChild(this.speedBarGfx);
    this.container.addChild(this.timerBarGfx);
    this.container.addChild(this.timerText);
    this.container.addChild(this.speedText);
    this.container.addChild(this.paceText);
    this.container.addChild(this.siegeCountText);
    this.container.addChild(this.siegeEnemyText);
    this.container.addChild(this.siegeBreachText);
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    const left = layout.gridOriginX;
    const right = layout.gridOriginX + layout.gridSize;

    this.scoreLabelText.anchor.set(0.5, 0);
    this.scoreLabelText.x = layout.width / 2;
    this.scoreLabelText.y = 8;

    this.scoreText.anchor.set(0.5, 0);
    this.scoreText.x = layout.width / 2;
    this.scoreText.y = layout.scoreY;

    this.streakText.anchor.set(0.5, 0);
    this.streakText.x = layout.width / 2;
    this.streakText.y = layout.streakY;

    // BEST sits left of the pause button (34px + gap) in the top-right
    this.bestLabelText.anchor.set(1, 0);
    this.bestLabelText.x = right - 44;
    this.bestLabelText.y = 10;

    this.bestText.anchor.set(1, 0);
    this.bestText.x = right - 44;
    this.bestText.y = 24;

    // Tier chip (top-left)
    this.rankText.anchor.set(0, 0);
    this.rankText.x = left + 10;
    this.rankText.y = 12;

    this.goalText.anchor.set(0, 0);
    this.goalText.x = left + 10;
    this.goalText.y = 28;

    // Under the tier chip (which ends at y = 50) and left of the centred
    // score, which is the only thing at this height on a 360-wide layout
    this.surveyText.anchor.set(0, 0);
    this.surveyText.x = left + 10;
    this.surveyText.y = 52;

    // Timer text: left-aligned above the bar
    this.timerText.anchor.set(0, 1);
    this.timerText.x = left;
    this.timerText.y = layout.gridOriginY - 27;

    // Speed text: right-aligned above the bar
    this.speedText.anchor.set(1, 1);
    this.speedText.x = right;
    this.speedText.y = layout.gridOriginY - 27;

    // Pace: centred under the score, in the only band the HUD leaves free.
    // The row above holds SURVEY hard left and BEST hard right; this row is
    // the timer's, and at 360 px "42s" ends around x = 52 while "⚡1.0x"
    // starts around x = 297, so a centred 10 px line clears both.
    this.paceText.anchor.set(0.5, 1);
    this.paceText.x = layout.width / 2;
    this.paceText.y = layout.gridOriginY - 28;

    // The siege takes the same three slots the other modes use: the count
    // where the speed readout sits, the enemy tally under the tier chip, and
    // the warning in the free band down the middle.
    this.siegeCountText.anchor.set(1, 1);
    this.siegeCountText.x = right;
    this.siegeCountText.y = layout.gridOriginY - 27;

    this.siegeEnemyText.anchor.set(0, 0);
    this.siegeEnemyText.x = left + 10;
    this.siegeEnemyText.y = 52;

    this.siegeBreachText.anchor.set(0.5, 1);
    this.siegeBreachText.x = layout.width / 2;
    this.siegeBreachText.y = layout.gridOriginY - 28;
  }

  /** Per-frame: score punch decay, and the survey celebration timing out */
  update(dt: number): void {
    if (this.scorePunch > 0) {
      this.scorePunch = Math.max(0, this.scorePunch - dt * 5);
      this.scoreText.scale.set(1 + this.scorePunch * 0.18);
    } else {
      this.scoreText.scale.set(1);
    }

    if (this.surveyFlash > 0) {
      this.surveyFlash = Math.max(0, this.surveyFlash - dt);
      if (this.surveyFlash === 0) this.renderSurvey();
    }

    // A breach warning that sat still would be one more static label. It has
    // to be the thing on screen that is moving.
    if (this.siegeBreachText.visible) {
      this.breachPhase += dt * 7;
      this.siegeBreachText.alpha = 0.55 + Math.sin(this.breachPhase) * 0.45;
    }
  }

  /**
   * The siege readouts: how much of the mission is left, how many enemies are
   * on the board, and whether one of them is about to be inside the Keep.
   *
   * `pieces` is null in an endless siege, where `turn` is the number that
   * means something instead.
   */
  updateSiege(opts: {
    pieces: number | null;
    budget: number;
    turn: number;
    enemies: number;
    stepsToKeep: number;
    /** Which gate the next wave uses and how many placements away it is */
    nextSpawn: { gate: number; inTurns: number } | null;
    /** Seconds until the tide's next expansion, or null for the raiders */
    nextTideIn: number | null;
    /** The pieces are spent and the mission is now only being outlasted */
    holdingOut: boolean;
  }): void {
    // Once the pieces are gone the count means nothing and the only question
    // left is whether the Keep outlasts the flood
    this.siegeCountText.text = opts.holdingOut
      ? 'HOLD OUT'
      : opts.pieces !== null
        ? `PIECES ${opts.pieces}/${opts.budget}`
        : `TURN ${opts.turn}`;
    this.siegeCountText.style.fill = opts.holdingOut
      ? THEME.gold
      : opts.pieces !== null && opts.pieces <= PIECES_LOW_AT
        ? THEME.gold
        : THEME.textPrimary;
    this.siegeCountText.visible = true;

    // Enemies on the board, and what is coming. A player who cannot see the
    // next wave has no way to spend a placement on preparing for it, which is
    // most of what the mode is supposed to be about.
    const forecast = opts.nextSpawn
      ? `  ·  GATE ${opts.nextSpawn.gate + 1} IN ${opts.nextSpawn.inTurns}`
      : opts.nextTideIn !== null
        ? `  ·  TIDE ${opts.nextTideIn.toFixed(1)}s`
        : '';
    this.siegeEnemyText.text = `ENEMIES ${opts.enemies}${forecast}`;
    this.siegeEnemyText.style.fill = opts.enemies > 0 ? SIEGE.threat : THEME.textMuted;
    this.siegeEnemyText.visible = true;

    const warn = opts.enemies > 0 && opts.stepsToKeep <= BREACH_WARNING_STEPS;
    if (warn) {
      this.siegeBreachText.text = opts.stepsToKeep <= 1 ? 'BREACH IMMINENT' : 'BREACH WARNING';
    } else {
      this.breachPhase = 0;
      this.siegeBreachText.alpha = 1;
    }
    this.siegeBreachText.visible = warn;

    // The siege has no speed bonus and no streak, so nothing of either shows
    this.speedBarGfx.clear();
    this.speedText.visible = false;
  }

  /**
   * Territory progress: how much of the inner board is lit, and how many
   * surveys are banked. Call it on every claim; a rise in `surveys` is what
   * triggers the celebration, so the caller never has to say a survey landed.
   */
  updateSurvey(litCount: number, total: number, surveys: number): void {
    const completed = surveys > this.surveyCount;
    this.surveyLit = litCount;
    this.surveyTotal = total;
    this.surveyCount = surveys;
    if (completed) this.surveyFlash = SURVEY_FLASH_SECONDS;
    this.renderSurvey();
  }

  private renderSurvey(): void {
    if (this.surveyFlash > 0) {
      this.surveyText.text = `SURVEY ✓ ×${this.surveyCount}`;
      this.surveyText.style.fill = THEME.goldGlow;
    } else {
      this.surveyText.text = `SURVEY ${this.surveyLit}/${this.surveyTotal}`;
      this.surveyText.style.fill = this.surveyLit >= SURVEY_GOLD_AT ? THEME.gold : THEME.textMuted;
    }
    this.surveyText.visible = true;
  }

  /**
   * The ghost of the personal best: what that run had banked at this second.
   *
   * Green once the current run is in front, muted while it is behind, gone
   * when there is nothing stored to race — a first run should not be shown an
   * empty scoreboard. Called on the second, not per frame.
   */
  updatePace(score: number, paceScore: number | null): void {
    if (paceScore === null) {
      this.paceText.visible = false;
      return;
    }
    this.paceText.text = `PB PACE ${paceScore.toLocaleString()}`;
    this.paceText.style.fill = score > paceScore ? THEME.success : THEME.textMuted;
    this.paceText.visible = true;
  }

  updateScore(score: number): void {
    if (score !== this.lastScore) {
      const delta = score - this.lastScore;
      this.scorePunch = Math.min(1, 0.35 + Math.min(delta / 400, 0.65));
      this.lastScore = score;
    }
    this.scoreText.text = score.toLocaleString();
    this.updateScoreColor(score);
  }

  /**
   * Streak readout with "safety pips": filled dots show how many more
   * placements without a clear the streak can survive.
   */
  updateStreak(streak: number, safeMoves: number = 0, window: number = 0): void {
    const g = this.streakPips;
    g.clear();
    if (streak > 0) {
      this.streakText.text = `STREAK ×${streak}`;
      this.streakText.visible = true;

      if (window > 0 && this.layout) {
        const r = 3;
        const gap = 9;
        const totalW = (window - 1) * gap;
        const startX = this.streakText.x + this.streakText.width / 2 + 12;
        const y = this.streakText.y + this.streakText.height / 2;
        for (let i = 0; i < window; i++) {
          const x = startX + i * gap;
          const filled = i < safeMoves;
          g.circle(x, y, r);
          g.fill({ color: filled ? THEME.gold : 0x000000, alpha: filled ? 0.95 : 0.35 });
          if (!filled) {
            g.circle(x, y, r);
            g.stroke({ color: THEME.gold, alpha: 0.4, width: 1 });
          }
        }
        void totalW;
      }
    } else {
      this.streakText.visible = false;
    }
  }

  updateHighScore(highScore: number): void {
    if (highScore > 0) {
      this.bestText.text = highScore.toLocaleString();
      this.bestText.visible = true;
      this.bestLabelText.visible = true;
    } else {
      this.bestText.visible = false;
      this.bestLabelText.visible = false;
    }
  }

  /** Flash the BEST readout gold once the player passes it */
  markNewBest(score: number): void {
    this.bestText.text = score.toLocaleString();
    this.bestText.style.fill = THEME.gold;
    this.bestLabelText.text = 'NEW BEST';
    this.bestLabelText.style.fill = THEME.gold;
    this.bestText.visible = true;
    this.bestLabelText.visible = true;
  }

  updateProgress(difficulty: Difficulty, score: number): void {
    const status = getProgressStatus(difficulty, score);
    this.rankText.text = status.current.label;
    this.rankText.style.fill = status.current.color;
    this.rankText.visible = true;

    if (status.next) {
      const remaining = Math.max(0, status.next.minScore - score);
      this.goalText.text = `${remaining.toLocaleString()} TO ${status.next.label}`;
    } else {
      this.goalText.text = 'TOP TIER';
    }
    this.goalText.visible = true;

    this.drawTierChip(status.progressToNext, status.current.color);
  }

  updateTimer(timeRemaining: number, maxTime: number, dt: number): void {
    if (!this.layout) return;
    const layout = this.layout;
    const barX = layout.gridOriginX;
    const barY = layout.gridOriginY - 24;
    const barW = layout.gridSize;
    const barH = 11;

    const fill = Math.max(0, Math.min(timeRemaining / maxTime, 1.0));
    const fillW = Math.max(barH, barW * fill);

    // Determine color based on time remaining
    let barColor: number;
    let glowColor: number;
    let isLow = false;
    let isCritical = false;

    if (timeRemaining <= 10) {
      barColor = 0xff4444;
      glowColor = 0xff6666;
      isCritical = true;
      isLow = true;
    } else if (timeRemaining <= 20) {
      barColor = 0xf59e0b;
      glowColor = 0xfbbf24;
      isLow = true;
    } else if (timeRemaining <= 35) {
      barColor = THEME.gold;
      glowColor = THEME.goldGlow;
    } else {
      barColor = 0x20bf6b;
      glowColor = 0x4ade80;
    }

    const g = this.timerBarGfx;
    g.clear();

    // Glow behind bar (always present)
    g.roundRect(barX - 2, barY - 2, fillW + 4, barH + 4, 5);
    g.fill({ color: glowColor, alpha: 0.14 });

    // Track background
    g.roundRect(barX, barY, barW, barH, 4);
    g.fill({ color: 0x0b0e22, alpha: 0.75 });

    // Filled portion
    g.roundRect(barX, barY, fillW, barH, 4);
    g.fill({ color: barColor });

    // Top highlight strip
    g.roundRect(barX + 1, barY + 1, Math.max(0, fillW - 2), barH * 0.4, 3);
    g.fill({ color: 0xffffff, alpha: 0.18 });

    // Tick marks every 25%
    for (let i = 1; i < 4; i++) {
      const tx = barX + (barW * i) / 4;
      g.rect(tx, barY + 2, 1, barH - 4);
      g.fill({ color: 0x000000, alpha: 0.35 });
    }

    // Pulse glow when low
    if (isLow) {
      this.pulsePhase += dt * (isCritical ? 8 : 4);
      const pulseAlpha = 0.25 + Math.sin(this.pulsePhase) * 0.2;
      g.roundRect(barX - 1, barY - 1, fillW + 2, barH + 2, 5);
      g.fill({ color: glowColor, alpha: pulseAlpha });
    } else {
      this.pulsePhase = 0;
    }

    // Timer text
    const secs = Math.ceil(timeRemaining);
    this.timerText.text = `${secs}s`;
    this.timerText.style.fill = barColor;
    this.timerText.visible = true;

    // Pulse timer text when critical
    if (isCritical) {
      const scale = 1 + Math.sin(this.pulsePhase) * 0.1;
      this.timerText.scale.set(scale);
    } else {
      this.timerText.scale.set(1);
    }
  }

  /**
   * The clockless HUD: how many pieces are left of the ration.
   *
   * It takes the timer's slot and blanks both bars, so nothing on screen
   * suggests a clock that is not running. Call it instead of updateTimer and
   * updateSpeedBar, never alongside them.
   */
  updatePieces(remaining: number, total: number): void {
    this.timerBarGfx.clear();
    this.speedBarGfx.clear();
    this.speedText.visible = false;
    this.timerText.text = `PIECES ${remaining}/${total}`;
    this.timerText.style.fill = remaining <= PIECES_LOW_AT ? THEME.gold : THEME.textPrimary;
    this.timerText.scale.set(1);
    this.timerText.visible = true;
  }

  /** Thin "speed bonus" bar under the timer: full right after a placement, draining as you hesitate */
  updateSpeedBar(speedFraction: number, speedWindow: number, elapsed: number): void {
    if (!this.layout) return;
    const layout = this.layout;

    const barX = layout.gridOriginX;
    const barY = layout.gridOriginY - 9;
    const barW = layout.gridSize;
    const barH = 3;

    const fill = Math.max(0, 1 - elapsed / speedWindow);
    const fillW = Math.max(barH, barW * fill);

    let color: number;
    if (speedFraction >= 0.9) color = 0x22d3ee;
    else if (speedFraction >= 0.6) color = 0xf59e0b;
    else color = 0x4a5568;

    const g = this.speedBarGfx;
    g.clear();

    g.roundRect(barX, barY, barW, barH, 1.5);
    g.fill({ color: 0x0b0e22, alpha: 0.5 });

    if (fill > 0) {
      g.roundRect(barX, barY, fillW, barH, 1.5);
      g.fill({ color });
    }

    this.speedText.text = `⚡${speedFraction.toFixed(1)}x`;
    this.speedText.style.fill = color;
    this.speedText.visible = true;
  }

  private updateScoreColor(score: number): void {
    let color = THEME.textPrimary;
    if (score >= 50000) color = 0xef4444;
    else if (score >= 25000) color = 0xf59e0b;
    else if (score >= 10000) color = 0xfbbf24;
    else if (score >= 5000) color = 0x10b981;
    else if (score >= 1000) color = 0x3b82f6;
    this.scoreText.style.fill = color;
  }

  private drawTierChip(progressToNext: number, color: number): void {
    if (!this.layout) return;

    const panel = this.tierPanel;
    panel.clear();
    const x = this.layout.gridOriginX;
    const y = 6;
    const w = Math.max(110, Math.max(this.rankText.width, this.goalText.width) + 20);
    const h = 44;
    drawPanel(panel, x, y, w, h, 10, 0.5);

    const g = this.progressBarGfx;
    g.clear();
    const bx = x + 10;
    const by = y + h - 8;
    const bw = w - 20;
    const bh = 3;
    const fillWidth = Math.max(bh, bw * progressToNext);

    g.roundRect(bx, by, bw, bh, 1.5);
    g.fill({ color: 0x000000, alpha: 0.45 });
    g.roundRect(bx, by, fillWidth, bh, 1.5);
    g.fill({ color, alpha: 0.95 });
  }
}
