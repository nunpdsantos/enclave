import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { FONT_DISPLAY, FONT_MONO, THEME, drawButton, drawPanel } from './Theme';

/**
 * Small reusable UI widgets built from PixiJS primitives so every scene
 * shares the same look: buttons, toggle pills, stat chips, section labels.
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
