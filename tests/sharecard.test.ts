import { describe, it, expect } from 'vitest';
import { CARD_HEIGHT, CARD_WIDTH, layoutShareCard } from '../src/core/ShareCard';
import { DIFFICULTY_CONFIGS } from '../src/core/Config';
import { getProgressStatus } from '../src/core/Progression';
import { Board } from '../src/core/Board';
import { RunSummary } from '../src/core/types';

/**
 * The share card's arithmetic, with no canvas in sight.
 *
 * `layoutShareCard` decides every string and every position and `renderShareCard`
 * only paints them, so everything worth getting wrong is testable here. What
 * the pixels actually look like is not, and is checked in a browser.
 */

const OPTS = { modeLabel: 'CLASSIC', host: 'enclave-lovat.vercel.app' };

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    score: 12345,
    difficulty: 'classic',
    seed: 1,
    endCause: 'timeout',
    totalTurns: 20,
    claims: 6,
    cellsClaimed: 24,
    roomsClaimed: 7,
    biggestRoom: 9,
    roomSizes: { 1: 2, 4: 4, 9: 1 },
    doubleCloses: 1,
    maxStreak: 3,
    holds: 2,
    surveys: 1,
    litCells: 12,
    litMap: Board.createUnlitMap(),
    closingAtEnd: 0,
    piecesLeft: 0,
    gameElapsed: 74,
    scoreTimeline: [],
    previousBest: 9000,
    isNewBest: true,
    ...over,
  };
}

describe('the card', () => {
  it('is 1080×1350 and says what it is', () => {
    const card = layoutShareCard(summary(), OPTS);
    expect([card.width, card.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect([CARD_WIDTH, CARD_HEIGHT]).toEqual([1080, 1350]);
    expect(card.wordmark.text).toBe('ENCLAVE');
    expect(card.mode.text).toBe('CLASSIC');
    expect(card.url.text).toBe('enclave-lovat.vercel.app');
  });

  it('takes the mode label it is handed, daily number and all', () => {
    const card = layoutShareCard(summary({ difficulty: 'daily', dailyKey: '2026-09-09' }), {
      ...OPTS, modeLabel: 'DAILY #9',
    });
    expect(card.mode.text).toBe('DAILY #9');
  });

  it('prints the score grouped, and large', () => {
    const card = layoutShareCard(summary({ score: 12345 }), OPTS);
    expect(card.score.text).toBe((12345).toLocaleString());
    expect(card.score.size).toBeGreaterThan(card.mode.size * 4);
  });

  it('stacks nothing on top of anything else, top to bottom', () => {
    const card = layoutShareCard(summary(), OPTS);
    const stats = card.stats[0];
    const ys = [
      card.wordmark.y, card.mode.y, card.score.y,
      stats.valueY, stats.captionY, card.mapLabel!.y, card.map!.y, card.url.y,
    ];
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(card.map!.y + card.map!.size).toBeLessThan(card.url.y);
    expect(card.url.y).toBeLessThan(CARD_HEIGHT);
  });
});

describe('the stats row', () => {
  it('reads the run, tier included', () => {
    const s = summary({ roomsClaimed: 7, biggestRoom: 9, maxStreak: 3, surveys: 2 });
    const card = layoutShareCard(s, OPTS);
    expect(card.stats.map(x => x.caption)).toEqual(['ROOMS', 'BIGGEST', 'STREAK', 'TIER', 'SURVEYS']);
    expect(card.stats.map(x => x.value)).toEqual([
      '7', '9', '×3', getProgressStatus('classic', s.score).current.label, '×2',
    ]);
  });

  it('dashes a run that never claimed a room', () => {
    const card = layoutShareCard(summary({ biggestRoom: 0, roomsClaimed: 0 }), OPTS);
    expect(card.stats[1].value).toBe('—');
  });

  it('spaces the columns evenly, inside the margins', () => {
    const card = layoutShareCard(summary(), OPTS);
    const xs = card.stats.map(s => s.x);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 6);
    expect(xs[0]).toBeGreaterThan(0);
    expect(xs[xs.length - 1]).toBeLessThan(CARD_WIDTH);
    // The row is centred on the card
    expect((xs[0] + xs[xs.length - 1]) / 2).toBeCloseTo(CARD_WIDTH / 2, 6);
  });

  it('drops SURVEYS and the map when the mode has no territory', () => {
    const territory = DIFFICULTY_CONFIGS.classic.territory;
    const was = territory.enabled;
    try {
      territory.enabled = false;
      const card = layoutShareCard(summary(), OPTS);
      expect(card.stats.map(s => s.caption)).toEqual(['ROOMS', 'BIGGEST', 'STREAK', 'TIER']);
      expect(card.map).toBeNull();
      expect(card.mapLabel).toBeNull();
    } finally {
      territory.enabled = was;
    }
  });
});

describe('the territory mosaic', () => {
  it('is the inner 7×7 and nothing else', () => {
    const litMap = Board.createUnlitMap();
    litMap[0][0] = true;            // outer ring: never floor, never drawn
    litMap[8][8] = true;
    litMap[1][1] = true;            // first inner cell
    litMap[7][7] = true;            // last inner cell
    litMap[4][2] = true;

    const map = layoutShareCard(summary({ litMap }), OPTS).map!;
    expect(map.rows).toHaveLength(7);
    for (const row of map.rows) expect(row).toHaveLength(7);
    expect(map.rows[0][0]).toBe(true);
    expect(map.rows[6][6]).toBe(true);
    expect(map.rows[3][1]).toBe(true);
    expect(map.rows.flat().filter(Boolean)).toHaveLength(3);
  });

  it('is square, centred, and sized off its own cell and gap', () => {
    const map = layoutShareCard(summary(), OPTS).map!;
    expect(map.size).toBe(7 * map.cell + 6 * map.gap);
    expect(map.x + map.size / 2).toBeCloseTo(CARD_WIDTH / 2, 6);
    expect(map.x).toBeGreaterThan(0);
  });

  it('goes dark after the survey that reset it', () => {
    const map = layoutShareCard(summary({ surveys: 1, litCells: 0 }), OPTS).map!;
    expect(map.rows.flat().some(Boolean)).toBe(false);
  });
});
