import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Scene } from './SceneManager';
import { Leaderboard } from '../core/Leaderboard';
import { Difficulty, DIFFICULTY_LABELS, DIFFICULTY_CONFIGS } from '../core/Config';
import { dailyKey, dailyNumber, formatCountdown, msUntilNextDaily } from '../core/Daily';
import { PaletteSetting, getPersonalBest, getGamesPlayed, loadSettings, updateSettings } from '../core/Settings';
import { MOTION_LABELS, MOTION_ORDER, getPiecePalette, remapColor } from '../core/Accessibility';
import {
  LifetimeStats, formatPlayTime, formatRoomSize, loadStats, mostCommonRoomSize,
} from '../core/Stats';
import { AudioManager } from '../audio/AudioManager';
import { FONT_DISPLAY, FONT_MONO, THEME, DIFFICULTY_COLORS, drawPanel, drawBeveledBlock, easeOutBack } from '../rendering/Theme';
import {
  createButton, createToggle, createCycleToggle, createSectionLabel, createBodyText,
  createSlider, createTextButton,
} from '../rendering/Widgets';

const DIFFICULTIES: Difficulty[] = ['classic', 'blitz', 'daily'];
const DIFFICULTY_DESCRIPTIONS: Record<Difficulty, string> = {
  classic: 'A minute on the clock. Build big rooms, close them with care.',
  blitz: 'Thirty-five seconds. Fence fast, claim faster.',
  // The daily's line is written at build time: it carries today's number
  daily: '30 pieces · no clock. Same pieces for everyone.',
};

/** How often the RESETS IN readout is rewritten. It only shows hh:mm. */
const RESET_REFRESH_SECONDS = 60;

// Cycle orders for the OPTIONS panel. Index 0 is the default in each.
const PALETTE_ORDER: PaletteSetting[] = ['standard', 'highContrast'];
const PALETTE_LABELS = ['STANDARD', 'HIGH'];
const HAND_LABELS = ['RIGHT', 'LEFT'];

/** The STATS panel's rows, in reading order */
function statRows(stats: LifetimeStats): [string, string][] {
  return [
    ['RUNS', String(stats.runs)],
    ['BEST', stats.bestScore.toLocaleString()],
    ['BIGGEST ROOM', stats.biggestRoom > 0 ? `${stats.biggestRoom} cells` : '—'],
    ['ROOMS', stats.roomsTotal.toLocaleString()],
    ['SURVEYS', String(stats.surveysTotal)],
    ['USUAL ROOM', formatRoomSize(mostCommonRoomSize(stats))],
    ['TIME PLAYED', formatPlayTime(stats.playSeconds)],
    ['LAST PLAYED', formatLastPlayed(stats.lastPlayed)],
  ];
}

/** A stored ISO timestamp as the player's own local date */
function formatLastPlayed(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

interface FloatingBlock {
  x: number;
  y: number;
  vy: number;
  size: number;
  color: number;
  alpha: number;
  rot: number;
  vrot: number;
}

export class MenuScene implements Scene {
  container: Container;
  private onPlay: () => void;
  private onDifficultyChange: (d: Difficulty) => void;
  private width: number;
  private height: number;
  private leaderboard: Leaderboard;
  private audio: AudioManager;
  private selectedDifficulty: Difficulty;
  private showingHelp = false;
  private showingOptions = false;
  private showingStats = false;

  // Rebuildable sections
  private difficultyContainer: Container | null = null;
  private lowerContainer: Container | null = null;
  private title: Text | null = null;
  private titlePhase = 0;
  /** The BEST / RESETS IN line, kept so the daily countdown can be rewritten */
  private statsText: Text | null = null;
  private resetElapsed = 0;

  // Ambient background
  private bgGfx: Graphics;
  private blocks: FloatingBlock[] = [];

  constructor(
    width: number, height: number,
    leaderboard: Leaderboard,
    audio: AudioManager,
    selectedDifficulty: Difficulty,
    onDifficultyChange: (d: Difficulty) => void,
    onPlay: () => void,
  ) {
    this.width = width;
    this.height = height;
    this.leaderboard = leaderboard;
    this.audio = audio;
    this.selectedDifficulty = selectedDifficulty;
    this.onDifficultyChange = onDifficultyChange;
    this.onPlay = onPlay;
    this.container = new Container();
    this.bgGfx = new Graphics();
    this.container.addChild(this.bgGfx);
    this.initBlocks();
    this.build();
  }

  private initBlocks(): void {
    this.blocks = [];
    for (let i = 0; i < 14; i++) {
      this.blocks.push(this.spawnBlock(true));
    }
  }

  private spawnBlock(anywhere: boolean): FloatingBlock {
    const size = 14 + Math.random() * 26;
    const palette = getPiecePalette();
    return {
      x: Math.random() * this.width,
      y: anywhere ? Math.random() * this.height : this.height + size,
      vy: -(8 + Math.random() * 14),
      size,
      color: palette[Math.floor(Math.random() * palette.length)],
      alpha: 0.10 + Math.random() * 0.12,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.4,
    };
  }

  private build(): void {
    const cx = this.width / 2;

    // Animated logo: a fence of blocks assembling around a gold room
    this.logoGfx = new Graphics();
    this.container.addChild(this.logoGfx);
    this.logoT = 0;

    // Title
    this.title = new Text({
      text: 'ENCLAVE',
      style: new TextStyle({
        fontFamily: FONT_DISPLAY,
        fontSize: Math.min(44, this.width / 10),
        fontWeight: '800',
        fill: THEME.textPrimary,
        letterSpacing: 6,
        dropShadow: { alpha: 0.5, blur: 18, color: THEME.accent, distance: 0 },
      }),
    });
    this.title.anchor.set(0.5);
    this.title.x = cx;
    this.title.y = this.height * 0.115;
    this.container.addChild(this.title);

    const tagline = createBodyText('FENCE IT IN · CLAIM THE ROOM · BEAT THE CLOCK', cx, this.height * 0.115 + 26, {
      fontSize: 10,
      color: THEME.textMuted,
      wrapWidth: this.width - 32,
    });
    tagline.style.letterSpacing = 2;
    this.container.addChild(tagline);

    // Difficulty selector
    this.buildDifficultySelector();

    // Play button
    this.container.addChild(createButton('PLAY', cx, this.height * 0.335, () => {
      this.audio.unlock();
      this.audio.playUiClick();
      this.onPlay();
    }, { width: 220, height: 58, fontSize: 22, letterSpacing: 6 }));

    // Settings row
    const settings = loadSettings();
    const toggleY = this.height * 0.335 + 52;
    const pillW = Math.min(104, (this.width - 40) / 3);
    const pillGap = pillW + 6;
    this.container.addChild(createToggle('SOUND', cx - pillGap, toggleY, settings.sfx, (v) => {
      this.audio.unlock();
      this.audio.setSfxEnabled(v);
      this.audio.playUiClick();
      return v;
    }, pillW));
    this.container.addChild(createToggle('MUSIC', cx, toggleY, settings.music, (v) => {
      this.audio.unlock();
      this.audio.setMusicEnabled(v);
      this.audio.playUiClick();
      return v;
    }, pillW));
    this.container.addChild(createToggle('HAPTIC', cx + pillGap, toggleY, settings.haptics, (v) => {
      updateSettings({ haptics: v });
      this.audio.playUiClick();
      if (v && navigator.vibrate) { try { navigator.vibrate(20); } catch { /* */ } }
      return v;
    }, pillW));

    // Help / options / refresh (top corners)
    this.addCornerButton('?', 30, () => {
      this.audio.playUiClick();
      this.showingHelp = !this.showingHelp;
      if (this.showingHelp) { this.showingOptions = false; this.showingStats = false; }
      this.buildLowerSection();
    });
    this.addCornerButton('⚙', 70, () => {
      this.audio.playUiClick();
      this.showingOptions = !this.showingOptions;
      if (this.showingOptions) { this.showingHelp = false; this.showingStats = false; }
      this.buildLowerSection();
    });
    this.addCornerButton('↻', this.width - 30, () => {
      window.location.reload();
    });

    // Build version (bottom-right) so it's obvious when a new deploy has arrived
    const version = new Text({
      text: `v${__APP_VERSION__}`,
      style: new TextStyle({ fontFamily: FONT_MONO, fontSize: 10, fill: THEME.textMuted, letterSpacing: 1 }),
    });
    version.anchor.set(1, 1);
    version.x = this.width - 12;
    version.y = this.height - 10;
    version.alpha = 0.7;
    this.container.addChild(version);

    this.buildLowerSection();
  }

  private addCornerButton(label: string, x: number, onClick: () => void): void {
    const root = new Container();
    const bg = new Graphics();
    bg.circle(x, 28, 17);
    bg.fill({ color: 0x000000, alpha: 0.28 });
    bg.circle(x, 28, 17);
    bg.stroke({ color: 0xffffff, alpha: 0.12, width: 1 });
    root.addChild(bg);
    const text = new Text({
      text: label,
      style: new TextStyle({ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: '700', fill: THEME.textSecondary }),
    });
    text.anchor.set(0.5);
    text.x = x;
    text.y = 28;
    root.addChild(text);
    root.eventMode = 'static';
    root.cursor = 'pointer';
    root.on('pointerdown', (e) => e.stopPropagation());
    root.on('pointerup', (e) => { e.stopPropagation(); onClick(); });
    this.container.addChild(root);
  }

  // ── Difficulty selector ──

  private buildDifficultySelector(): void {
    if (this.difficultyContainer) {
      this.container.removeChild(this.difficultyContainer);
      this.difficultyContainer.destroy({ children: true });
    }
    this.statsText = null;

    const group = new Container();
    this.difficultyContainer = group;
    this.container.addChild(group);

    const selectorY = this.height * 0.175;
    const chipH = 36;
    const gap = 8;
    // Three chips have to fit a 360-wide phone, so the row is sized from the
    // count and the label tightens with it rather than wrapping to two lines.
    const chipW = Math.min(92, (this.width - 44 - gap * (DIFFICULTIES.length - 1)) / DIFFICULTIES.length);
    const labelSize = chipW >= 76 ? 12 : 11;
    const labelSpacing = chipW >= 88 ? 2 : 1;
    const totalW = DIFFICULTIES.length * chipW + (DIFFICULTIES.length - 1) * gap;
    const startX = this.width / 2 - totalW / 2;

    for (let i = 0; i < DIFFICULTIES.length; i++) {
      const diff = DIFFICULTIES[i];
      const isSelected = diff === this.selectedDifficulty;
      const accent = DIFFICULTY_COLORS[diff];
      const x = startX + i * (chipW + gap);

      const chip = new Graphics();
      if (isSelected) {
        chip.roundRect(x - 2, selectorY - 2, chipW + 4, chipH + 4, 11);
        chip.fill({ color: accent, alpha: 0.3 });
        chip.roundRect(x, selectorY, chipW, chipH, 9);
        chip.fill({ color: accent });
        chip.roundRect(x + 1, selectorY + 1, chipW - 2, chipH * 0.45, 8);
        chip.fill({ color: 0xffffff, alpha: 0.14 });
      } else {
        chip.roundRect(x, selectorY, chipW, chipH, 9);
        chip.fill({ color: 0x000000, alpha: 0.3 });
        chip.roundRect(x, selectorY, chipW, chipH, 9);
        chip.stroke({ color: 0xffffff, alpha: 0.1, width: 1 });
      }
      group.addChild(chip);

      const label = new Text({
        text: DIFFICULTY_LABELS[diff],
        style: new TextStyle({
          fontFamily: FONT_DISPLAY,
          fontSize: labelSize,
          fontWeight: isSelected ? '800' : '600',
          fill: isSelected ? THEME.textPrimary : THEME.textSecondary,
          letterSpacing: labelSpacing,
        }),
      });
      label.anchor.set(0.5);
      label.x = x + chipW / 2;
      label.y = selectorY + chipH / 2;
      group.addChild(label);

      const hit = new Container();
      hit.addChild(chip);
      hit.addChild(label);
      group.addChild(hit);
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => e.stopPropagation());
      hit.on('pointerup', (e) => {
        e.stopPropagation();
        if (diff === this.selectedDifficulty) return;
        this.audio.playUiClick();
        this.selectedDifficulty = diff;
        this.onDifficultyChange(diff);
        this.buildDifficultySelector();
        this.buildLowerSection();
      });
    }

    const desc = createBodyText(this.describeSelected(), this.width / 2, selectorY + chipH + 12, {
      fontSize: 11,
      color: DIFFICULTY_COLORS[this.selectedDifficulty],
      wrapWidth: Math.min(300, this.width - 40),
    });
    group.addChild(desc);

    const stats = new Text({
      text: this.statsLine(),
      style: new TextStyle({
        fontFamily: FONT_MONO,
        fontSize: 11,
        fill: THEME.textMuted,
        letterSpacing: 1,
      }),
    });
    stats.anchor.set(0.5, 0);
    stats.x = this.width / 2;
    stats.y = selectorY + chipH + 50;
    group.addChild(stats);
    this.statsText = stats;
    this.resetElapsed = 0;
  }

  /** Mode blurb. The daily's carries its number, so it changes every day. */
  private describeSelected(): string {
    if (this.selectedDifficulty !== 'daily') return DIFFICULTY_DESCRIPTIONS[this.selectedDifficulty];
    const budget = DIFFICULTY_CONFIGS.daily.pieceBudget ?? 0;
    return `Daily #${dailyNumber(dailyKey())} · ${budget} pieces · no clock. Same pieces for everyone.`;
  }

  /**
   * The line under the blurb: a lifetime best and games played for the timed
   * modes, today's best and the reset countdown for the daily — where a
   * lifetime best would mean nothing, since every day is a different puzzle.
   */
  private statsLine(): string {
    if (this.selectedDifficulty === 'daily') {
      const key = dailyKey();
      const best = getPersonalBest('daily', key);
      const resets = `RESETS IN ${formatCountdown(msUntilNextDaily())}`;
      return best > 0
        ? `BEST TODAY ${best.toLocaleString()}   ·   ${resets}`
        : `NOT PLAYED YET   ·   ${resets}`;
    }
    const cfg = DIFFICULTY_CONFIGS[this.selectedDifficulty].timer;
    const best = getPersonalBest(this.selectedDifficulty);
    const games = getGamesPlayed(this.selectedDifficulty);
    return best > 0
      ? `BEST ${best.toLocaleString()}   ·   ${games} ${games === 1 ? 'GAME' : 'GAMES'}   ·   ${cfg.startSeconds}s CLOCK`
      : `${cfg.startSeconds}s CLOCK   ·   NO RUNS YET`;
  }

  // ── Lower section: leaderboard, help or options ──

  private buildLowerSection(): void {
    if (this.lowerContainer) {
      this.container.removeChild(this.lowerContainer);
      this.lowerContainer.destroy({ children: true });
      this.lowerContainer = null;
    }
    const group = new Container();
    this.lowerContainer = group;
    this.container.addChild(group);

    if (this.showingHelp) {
      this.buildHelp(group);
    } else if (this.showingOptions) {
      this.buildOptions(group);
    } else if (this.showingStats) {
      this.buildStats(group);
    } else {
      this.buildLeaderboard(group);
    }
  }

  /**
   * Lifetime stats for the selected mode.
   *
   * It gets a panel rather than a fourth corner button: three corners is all
   * a 360-wide phone has room for, and this is a place you go to read, not a
   * switch you flip. The way in is the text button under the leaderboard,
   * because the OPTIONS panel's footer is already the line a short screen
   * drops — a door that can vanish is not a door.
   */
  private buildStats(group: Container): void {
    const cx = this.width / 2;
    const top = this.height * 0.47;
    const panelW = Math.min(360, this.width - 32);
    const stats = loadStats(this.selectedDifficulty);

    group.addChild(createSectionLabel(
      `STATS — ${DIFFICULTY_LABELS[this.selectedDifficulty]}`, cx, top + 14, panelW - 60,
    ));

    const backH = 34;
    let bottom: number;

    if (stats.runs === 0) {
      const note = createBodyText('No runs yet.', cx, top + 58, {
        fontSize: 12,
        color: THEME.textMuted,
      });
      group.addChild(note);
      bottom = top + 58 + note.height + 18 + backH + 12;
    } else {
      const halfW = Math.min(panelW / 2 - 26, this.width / 2 - 30);
      const rows = statRows(stats);
      const listTop = top + 60;
      // Rows tighten rather than run off the bottom of a short screen
      const rowH = Math.min(26, Math.max(20, (this.height - 30 - backH - listTop) / rows.length));
      let y = listTop;
      for (const [label, value] of rows) {
        const key = new Text({
          text: label,
          style: new TextStyle({
            fontFamily: FONT_DISPLAY, fontSize: 11, fontWeight: '600',
            fill: THEME.textMuted, letterSpacing: 2,
          }),
        });
        key.anchor.set(0, 0.5);
        key.x = cx - halfW;
        key.y = y;
        group.addChild(key);

        const val = new Text({
          text: value,
          style: new TextStyle({ fontFamily: FONT_MONO, fontSize: 13, fill: THEME.textPrimary }),
        });
        val.anchor.set(1, 0.5);
        val.x = cx + halfW;
        val.y = y;
        group.addChild(val);
        y += rowH;
      }
      bottom = y + backH / 2 + 12;
    }

    // The panel is entered from a button that is no longer on screen, so it
    // carries its own way back rather than relying on the corner buttons.
    group.addChild(createButton('BACK', cx, bottom - backH / 2 - 6, () => {
      this.audio.playUiClick();
      this.showingStats = false;
      this.buildLowerSection();
    }, { width: 120, height: backH, color: THEME.btnSecondary, glow: false, fontSize: 12, letterSpacing: 3 }));

    const panel = new Graphics();
    drawPanel(panel, cx - panelW / 2, top, panelW, bottom - top, 16, 0.55);
    group.addChildAt(panel, 0);
  }

  /**
   * Accessibility and comfort settings. Each row applies on the spot and is
   * persisted, so there is nothing to confirm.
   */
  private buildOptions(group: Container): void {
    const cx = this.width / 2;
    const top = this.height * 0.47;
    const panelW = Math.min(360, this.width - 32);
    const rowW = Math.min(240, panelW - 48);
    const captionW = panelW - 56;
    const settings = loadSettings();

    group.addChild(createSectionLabel('OPTIONS', cx, top + 14, panelW - 60));

    // Volume before comfort: it is the setting people come here for, and the
    // pills on the menu only say on or off. The heading is the first thing a
    // short screen loses — the two sliders label themselves — and after that
    // the comfort rows tighten. Nothing below is ever pushed off.
    const roomy = this.height >= 640;
    if (roomy) group.addChild(createSectionLabel('AUDIO', cx, top + 40, panelW - 140));
    const sliderY = roomy ? top + 88 : top + 50;
    group.addChild(createSlider('SFX', this.audio.sfxLevel, (v) => {
      this.audio.unlock();
      this.audio.setSfxVolume(v);
      this.audio.playVolumePreview('sfx');
    }, { cx, cy: sliderY, width: rowW }));
    group.addChild(createSlider('MUSIC', this.audio.musicLevel, (v) => {
      this.audio.unlock();
      this.audio.setMusicVolume(v);
      this.audio.playVolumePreview('music');
    }, { cx, cy: sliderY + 40, width: rowW }));

    // Rows are stacked off measured text height rather than a fixed pitch, so
    // a caption that wraps on a narrow phone pushes the next row down instead
    // of colliding with it. The gap between them closes to fit whatever the
    // audio section left, the way the STATS rows do: a caption is a single
    // line at every width this panel is drawn at, so what three rows need is
    // knowable before any of them has been measured.
    let y = sliderY + 78;
    const captionLine = 15;
    const rowGap = Math.max(30, Math.min(42, (this.height - 44 - y - 3 * captionLine) / 2));
    let contentBottom = y;
    const addRow = (control: Container, note: string): void => {
      group.addChild(control);
      const caption = createBodyText(note, cx, y + 20, {
        fontSize: 10,
        color: THEME.textMuted,
        wrapWidth: captionW,
      });
      group.addChild(caption);
      contentBottom = caption.y + caption.height;
      y += caption.height + rowGap;
    };

    addRow(createCycleToggle(
      'MOTION', cx, y, MOTION_LABELS, Math.max(0, MOTION_ORDER.indexOf(settings.motion)),
      (i) => {
        updateSettings({ motion: MOTION_ORDER[i] });
        this.audio.playUiClick();
      }, rowW,
    ), 'Shake, flashes, slow-motion.');

    addRow(createCycleToggle(
      'COLOURS', cx, y, PALETTE_LABELS, Math.max(0, PALETTE_ORDER.indexOf(settings.palette)),
      (i) => {
        // Remap what is already drifting on screen, so the switch is visible
        const from = getPiecePalette();
        updateSettings({ palette: PALETTE_ORDER[i] });
        const to = getPiecePalette();
        for (const b of this.blocks) b.color = remapColor(b.color, from, to);
        this.audio.playUiClick();
      }, rowW,
    ), 'Colour-blind safe piece colours.');

    addRow(createCycleToggle(
      'LAYOUT', cx, y, HAND_LABELS, settings.leftHanded ? 1 : 0,
      (i) => {
        updateSettings({ leftHanded: i === 1 });
        this.audio.playUiClick();
      }, rowW,
    ), 'HOLD and NEXT sides. Next run.');

    // The footer is the one droppable line, so a short screen loses it rather
    // than pushing the panel over the build number in the corner. Measured off
    // the last caption rather than the next row's slot, so the panel encloses
    // its content whatever the gap has closed to.
    const footerY = contentBottom + 10;
    const footer = createBodyText('SYSTEM follows your device.', cx, footerY, {
      fontSize: 10,
      color: THEME.textMuted,
      wrapWidth: captionW,
    });
    let bottom = footerY + footer.height + 14;
    if (bottom <= this.height - 24) {
      group.addChild(footer);
    } else {
      footer.destroy();
      bottom = footerY;
    }

    // Drawn last so its height can follow the rows, added behind them
    const panel = new Graphics();
    drawPanel(panel, cx - panelW / 2, top, panelW, bottom - top, 16, 0.55);
    group.addChildAt(panel, 0);
  }

  private buildHelp(group: Container): void {
    const cx = this.width / 2;
    const top = this.height * 0.47;
    const panelW = Math.min(360, this.width - 32);
    const panelH = Math.min(this.height - top - 16, 330);
    const panel = new Graphics();
    drawPanel(panel, cx - panelW / 2, top, panelW, panelH, 16, 0.55);
    group.addChild(panel);

    group.addChild(createSectionLabel('HOW TO PLAY', cx, top + 14, panelW - 60));

    const lines = [
      'Drag the piece in your hand onto the 9×9 board. Tap it, or ROTATE, to turn it. HOLD parks a piece for later.',
      'Completely fence in empty space with blocks and you CLAIM it: the room and its walls vanish and you score the room\'s area squared. A 2×2 room is 160 points, a 3×3 is 810, a 4×4 is 2,560.',
      'Close two rooms with one piece for a multiplier. Claim on consecutive placements to build a STREAK.',
      'The clock drains constantly. Every placement adds time, and claims add more. Gold cells show where one block would close a room.',
      'Claimed floor stays lit and pays half if you claim it again. Light all 49 inner cells for a SURVEY: 5,000 in Classic, and the map resets.',
      'A claim\'s fence lingers as a fading ghost that still counts as a wall, 2 s in Classic. Close the room next door against it for ×1.25.',
      'The game ends when the clock hits zero or your piece cannot fit anywhere, even after a hold.',
    ];
    const guideBtnH = 34;
    const guideBtnY = top + panelH - guideBtnH / 2 - 12;
    let y = top + 48;
    const textLimit = guideBtnY - guideBtnH / 2 - 14;
    for (const line of lines) {
      const t = createBodyText(line, cx - panelW / 2 + 34, y, {
        fontSize: 11.5,
        wrapWidth: panelW - 54,
        align: 'left',
      });
      // Only draw lines that fit above the FULL GUIDE button
      if (y + t.height > textLimit) { t.destroy(); break; }
      const bullet = new Graphics();
      bullet.circle(cx - panelW / 2 + 22, y + 9, 3);
      bullet.fill({ color: THEME.accentGlow });
      group.addChild(bullet);
      group.addChild(t);
      y += t.height + 10;
    }

    // Full interactive guide (public/how-to-play.html, served at /how-to-play)
    group.addChild(createButton('FULL GUIDE ↗', cx, guideBtnY, () => {
      this.audio.playUiClick();
      const win = window.open('/how-to-play', '_blank');
      if (win) win.opener = null; else window.location.href = '/how-to-play';
    }, { width: 180, height: guideBtnH, fontSize: 12, letterSpacing: 3 }));

    // Decorative sample piece in the corner
    const g = new Graphics();
    const s = 10;
    const bx = cx + panelW / 2 - 50;
    const by = top + 12;
    drawBeveledBlock(g, bx, by, s, THEME.accent, 3);
    drawBeveledBlock(g, bx + s + 1, by, s, THEME.accent, 3);
    drawBeveledBlock(g, bx + (s + 1) * 2, by, s, THEME.accent, 3);
    drawBeveledBlock(g, bx, by + s + 1, s, THEME.accent, 3);
    group.addChild(g);
  }

  private buildLeaderboard(group: Container): void {
    const entries = this.leaderboard.getEntries();
    const cx = this.width / 2;
    const startY = this.height * 0.47;

    const boardName = this.selectedDifficulty === 'daily'
      ? `DAILY #${dailyNumber(dailyKey())}`
      : DIFFICULTY_LABELS[this.selectedDifficulty];
    group.addChild(createSectionLabel(`LEADERBOARD — ${boardName}`, cx, startY));

    // The stats door sits at the foot of the section, and the rows are
    // budgeted around it rather than over it
    const statsY = this.height - 30;

    if (entries.length === 0) {
      group.addChild(createBodyText('No scores yet. Be the first on the board.', cx, startY + 40, {
        fontSize: 12,
        color: THEME.textMuted,
      }));
      group.addChild(this.statsLink(cx, statsY));
      return;
    }

    const lineHeight = 28;
    const listStartY = startY + 40;
    const available = statsY - 26 - listStartY;
    const maxRows = Math.max(3, Math.min(10, Math.floor(available / lineHeight)));
    const halfW = Math.min(150, this.width / 2 - 24);
    const leftX = cx - halfW;
    const rightX = cx + halfW;

    for (let i = 0; i < Math.min(entries.length, maxRows); i++) {
      const entry = entries[i];
      const y = listStartY + i * lineHeight;
      const isTop3 = i < 3;
      const color = i === 0 ? THEME.gold : isTop3 ? THEME.textPrimary : THEME.textSecondary;
      const fontSize = i === 0 ? 16 : 14;

      if (i % 2 === 0) {
        const row = new Graphics();
        row.roundRect(leftX - 10, y - lineHeight / 2 + 2, halfW * 2 + 20, lineHeight - 4, 6);
        row.fill({ color: 0x000000, alpha: 0.14 });
        group.addChild(row);
      }

      const rank = new Text({
        text: `${i + 1}`,
        style: new TextStyle({ fontFamily: FONT_MONO, fontSize, fill: THEME.textMuted }),
      });
      rank.anchor.set(0, 0.5);
      rank.x = leftX;
      rank.y = y;
      group.addChild(rank);

      const displayName = entry.name || 'Player';
      const labelText = new Text({
        text: displayName,
        style: new TextStyle({
          fontFamily: FONT_DISPLAY,
          fontSize,
          fontWeight: isTop3 ? '700' : '500',
          fill: color,
        }),
      });
      labelText.anchor.set(0, 0.5);
      labelText.x = leftX + 28;
      labelText.y = y;
      group.addChild(labelText);

      const valText = new Text({
        text: entry.score.toLocaleString(),
        style: new TextStyle({ fontFamily: FONT_MONO, fontSize, fill: color }),
      });
      valText.anchor.set(1, 0.5);
      valText.x = rightX;
      valText.y = y;
      group.addChild(valText);
    }

    group.addChild(this.statsLink(cx, statsY));
  }

  private statsLink(cx: number, cy: number): Container {
    return createTextButton('STATS', cx, cy, () => {
      this.audio.playUiClick();
      this.showingStats = true;
      this.showingHelp = false;
      this.showingOptions = false;
      this.buildLowerSection();
    }, { color: THEME.textSecondary });
  }

  private logoGfx: Graphics | null = null;
  private logoT = 0;

  /** Draw the logo: 16 fence blocks fly in with a stagger, the gold room pulses */
  private drawLogo(): void {
    const g = this.logoGfx;
    if (!g) return;
    g.clear();
    const cell = Math.max(7, Math.min(10, this.width / 40));
    const cx = this.width / 2;
    const cy = this.height * 0.045;
    const x0 = cx - cell * 2.5;
    const y0 = cy - cell * 2.5;
    let idx = 0;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const ring = r === 0 || r === 4 || c === 0 || c === 4;
        const center = r === 2 && c === 2;
        if (!ring && !center) continue;
        const delay = center ? 1.0 : idx * 0.05;
        const t = Math.max(0, Math.min(1, (this.logoT - delay) / 0.35));
        const k = easeOutBack(t);
        if (t <= 0) { if (ring) idx++; continue; }
        const angle = (idx / 16) * Math.PI * 2;
        const fly = (1 - k) * cell * 4;
        const x = x0 + c * cell + Math.cos(angle) * fly;
        const y = y0 + r * cell + Math.sin(angle) * fly;
        const pulse = center ? 1 + Math.sin(this.logoT * 3) * 0.08 : 1;
        const s = (cell - 1) * pulse;
        drawBeveledBlock(g, x + (cell - 1 - s) / 2, y + (cell - 1 - s) / 2, s, center ? THEME.gold : THEME.accent, 2, Math.min(1, t * 2));
        if (center && t >= 1) {
          g.roundRect(x - 3, y - 3, cell + 5, cell + 5, 4);
          g.stroke({ color: THEME.gold, alpha: 0.25 + Math.sin(this.logoT * 3) * 0.15, width: 2 });
        }
        if (ring) idx++;
      }
    }
  }

  update(dt: number): void {
    // The daily countdown is only accurate to the minute, so rewrite it on
    // the minute rather than every frame
    if (this.selectedDifficulty === 'daily' && this.statsText) {
      this.resetElapsed += dt;
      if (this.resetElapsed >= RESET_REFRESH_SECONDS) {
        this.resetElapsed = 0;
        this.statsText.text = this.statsLine();
      }
    }

    // Title breathing glow
    this.titlePhase += dt;
    if (this.title) {
      this.title.scale.set(1 + Math.sin(this.titlePhase * 1.6) * 0.012);
    }
    this.logoT += dt;
    this.drawLogo();

    // Floating blocks
    const g = this.bgGfx;
    g.clear();
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      b.y += b.vy * dt;
      b.rot += b.vrot * dt;
      if (b.y < -b.size * 2) this.blocks[i] = this.spawnBlock(false);
      const half = b.size / 2;
      g.roundRect(b.x - half, b.y - half, b.size, b.size, b.size * 0.2);
      g.fill({ color: b.color, alpha: b.alpha });
      g.roundRect(b.x - half + 2, b.y - half + 2, b.size - 4, b.size * 0.35, b.size * 0.15);
      g.fill({ color: 0xffffff, alpha: b.alpha * 0.5 });
    }
  }

  /** Called when remote leaderboard data arrives after the menu was built */
  refreshLeaderboard(): void {
    if (!this.showingHelp && !this.showingOptions && !this.showingStats) this.buildLowerSection();
  }

  /** Pending logo jingle, dropped if the menu is left before it starts */
  private jingleTimer: number | null = null;

  /**
   * The first gesture on the menu is what browsers accept as permission to
   * make a sound, so it is also the first moment the logo jingle can play.
   * AudioManager keeps it to once a page load; this only has to catch the
   * gesture, wherever on the screen it lands — and hold it back a beat, since
   * a first tap is quite often PLAY, and a menu jingle should not follow the
   * player into the countdown.
   */
  private onFirstGesture = (): void => {
    this.audio.unlock();
    this.detachGestureWatch();
    this.jingleTimer = window.setTimeout(() => {
      this.jingleTimer = null;
      this.audio.playLogoJingle();
    }, 250);
  };

  private detachGestureWatch(): void {
    window.removeEventListener('pointerdown', this.onFirstGesture);
    window.removeEventListener('keydown', this.onFirstGesture);
    if (this.jingleTimer !== null) {
      window.clearTimeout(this.jingleTimer);
      this.jingleTimer = null;
    }
  }

  enter(): void {
    window.addEventListener('pointerdown', this.onFirstGesture);
    window.addEventListener('keydown', this.onFirstGesture);
  }

  exit(): void {
    this.detachGestureWatch();
    this.container.removeAllListeners();
  }
}
