import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Scene } from './SceneManager';
import { Leaderboard } from '../core/Leaderboard';
import { Difficulty, DIFFICULTY_CONFIGS, DIFFICULTY_LABELS } from '../core/Config';
import { dailyKey, dailyNumber, hasSubmittedDaily, markDailySubmitted } from '../core/Daily';
import { INNER_CELLS } from '../core/Board';
import { RunSummary } from '../core/types';
import { getProgressStatus } from '../core/Progression';
import { insightsFor } from '../core/Insights';
import { renderShareCard } from '../core/ShareCard';
import { getGamesPlayed } from '../core/Settings';
import { AudioManager } from '../audio/AudioManager';
import { FONT_DISPLAY, FONT_MONO, THEME, DIFFICULTY_COLORS } from '../rendering/Theme';
import { createButton, createStatChip, createSectionLabel, createBodyText, createTextButton } from '../rendering/Widgets';

/**
 * The least room the leaderboard needs under the insights: 36 from its
 * heading to the first row, the three rows buildLeaderboard() draws whatever
 * the arithmetic says, and the 36 it keeps clear above the buttons.
 */
const LEADERBOARD_MIN_HEIGHT = 36 + 3 * 24 + 36;

/** How tall the playbook link is, gap included */
const PLAYBOOK_HEIGHT = 38;

/** The playbook is offered for this many runs in a mode, then it stops */
const PLAYBOOK_RUNS = 3;

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${r.toString().padStart(2, '0')}` : `${r}s`;
}

export class GameOverScene implements Scene {
  container: Container;
  private onReplay: () => void;
  private onMenu: () => void;
  private summary: RunSummary;
  private width: number;
  private height: number;
  private leaderboard: Leaderboard;
  private audio: AudioManager;
  private difficulty: Difficulty;
  /** Which daily this run belongs to — the day it was dealt, not necessarily today */
  private dailyDate: string;
  /**
   * True when this browser had already submitted today's daily before the run
   * started. Read once, here, because submitting is what sets the flag.
   */
  private isPracticeRun: boolean;
  private nameSubmitted = false;
  private rank: number | null = null;
  private leaderboardContainer: Container | null = null;
  private shareLabel: Text | null = null;
  /** The share card, rendered at most once per game-over screen */
  private cardPromise: Promise<Blob> | null = null;

  // Name input group — everything related to name entry
  private nameInputGroup: Container | null = null;
  private htmlInput: HTMLInputElement | null = null;
  private htmlButton: HTMLButtonElement | null = null;

  // Score count-up animation
  private scoreText: Text | null = null;
  private countElapsed = 0;
  private countDone = false;

  // Layout anchors (computed in build)
  private leaderboardTop = 0;
  private buttonsTop = 0;

  constructor(
    width: number, height: number,
    summary: RunSummary,
    leaderboard: Leaderboard,
    audio: AudioManager,
    difficulty: Difficulty,
    onReplay: () => void,
    onMenu: () => void,
  ) {
    this.width = width;
    this.height = height;
    this.summary = summary;
    this.leaderboard = leaderboard;
    this.audio = audio;
    this.difficulty = difficulty;
    this.dailyDate = summary.dailyKey ?? dailyKey();
    this.isPracticeRun = difficulty === 'daily' && hasSubmittedDaily(this.dailyDate);
    this.onReplay = onReplay;
    this.onMenu = onMenu;
    this.container = new Container();
    this.init();
  }

  private async init(): Promise<void> {
    // A run that crossed UTC midnight belongs to the day it was dealt from,
    // not to whichever board the menu happened to have loaded
    if (this.difficulty === 'daily' && this.leaderboard.getBoardId() !== `daily-${this.dailyDate}`) {
      await this.leaderboard.switchDifficulty('daily', this.dailyDate);
    }
    this.build();
    await this.leaderboard.waitForRemote();
    this.refreshLeaderboard();
  }

  /** 'DAILY #9' or the plain mode name */
  private get boardLabel(): string {
    return this.difficulty === 'daily'
      ? `DAILY #${dailyNumber(this.dailyDate)}`
      : DIFFICULTY_LABELS[this.difficulty];
  }

  private build(): void {
    const cx = this.width / 2;
    const h = this.height;
    const summary = this.summary;

    // Dimmed overlay
    const overlay = new Graphics();
    overlay.rect(0, 0, this.width, h);
    overlay.fill({ color: THEME.overlay, alpha: 0.9 });
    this.container.addChild(overlay);

    // Title
    const isBest = summary.isNewBest && summary.score > 0;
    const title = new Text({
      text: isBest ? 'NEW BEST!' : 'GAME OVER',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 32,
        fontWeight: '800',
        fill: isBest ? THEME.gold : THEME.textPrimary,
        letterSpacing: 6,
        dropShadow: { alpha: 0.5, blur: 14, color: isBest ? THEME.gold : THEME.danger, distance: 0 },
      }),
    });
    title.anchor.set(0.5);
    title.x = cx;
    title.y = h * 0.055;
    this.container.addChild(title);

    // Why the run ended
    const causeLabel = summary.endCause === 'timeout'
      ? "TIME RAN OUT"
      : summary.endCause === 'board_lock'
        ? 'NO PIECE FIT THE BOARD'
        : summary.endCause === 'complete'
          ? 'ALL PIECES PLACED'
          : 'RUN ENDED EARLY';
    const cause = createBodyText(`${this.boardLabel} · ${causeLabel}`, cx, h * 0.055 + 22, {
      fontSize: 10,
      color: DIFFICULTY_COLORS[this.difficulty],
    });
    cause.style.letterSpacing = 3;
    this.container.addChild(cause);

    // Score value with glow (counts up in update())
    this.scoreText = new Text({
      text: '0',
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 48,
        fill: THEME.textPrimary,
        letterSpacing: 2,
        dropShadow: { alpha: 0.5, blur: 16, color: isBest ? THEME.gold : THEME.accent, distance: 0 },
      }),
    });
    this.scoreText.anchor.set(0.5);
    this.scoreText.x = cx;
    this.scoreText.y = h * 0.14;
    this.container.addChild(this.scoreText);

    // Best line
    const bestLine = isBest && summary.previousBest > 0
      ? `PREVIOUS BEST ${summary.previousBest.toLocaleString()}`
      : summary.previousBest > 0
        ? `YOUR BEST ${summary.previousBest.toLocaleString()}`
        : 'FIRST RUN — THIS IS YOUR BEST';
    const best = createBodyText(bestLine, cx, h * 0.14 + 30, {
      fontSize: 10,
      color: isBest ? THEME.gold : THEME.textMuted,
    });
    best.style.letterSpacing = 2;
    this.container.addChild(best);

    // Stats row
    const tier = getProgressStatus(this.difficulty, summary.score).current;
    const statsY = h * 0.245;
    const chipW = Math.min(84, (this.width - 48) / 4);
    const gap = 6;
    const totalW = chipW * 4 + gap * 3;
    const startX = cx - totalW / 2 + chipW / 2;
    const stats: [string, string, number][] = [
      ['ROOMS', String(summary.roomsClaimed), THEME.textPrimary],
      ['BIGGEST', summary.biggestRoom > 0 ? `${summary.biggestRoom}` : '—', THEME.gold],
      ['STREAK', `×${summary.maxStreak}`, THEME.cyan],
      ['TIER', tier.label, tier.color],
    ];
    stats.forEach(([caption, value, color], i) => {
      this.container.addChild(createStatChip(caption, value, startX + i * (chipW + gap), statsY, chipW, color));
    });

    // Territory gets a line rather than a fifth chip: five chips leave 62px
    // each at 360 wide, and a tier value like SOVEREIGN already needs 78.
    let nextY = statsY + 34;
    if (DIFFICULTY_CONFIGS[this.difficulty].territory.enabled) {
      this.container.addChild(createBodyText(
        `SURVEYS ×${summary.surveys} · FLOOR ${summary.litCells}/${INNER_CELLS}`,
        cx, statsY + 32, { fontSize: 10, color: summary.surveys > 0 ? THEME.gold : THEME.textMuted },
      ));
      nextY = statsY + 52;
    }

    const wouldRank = !this.isPracticeRun && this.leaderboard.wouldRank(summary.score);
    this.buttonsTop = h - 118;

    // Insights get whatever the rows under them do not need: the name entry
    // or the practice label, the playbook link, and the leaderboard's floor.
    const nameBlock = wouldRank ? 92 : this.isPracticeRun ? 26 : 0;
    const playbook = getGamesPlayed(this.difficulty) <= PLAYBOOK_RUNS;
    nextY = this.buildInsights(
      nextY, nameBlock + LEADERBOARD_MIN_HEIGHT + (playbook ? PLAYBOOK_HEIGHT : 0),
    );
    if (playbook) nextY = this.buildPlaybookLink(nextY);

    if (wouldRank) {
      this.buildNameInput(nextY);
      nextY += 92;
    } else if (this.isPracticeRun) {
      // Where the name entry would have been, so the label answers the
      // question it leaves behind: a second go at the same 30 pieces is
      // practice, and the board keeps the score you posted first
      const practice = createBodyText('PRACTICE RUN · NOT SUBMITTED', cx, nextY, {
        fontSize: 11,
        color: THEME.textMuted,
      });
      practice.style.letterSpacing = 2;
      this.container.addChild(practice);
      nextY += 26;
    }

    this.leaderboardTop = nextY;
    this.buildLeaderboard();
    this.buildButtons();
  }

  // ── Insights ──

  /**
   * Up to three lines of what to do differently, between the stats and the
   * name entry. The block only takes space the rows below it do not need, so
   * a short screen drops the third line rather than the leaderboard.
   */
  private buildInsights(top: number, reservedBelow: number): number {
    const lines = insightsFor(this.summary, DIFFICULTY_CONFIGS[this.difficulty]);
    if (lines.length === 0) return top;

    const cx = this.width / 2;
    const wrapWidth = Math.min(300, this.width - 56);
    const limit = this.buttonsTop - reservedBelow;

    // Measure before drawing: the heading is only worth having if a line fits
    const texts: Text[] = [];
    let y = top + 30;
    for (const line of lines) {
      const t = createBodyText(line, cx, y, { fontSize: 11.5, color: THEME.textMuted, wrapWidth });
      if (y + t.height > limit) { t.destroy(); break; }
      texts.push(t);
      y += t.height + 4;
    }
    if (texts.length === 0) return top;

    this.container.addChild(createSectionLabel('INSIGHTS', cx, top, Math.min(200, this.width - 80)));
    for (const t of texts) this.container.addChild(t);
    return y + 8;
  }

  /**
   * The first runs in a mode get a door into the full guide, right where the
   * player has just been told what went wrong and may want to know why.
   */
  private buildPlaybookLink(top: number): number {
    const height = PLAYBOOK_HEIGHT - 8;
    this.container.addChild(createTextButton('HOW TO PLAY ↗', this.width / 2, top + height / 2, () => {
      this.audio.playUiClick();
      const win = window.open('/how-to-play', '_blank');
      if (win) win.opener = null; else window.location.href = '/how-to-play';
    }, { height }));
    return top + PLAYBOOK_HEIGHT;
  }

  // ── Name input ──

  private buildNameInput(top: number): void {
    const group = new Container();
    this.nameInputGroup = group;
    this.container.addChild(group);

    const promptText = new Text({
      text: 'TOP 10 — ENTER YOUR NAME',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: 12,
        fontWeight: '700',
        fill: THEME.gold,
        letterSpacing: 3,
        dropShadow: { alpha: 0.4, blur: 8, color: THEME.gold, distance: 0 },
      }),
    });
    promptText.anchor.set(0.5, 0);
    promptText.x = this.width / 2;
    promptText.y = top;
    group.addChild(promptText);

    // Name field dimensions
    const fieldW = 150;
    const fieldH = 40;
    const btnW = 70;
    const totalW = fieldW + 8 + btnW;
    const fieldX = this.width / 2 - totalW / 2;
    const fieldY = top + 24;

    // PixiJS field background (visible behind the HTML input)
    const fieldBg = new Graphics();
    fieldBg.roundRect(fieldX, fieldY, fieldW, fieldH, 8);
    fieldBg.fill({ color: 0x0c0e24, alpha: 0.95 });
    fieldBg.roundRect(fieldX, fieldY, fieldW, fieldH, 8);
    fieldBg.stroke({ color: THEME.accent, alpha: 0.6, width: 2 });
    group.addChild(fieldBg);

    this.createHtmlInput(fieldX, fieldY, fieldW, fieldH, fieldX + fieldW + 8, btnW);
  }

  private createHtmlInput(
    fieldX: number, fieldY: number, fieldW: number, fieldH: number,
    btnX: number, btnW: number,
  ): void {
    const canvas = document.querySelector('canvas')!;
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / this.width;
    const scaleY = canvasRect.height / this.height;

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 12;
    input.value = this.leaderboard.getLastName();
    input.autocomplete = 'off';
    input.enterKeyHint = 'done';
    input.inputMode = 'text';
    input.placeholder = 'Your name';

    const left = canvasRect.left + fieldX * scaleX;
    const top = canvasRect.top + fieldY * scaleY;
    const width = fieldW * scaleX;
    const height = fieldH * scaleY;
    const fontSize = 17 * scaleY;

    input.setAttribute('style', [
      `position: fixed`,
      `left: ${left}px`,
      `top: ${top}px`,
      `width: ${width}px`,
      `height: ${height}px`,
      `font-size: ${fontSize}px`,
      `font-family: 'Oxanium', sans-serif`,
      `text-align: center`,
      `color: white`,
      `background: transparent`,
      `border: none`,
      `outline: none`,
      `caret-color: white`,
      `z-index: 10000`,
      `padding: 0`,
      `margin: 0`,
      `box-sizing: border-box`,
      `-webkit-user-select: text !important`,
      `user-select: text !important`,
      `-webkit-touch-callout: default !important`,
      `touch-action: auto !important`,
    ].join('; '));

    document.body.appendChild(input);
    this.htmlInput = input;

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.submitName();
    });

    const btn = document.createElement('button');
    btn.textContent = 'SAVE';
    btn.setAttribute('style', [
      `position: fixed`,
      `left: ${canvasRect.left + btnX * scaleX}px`,
      `top: ${top}px`,
      `width: ${btnW * scaleX}px`,
      `height: ${height}px`,
      `font-size: ${14 * scaleY}px`,
      `font-family: 'Oxanium', sans-serif`,
      `font-weight: 700`,
      `letter-spacing: 2px`,
      `color: white`,
      `background: #4a7af7`,
      `border: none`,
      `border-radius: ${8 * scaleY}px`,
      `cursor: pointer`,
      `z-index: 10000`,
      `padding: 0`,
      `margin: 0`,
      `touch-action: manipulation`,
      `-webkit-tap-highlight-color: transparent`,
    ].join('; '));

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.submitName();
    });

    document.body.appendChild(btn);
    this.htmlButton = btn;
  }

  private removeHtmlInput(): void {
    if (this.htmlInput) {
      this.htmlInput.remove();
      this.htmlInput = null;
    }
    if (this.htmlButton) {
      this.htmlButton.remove();
      this.htmlButton = null;
    }
  }

  private removeNameInputGroup(): void {
    this.removeHtmlInput();
    if (this.nameInputGroup) {
      this.container.removeChild(this.nameInputGroup);
      this.nameInputGroup.destroy({ children: true });
      this.nameInputGroup = null;
    }
  }

  private async submitName(): Promise<void> {
    if (this.nameSubmitted) return;
    this.nameSubmitted = true;
    this.audio.playUiClick();

    const name = this.htmlInput?.value || '';
    this.removeNameInputGroup();
    this.rank = await this.leaderboard.submit(this.summary.score, name);
    // One submission per daily, and this was it. The flag is only a local
    // convenience — the server is what actually enforces first-submission-wins
    // — so it is set whether or not the request reached the network.
    if (this.difficulty === 'daily') markDailySubmitted(this.dailyDate);
    this.refreshLeaderboard();
  }

  private refreshLeaderboard(): void {
    if (!this.container) return;
    if (this.leaderboardContainer) {
      this.container.removeChild(this.leaderboardContainer);
      this.leaderboardContainer.destroy({ children: true });
      this.leaderboardContainer = null;
    }
    this.buildLeaderboard();
  }

  // ── Buttons ──

  private buildButtons(): void {
    const cx = this.width / 2;
    const y = this.buttonsTop;

    this.container.addChild(createButton('PLAY AGAIN', cx, y, () => {
      this.audio.playUiClick();
      this.onReplay();
    }, { width: 220, height: 52, fontSize: 18 }));

    const row = y + 56;
    this.container.addChild(createButton('MENU', cx - 58, row, () => {
      this.audio.playUiClick();
      this.onMenu();
    }, { width: 104, height: 42, color: THEME.btnSecondary, glow: false, fontSize: 14, letterSpacing: 3 }));

    this.container.addChild(createButton('SHARE', cx + 58, row, () => {
      this.audio.playUiClick();
      this.share();
    }, { width: 104, height: 42, color: THEME.btnSecondary, glow: false, fontSize: 14, letterSpacing: 3 }));

    this.shareLabel = createBodyText('', cx, row + 26, { fontSize: 10, color: THEME.cyan });
    this.container.addChild(this.shareLabel);
  }

  /** The one-line result, which travels alongside the card */
  private shareText(): string {
    const s = this.summary;
    const label = this.difficulty === 'daily'
      ? `Daily #${dailyNumber(this.dailyDate)}`
      : DIFFICULTY_LABELS[this.difficulty];
    const surveys = DIFFICULTY_CONFIGS[this.difficulty].territory.enabled && s.surveys > 0
      ? `, ${s.surveys} ${s.surveys === 1 ? 'survey' : 'surveys'}`
      : '';
    return `I scored ${s.score.toLocaleString()} in Enclave (${label}) — ` +
      `${s.claims} rooms claimed, biggest ${s.biggestRoom} cells, ×${s.maxStreak} streak${surveys}. Can you beat it?`;
  }

  /**
   * The share card as a file, or null when it cannot be made.
   *
   * Rendered on the first SHARE press and then kept: a 1080×1350 draw is
   * not something the game-over screen should ever wait on, and a card that
   * will not render is a reason to share text, not to fail the share.
   */
  private async shareCardFile(): Promise<File | null> {
    try {
      if (!this.cardPromise) {
        this.cardPromise = renderShareCard(this.summary, {
          modeLabel: this.boardLabel,
          host: window.location.host,
        });
      }
      const blob = await this.cardPromise;
      return new File([blob], 'enclave.png', { type: 'image/png' });
    } catch {
      return null;
    }
  }

  /** Share the card, falling back to the text share and then the clipboard */
  private async share(): Promise<void> {
    const text = this.shareText();
    const url = window.location.origin;
    try {
      const file = await this.shareCardFile();
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Enclave', text });
        this.setShareLabel('SHARED');
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: 'Enclave', text, url });
        this.setShareLabel('SHARED');
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      this.setShareLabel('COPIED TO CLIPBOARD');
    } catch {
      this.setShareLabel('SHARING NOT AVAILABLE');
    }
  }

  private setShareLabel(text: string): void {
    if (!this.shareLabel) return;
    this.shareLabel.text = text;
    this.shareLabel.alpha = 1;
  }

  // ── Leaderboard display ──

  private buildLeaderboard(): void {
    const entries = this.leaderboard.getEntries();
    const lbContainer = new Container();
    this.leaderboardContainer = lbContainer;
    this.container.addChild(lbContainer);

    const cx = this.width / 2;
    const startY = this.leaderboardTop;
    lbContainer.addChild(createSectionLabel(`LEADERBOARD — ${this.boardLabel}`, cx, startY));

    if (entries.length === 0) {
      lbContainer.addChild(createBodyText('No scores yet.', cx, startY + 36, { fontSize: 12, color: THEME.textMuted }));
      return;
    }

    const lineHeight = 24;
    const listStartY = startY + 36;
    const available = this.buttonsTop - 36 - listStartY;
    const maxRows = Math.max(3, Math.min(10, Math.floor(available / lineHeight)));
    const halfW = Math.min(160, this.width / 2 - 24);
    const leftX = cx - halfW;
    const rightX = cx + halfW;

    // Make sure the player's own row is visible even if it's beyond the cutoff
    const ownIdx = this.rank !== null ? this.rank - 1 : -1;
    const rows: number[] = [];
    for (let i = 0; i < Math.min(entries.length, maxRows); i++) rows.push(i);
    if (ownIdx >= maxRows && ownIdx < entries.length) {
      rows[rows.length - 1] = ownIdx;
    }

    rows.forEach((i, r) => {
      const entry = entries[i];
      const y = listStartY + r * lineHeight;
      const isCurrentScore = i === ownIdx;
      const isTop3 = i < 3;

      const color = isCurrentScore ? THEME.gold : (isTop3 ? THEME.textPrimary : THEME.textSecondary);
      const fontSize = isCurrentScore ? 15 : 13;

      if (isCurrentScore) {
        const row = new Graphics();
        row.roundRect(leftX - 10, y - lineHeight / 2 + 1, halfW * 2 + 20, lineHeight - 2, 6);
        row.fill({ color: THEME.gold, alpha: 0.12 });
        lbContainer.addChild(row);
      }

      const rank = new Text({
        text: `${i + 1}`,
        style: new TextStyle({ fontFamily: FONT_MONO, fontSize, fill: isCurrentScore ? THEME.gold : THEME.textMuted }),
      });
      rank.anchor.set(0, 0.5);
      rank.x = leftX;
      rank.y = y;
      lbContainer.addChild(rank);

      const displayName = entry.name || 'Player';
      const labelText = new Text({
        text: displayName,
        style: new TextStyle({
          fontFamily: FONT_DISPLAY,
          fontSize,
          fontWeight: isCurrentScore || isTop3 ? '700' : '500',
          fill: color,
        }),
      });
      labelText.anchor.set(0, 0.5);
      labelText.x = leftX + 26;
      labelText.y = y;
      lbContainer.addChild(labelText);

      const valText = new Text({
        text: entry.score.toLocaleString(),
        style: new TextStyle({ fontFamily: FONT_MONO, fontSize, fill: color }),
      });
      valText.anchor.set(1, 0.5);
      valText.x = rightX;
      valText.y = y;
      lbContainer.addChild(valText);
    });
  }

  // ── Scene lifecycle ──

  update(dt: number): void {
    // Score count-up over ~0.9s with an ease-out
    if (this.scoreText && !this.countDone) {
      this.countElapsed += dt;
      const t = Math.min(1, this.countElapsed / 0.9);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(this.summary.score * eased);
      this.scoreText.text = value.toLocaleString();
      if (t >= 1) {
        this.countDone = true;
        this.scoreText.text = this.summary.score.toLocaleString();
      }
    }
    if (this.shareLabel && this.shareLabel.alpha > 0 && this.shareLabel.text) {
      this.shareLabel.alpha = Math.max(0, this.shareLabel.alpha - dt * 0.35);
    }
  }

  enter(): void {}

  exit(): void {
    this.removeHtmlInput();
    this.container.removeAllListeners();
  }
}
