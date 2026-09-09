import { Container, FederatedPointerEvent, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import { FONT_DISPLAY, FONT_MONO, THEME, drawButton, drawPanel } from './Theme';

/**
 * Small reusable UI widgets built from PixiJS primitives so every scene
 * shares the same look: buttons, toggle pills, sliders, stat chips, section
 * labels.
 */

export interface ButtonOptions {
  width?: number;
  height?: number;
  color?: number;
  textColor?: number;
  fontSize?: number;
  letterSpacing?: number;
  glow?: boolean;
}

/** Centered pill button. Fires on pointer *up* so drags/scrolls don't trigger it. */
export function createButton(
  label: string,
  cx: number,
  cy: number,
  onClick: () => void,
  opts: ButtonOptions = {},
): Container {
  const w = opts.width ?? 200;
  const h = opts.height ?? 52;
  const color = opts.color ?? THEME.btnPrimary;
  const root = new Container();

  const bg = new Graphics();
  drawButton(bg, cx - w / 2, cy - h / 2, w, h, color, Math.min(14, h / 2), opts.glow ?? true);
  root.addChild(bg);

  const text = new Text({
    text: label,
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: opts.fontSize ?? 18,
      fontWeight: '700',
      fill: opts.textColor ?? THEME.textPrimary,
      letterSpacing: opts.letterSpacing ?? 4,
    }),
  });
  text.anchor.set(0.5);
  text.x = cx;
  text.y = cy - 1;
  root.addChild(text);

  root.eventMode = 'static';
  root.cursor = 'pointer';
  let pressed = false;
  root.on('pointerdown', (e) => {
    e.stopPropagation();
    pressed = true;
    root.scale.set(0.97);
    root.pivot.set(0, 0);
    root.position.set(cx * 0.03, cy * 0.03);
  });
  const release = () => {
    root.scale.set(1);
    root.position.set(0, 0);
  };
  root.on('pointerup', (e) => {
    e.stopPropagation();
    release();
    if (pressed) {
      pressed = false;
      onClick();
    }
  });
  root.on('pointerupoutside', () => { pressed = false; release(); });
  root.on('pointercancel', () => { pressed = false; release(); });
  return root;
}

/** Small on/off pill: "SOUND ON" / "SOUND OFF" */
export function createToggle(
  label: string,
  cx: number,
  cy: number,
  initial: boolean,
  onChange: (value: boolean) => boolean,
  width: number = 118,
): Container {
  const root = new Container();
  const h = 32;
  const bg = new Graphics();
  const text = new Text({
    text: '',
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: 10,
      fontWeight: '700',
      fill: THEME.textPrimary,
      letterSpacing: 1.5,
    }),
  });
  text.anchor.set(0.5);
  text.x = cx;
  text.y = cy;

  let value = initial;
  const render = () => {
    bg.clear();
    const x = cx - width / 2;
    const y = cy - h / 2;
    bg.roundRect(x, y, width, h, h / 2);
    bg.fill({ color: value ? THEME.accent : 0x000000, alpha: value ? 0.85 : 0.35 });
    bg.roundRect(x, y, width, h, h / 2);
    bg.stroke({ color: value ? THEME.accentGlow : THEME.textMuted, alpha: value ? 0.8 : 0.5, width: 1 });
    // Indicator dot
    bg.circle(x + 12, cy, 3.5);
    bg.fill({ color: value ? THEME.cyan : THEME.textMuted, alpha: 1 });
    text.text = `${label} ${value ? 'ON' : 'OFF'}`;
    text.style.fill = value ? THEME.textPrimary : THEME.textSecondary;
    text.x = cx + 7;
  };
  render();

  root.addChild(bg);
  root.addChild(text);
  root.eventMode = 'static';
  root.cursor = 'pointer';
  root.on('pointerdown', (e) => e.stopPropagation());
  root.on('pointerup', (e) => {
    e.stopPropagation();
    value = onChange(!value);
    render();
  });
  return root;
}

/**
 * The same pill as createToggle, but cycling through named values instead of
 * on/off: "MOTION: SYSTEM" → "MOTION: REDUCED" → "MOTION: FULL". Index 0 is
 * the default and reads muted, so a highlighted pill means "you changed this".
 */
export function createCycleToggle(
  label: string,
  cx: number,
  cy: number,
  values: string[],
  initialIndex: number,
  onChange: (index: number) => void,
  width: number = 180,
): Container {
  const root = new Container();
  const h = 32;
  const bg = new Graphics();
  const text = new Text({
    text: '',
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: 10,
      fontWeight: '700',
      fill: THEME.textPrimary,
      letterSpacing: 1.5,
    }),
  });
  text.anchor.set(0.5);
  text.x = cx;
  text.y = cy;

  let index = Math.max(0, Math.min(values.length - 1, initialIndex));
  const render = () => {
    const changed = index > 0;
    bg.clear();
    const x = cx - width / 2;
    const y = cy - h / 2;
    bg.roundRect(x, y, width, h, h / 2);
    bg.fill({ color: changed ? THEME.accent : 0x000000, alpha: changed ? 0.85 : 0.35 });
    bg.roundRect(x, y, width, h, h / 2);
    bg.stroke({ color: changed ? THEME.accentGlow : THEME.textMuted, alpha: changed ? 0.8 : 0.5, width: 1 });
    // Indicator dot
    bg.circle(x + 12, cy, 3.5);
    bg.fill({ color: changed ? THEME.cyan : THEME.textMuted, alpha: 1 });
    text.text = `${label}: ${values[index]}`;
    text.style.fill = changed ? THEME.textPrimary : THEME.textSecondary;
    text.x = cx + 7;
  };
  render();

  root.addChild(bg);
  root.addChild(text);
  root.eventMode = 'static';
  root.cursor = 'pointer';
  root.on('pointerdown', (e) => e.stopPropagation());
  root.on('pointerup', (e) => {
    e.stopPropagation();
    index = (index + 1) % values.length;
    render();
    onChange(index);
  });
  return root;
}

export interface SliderOptions {
  /** Centre of the row */
  cx?: number;
  cy?: number;
  width?: number;
  /** Hit height. Floored at 36: a 6 px track is not a thumb target. */
  height?: number;
  color?: number;
}

/**
 * Horizontal 0–1 slider: label on the left, percentage on the right, a track
 * with a knob underneath.
 *
 * The whole row is the hit area rather than the knob, because on a phone the
 * knob is smaller than the finger: a tap anywhere jumps the value there and a
 * drag follows. `onChange` fires on every whole percent, which is fine enough
 * to hear and coarse enough not to flood the thing being controlled.
 */
export function createSlider(
  label: string,
  value: number,
  onChange: (value: number) => void,
  opts: SliderOptions = {},
): Container {
  const cx = opts.cx ?? 0;
  const cy = opts.cy ?? 0;
  const w = opts.width ?? 240;
  const h = Math.max(36, opts.height ?? 40);
  const color = opts.color ?? THEME.accent;
  const knobR = 8;
  const left = cx - w / 2;
  const x0 = left + knobR;
  const x1 = cx + w / 2 - knobR;
  const trackY = cy + 7;

  const root = new Container();
  const gfx = new Graphics();
  root.addChild(gfx);

  const name = new Text({
    text: label,
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: 10,
      fontWeight: '700',
      fill: THEME.textSecondary,
      letterSpacing: 1.5,
    }),
  });
  name.anchor.set(0, 0.5);
  name.x = left;
  name.y = cy - 9;
  root.addChild(name);

  const readout = new Text({
    text: '',
    style: new TextStyle({ fontFamily: FONT_MONO, fontSize: 11, fill: THEME.textPrimary }),
  });
  readout.anchor.set(1, 0.5);
  readout.x = cx + w / 2;
  readout.y = cy - 9;
  root.addChild(readout);

  let current = Math.max(0, Math.min(1, value));
  const render = (): void => {
    const kx = x0 + current * (x1 - x0);
    gfx.clear();
    gfx.roundRect(left, trackY - 3, w, 6, 3);
    gfx.fill({ color: 0x000000, alpha: 0.45 });
    gfx.roundRect(left, trackY - 3, Math.max(6, kx - left), 6, 3);
    gfx.fill({ color, alpha: 0.9 });
    gfx.circle(kx, trackY, knobR);
    gfx.fill({ color: THEME.textPrimary });
    gfx.circle(kx, trackY, knobR);
    gfx.stroke({ color, alpha: 0.9, width: 2 });
    readout.text = `${Math.round(current * 100)}%`;
  };
  render();

  const setFromX = (localX: number): void => {
    const raw = (localX - x0) / (x1 - x0);
    const next = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
    if (next === current) return;
    current = next;
    render();
    onChange(current);
  };

  let dragging = false;
  const move = (e: FederatedPointerEvent): void => setFromX(root.toLocal(e.global).x);
  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    root.off('globalpointermove', move);
  };

  root.eventMode = 'static';
  root.cursor = 'pointer';
  // Explicit, because the graphics are a 6 px track and two lines of small text
  root.hitArea = new Rectangle(left - knobR, cy - h / 2, w + knobR * 2, h);
  root.on('pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    // Tracked globally so the value keeps following a finger that has slid off
    root.on('globalpointermove', move);
    setFromX(root.toLocal(e.global).x);
  });
  root.on('pointerup', (e) => { e.stopPropagation(); end(); });
  root.on('pointerupoutside', end);
  root.on('pointercancel', end);
  return root;
}

/**
 * Text-only button on a faint plate: for links and side doors that would
 * shout as a pill. The plate is what gets tapped, because an 11 px label is
 * well under a thumb.
 */
export function createTextButton(
  label: string,
  cx: number,
  cy: number,
  onClick: () => void,
  opts: { fontSize?: number; color?: number; letterSpacing?: number; height?: number } = {},
): Container {
  const root = new Container();
  const text = new Text({
    text: label,
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: opts.fontSize ?? 11,
      fontWeight: '700',
      fill: opts.color ?? THEME.cyan,
      letterSpacing: opts.letterSpacing ?? 2,
    }),
  });
  text.anchor.set(0.5);
  text.x = cx;
  text.y = cy;

  const h = opts.height ?? 30;
  const w = text.width + 28;
  const bg = new Graphics();
  bg.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  bg.fill({ color: 0x000000, alpha: 0.25 });
  bg.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
  bg.stroke({ color: 0xffffff, alpha: 0.12, width: 1 });

  root.addChild(bg);
  root.addChild(text);
  root.eventMode = 'static';
  root.cursor = 'pointer';
  root.on('pointerdown', (e) => e.stopPropagation());
  root.on('pointerup', (e) => { e.stopPropagation(); onClick(); });
  return root;
}

/** Labelled statistic chip: big value, small caption underneath */
export function createStatChip(
  caption: string,
  value: string,
  cx: number,
  cy: number,
  width: number = 88,
  color: number = THEME.textPrimary,
): Container {
  const root = new Container();
  const h = 46;
  const bg = new Graphics();
  drawPanel(bg, cx - width / 2, cy - h / 2, width, h, 10, 0.5);
  root.addChild(bg);

  const v = new Text({
    text: value,
    style: new TextStyle({
      fontFamily: FONT_MONO,
      fontSize: 17,
      fill: color,
      letterSpacing: 1,
    }),
  });
  v.anchor.set(0.5);
  v.x = cx;
  v.y = cy - 7;
  root.addChild(v);

  const c = new Text({
    text: caption,
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: 9,
      fontWeight: '600',
      fill: THEME.textMuted,
      letterSpacing: 2,
    }),
  });
  c.anchor.set(0.5);
  c.x = cx;
  c.y = cy + 12;
  root.addChild(c);
  return root;
}

/** Small uppercase section heading with a thin rule underneath */
export function createSectionLabel(label: string, cx: number, y: number, ruleWidth: number = 160): Container {
  const root = new Container();
  const text = new Text({
    text: label,
    style: new TextStyle({
      fontFamily: FONT_DISPLAY,
      fontSize: 12,
      fontWeight: '600',
      fill: THEME.textSecondary,
      letterSpacing: 4,
    }),
  });
  text.anchor.set(0.5, 0);
  text.x = cx;
  text.y = y;
  root.addChild(text);

  const rule = new Graphics();
  rule.rect(cx - ruleWidth / 2, y + 22, ruleWidth, 1);
  rule.fill({ color: 0xffffff, alpha: 0.12 });
  root.addChild(rule);
  return root;
}

/** Body text helper with consistent styling */
export function createBodyText(
  text: string,
  cx: number,
  y: number,
  opts: { fontSize?: number; color?: number; wrapWidth?: number; align?: 'left' | 'center'; mono?: boolean } = {},
): Text {
  const t = new Text({
    text,
    style: new TextStyle({
      fontFamily: opts.mono ? FONT_MONO : FONT_DISPLAY,
      fontSize: opts.fontSize ?? 13,
      fontWeight: '500',
      fill: opts.color ?? THEME.textSecondary,
      letterSpacing: 1,
      align: opts.align ?? 'center',
      wordWrap: true,
      wordWrapWidth: opts.wrapWidth ?? 300,
      lineHeight: (opts.fontSize ?? 13) * 1.5,
    }),
  });
  t.anchor.set(opts.align === 'left' ? 0 : 0.5, 0);
  t.x = cx;
  t.y = y;
  return t;
}
