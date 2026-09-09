import { DIFFICULTY_CONFIGS } from './Config';
import { getProgressStatus } from './Progression';
import { GRID_SIZE, RunSummary } from './types';
import { FONT_DISPLAY, FONT_MONO, THEME } from '../rendering/Theme';

/**
 * The share card: one 1080×1350 PNG carrying the score and the board it was
 * won on, so a result can travel as a picture instead of a sentence.
 *
 * Drawn on a plain 2D canvas rather than through Pixi. The renderer is busy
 * with the game and a share is a one-off, off-screen draw — there is nothing
 * here that needs a scene graph, a texture or a GPU.
 *
 * The layout is split out as a pure function so the arithmetic can be tested
 * without a canvas: `layoutShareCard` decides every string and position,
 * `paintShareCard` only puts them on the context.
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

/** Side margin. Everything on the card lives inside it. */
const PAD = 90;

const WORDMARK_Y = 110;
const MODE_Y = 172;
const SCORE_Y = 340;
const STAT_VALUE_Y = 520;
const STAT_CAPTION_Y = 574;
const MAP_LABEL_Y = 650;
const MAP_TOP = 700;
const MAP_CELL = 72;
const MAP_GAP = 8;
const URL_Y = 1300;

/** Inner cells per side: the 7×7 that can ever be floor */
const INNER_SIDE = GRID_SIZE - 2;

export interface CardText {
  text: string;
  /** Centre of the text, both axes — everything on the card is centred */
  x: number;
  y: number;
  size: number;
  color: number;
}

export interface CardStat {
  caption: string;
  value: string;
  x: number;
  valueY: number;
  captionY: number;
  color: number;
}

export interface CardMap {
  x: number;
  y: number;
  cell: number;
  gap: number;
  /** Total side of the mosaic, so the plate behind it can be sized off one number */
  size: number;
  /** Inner rows top to bottom: true where the floor was still lit */
  rows: boolean[][];
}

export interface ShareCardLayout {
  width: number;
  height: number;
  wordmark: CardText;
  mode: CardText;
  score: CardText;
  stats: CardStat[];
  /** Null when the mode has no territory, and so no map worth drawing */
  mapLabel: CardText | null;
  map: CardMap | null;
  url: CardText;
}

export interface ShareCardOptions {
  /** 'CLASSIC', 'BLITZ' or 'DAILY #9' — the scene already knows which */
  modeLabel: string;
  /** Where the card says the game lives, e.g. 'enclave-lovat.vercel.app' */
  host: string;
}

/** Every string and position on the card. Pure: no canvas, no DOM, no clock. */
export function layoutShareCard(summary: RunSummary, opts: ShareCardOptions): ShareCardLayout {
  const cx = CARD_WIDTH / 2;
  const territory = DIFFICULTY_CONFIGS[summary.difficulty].territory.enabled;
  const tier = getProgressStatus(summary.difficulty, summary.score).current;

  const stats: Omit<CardStat, 'x'>[] = [
    { caption: 'ROOMS', value: String(summary.roomsClaimed), valueY: STAT_VALUE_Y, captionY: STAT_CAPTION_Y, color: THEME.textPrimary },
    { caption: 'BIGGEST', value: summary.biggestRoom > 0 ? String(summary.biggestRoom) : '—', valueY: STAT_VALUE_Y, captionY: STAT_CAPTION_Y, color: THEME.gold },
    { caption: 'STREAK', value: `×${summary.maxStreak}`, valueY: STAT_VALUE_Y, captionY: STAT_CAPTION_Y, color: THEME.cyan },
    { caption: 'TIER', value: tier.label, valueY: STAT_VALUE_Y, captionY: STAT_CAPTION_Y, color: tier.color },
  ];
  if (territory) {
    stats.push({
      caption: 'SURVEYS',
      value: `×${summary.surveys}`,
      valueY: STAT_VALUE_Y,
      captionY: STAT_CAPTION_Y,
      color: summary.surveys > 0 ? THEME.gold : THEME.textMuted,
    });
  }

  // Columns share the width evenly, so four stats sit wider than five rather
  // than leaving a gap where the fifth would have been.
  const colW = (CARD_WIDTH - PAD * 2) / stats.length;
  const placed: CardStat[] = stats.map((s, i) => ({ ...s, x: PAD + colW * (i + 0.5) }));

  const mapSize = INNER_SIDE * MAP_CELL + (INNER_SIDE - 1) * MAP_GAP;

  return {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    wordmark: { text: 'ENCLAVE', x: cx, y: WORDMARK_Y, size: 68, color: THEME.textPrimary },
    mode: { text: opts.modeLabel, x: cx, y: MODE_Y, size: 28, color: THEME.textSecondary },
    score: { text: summary.score.toLocaleString(), x: cx, y: SCORE_Y, size: 180, color: THEME.textPrimary },
    stats: placed,
    mapLabel: territory ? { text: 'FINAL TERRITORY', x: cx, y: MAP_LABEL_Y, size: 24, color: THEME.textMuted } : null,
    map: territory
      ? { x: cx - mapSize / 2, y: MAP_TOP, cell: MAP_CELL, gap: MAP_GAP, size: mapSize, rows: innerRows(summary.litMap) }
      : null,
    url: { text: opts.host, x: cx, y: URL_Y, size: 26, color: THEME.textMuted },
  };
}

/** The 7×7 that can ever be floor, pulled out of the 9×9 lit map. */
function innerRows(litMap: boolean[][]): boolean[][] {
  const rows: boolean[][] = [];
  for (let r = 1; r <= INNER_SIDE; r++) {
    const row: boolean[] = [];
    for (let c = 1; c <= INNER_SIDE; c++) row.push(litMap[r]?.[c] === true);
    rows.push(row);
  }
  return rows;
}

/**
 * Render the card. Rejects rather than returning a half-drawn image, so the
 * caller can fall back to sharing text.
 */
export async function renderShareCard(summary: RunSummary, opts: ShareCardOptions): Promise<Blob> {
  const layout = layoutShareCard(summary, opts);
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('share card: no 2d context');
  paintShareCard(ctx, layout, await loadCardFonts());
  return toPngBlob(canvas);
}

interface CardFonts {
  display: string;
  mono: string;
}

const FALLBACK_FONTS: CardFonts = { display: 'sans-serif', mono: 'monospace' };

/**
 * The web fonts have to be resident before the first fillText or the canvas
 * silently substitutes and the card ships in the wrong typeface. Anything
 * that goes wrong here costs the card its font, never the share.
 */
async function loadCardFonts(): Promise<CardFonts> {
  try {
    const fonts = document.fonts;
    if (!fonts) return FALLBACK_FONTS;
    await Promise.all([
      fonts.load('800 96px Oxanium'),
      fonts.load('400 32px "Share Tech Mono"'),
    ]);
    return {
      display: fonts.check('800 96px Oxanium') ? FONT_DISPLAY : FALLBACK_FONTS.display,
      mono: fonts.check('400 32px "Share Tech Mono"') ? FONT_MONO : FALLBACK_FONTS.mono,
    };
  } catch {
    return FALLBACK_FONTS;
  }
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('share card: canvas produced no blob'));
    }, 'image/png');
  });
}

function css(color: number, alpha: number = 1): string {
  const hex = `#${(color >>> 0).toString(16).padStart(6, '0')}`;
  if (alpha >= 1) return hex;
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Centred text with tracking.
 *
 * `ctx.letterSpacing` is still missing in browsers the game supports, and the
 * wordmark reads wrong without it, so the advance is walked by hand.
 */
function fillTracked(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, tracking: number): void {
  if (tracking === 0) {
    ctx.fillText(text, cx, y);
    return;
  }
  const chars = [...text];
  const width = chars.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) + tracking * (chars.length - 1);
  let x = cx - width / 2;
  const previous = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const ch of chars) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + tracking;
  }
  ctx.textAlign = previous;
}

/** Paint a finished layout onto a context. No measurement, no decisions. */
function paintShareCard(ctx: CanvasRenderingContext2D, layout: ShareCardLayout, fonts: CardFonts): void {
  const { width, height } = layout;

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, css(THEME.bgDeep));
  bg.addColorStop(1, css(THEME.bg));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = `800 ${layout.wordmark.size}px ${fonts.display}`;
  ctx.fillStyle = css(layout.wordmark.color);
  fillTracked(ctx, layout.wordmark.text, layout.wordmark.x, layout.wordmark.y, 16);

  ctx.font = `600 ${layout.mode.size}px ${fonts.display}`;
  ctx.fillStyle = css(layout.mode.color);
  fillTracked(ctx, layout.mode.text, layout.mode.x, layout.mode.y, 8);

  // The score is the picture: everything else on the card is a caption to it
  ctx.font = `800 ${layout.score.size}px ${fonts.display}`;
  ctx.fillStyle = css(layout.score.color);
  ctx.shadowColor = css(THEME.accentGlow, 0.55);
  ctx.shadowBlur = 48;
  ctx.fillText(layout.score.text, layout.score.x, layout.score.y);
  ctx.shadowBlur = 0;

  // Hairlines above and below the stats, so the row reads as one band
  ctx.fillStyle = css(0xffffff, 0.1);
  ctx.fillRect(PAD, STAT_VALUE_Y - 52, width - PAD * 2, 2);
  ctx.fillRect(PAD, STAT_CAPTION_Y + 34, width - PAD * 2, 2);

  for (const stat of layout.stats) {
    ctx.font = `400 40px ${fonts.mono}`;
    ctx.fillStyle = css(stat.color);
    ctx.fillText(stat.value, stat.x, stat.valueY);
    ctx.font = `600 20px ${fonts.display}`;
    ctx.fillStyle = css(THEME.textMuted);
    fillTracked(ctx, stat.caption, stat.x, stat.captionY, 4);
  }

  if (layout.mapLabel) {
    ctx.font = `600 ${layout.mapLabel.size}px ${fonts.display}`;
    ctx.fillStyle = css(layout.mapLabel.color);
    fillTracked(ctx, layout.mapLabel.text, layout.mapLabel.x, layout.mapLabel.y, 6);
  }

  if (layout.map) paintMap(ctx, layout.map);

  ctx.font = `400 ${layout.url.size}px ${fonts.mono}`;
  ctx.fillStyle = css(layout.url.color);
  fillTracked(ctx, layout.url.text, layout.url.x, layout.url.y, 3);
}

function paintMap(ctx: CanvasRenderingContext2D, map: CardMap): void {
  const plate = 18;
  roundRect(ctx, map.x - plate, map.y - plate, map.size + plate * 2, map.size + plate * 2, 24);
  ctx.fillStyle = css(THEME.gridBg);
  ctx.fill();

  const step = map.cell + map.gap;
  for (let r = 0; r < map.rows.length; r++) {
    for (let c = 0; c < map.rows[r].length; c++) {
      const lit = map.rows[r][c];
      roundRect(ctx, map.x + c * step, map.y + r * step, map.cell, map.cell, 10);
      ctx.fillStyle = lit ? css(THEME.gold) : css(THEME.cellWell);
      ctx.fill();
      if (lit) {
        // A lit cell gets the same glossy top the blocks have in game
        roundRect(ctx, map.x + c * step + 4, map.y + r * step + 4, map.cell - 8, map.cell * 0.34, 8);
        ctx.fillStyle = css(THEME.goldGlow, 0.5);
        ctx.fill();
      }
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
