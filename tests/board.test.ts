import { describe, it, expect } from 'vitest';
import { board, keys, hasCell } from './helpers';

describe('enclosure detection', () => {
  it('finds a 2×2 room with an eight-block fence', () => {
    // A 4×4 ring around rows 3-4 / cols 3-4. The ring's own corners are
    // included so the test can prove they are NOT counted as fence.
    const b = board([
      '.........',
      '.........',
      '..####...',
      '..#..#...',
      '..#..#...',
      '..####...',
    ]);

    const regions = b.findEnclosures();
    expect(regions).toHaveLength(1);

    const room = regions[0];
    expect(room.area).toBe(4);
    expect(keys(room.cells)).toEqual(['3,3', '3,4', '4,3', '4,4']);
    expect(room.fence).toHaveLength(8);
    expect(keys(room.fence)).toEqual(
      ['2,3', '2,4', '3,2', '3,5', '4,2', '4,5', '5,3', '5,4'],
    );
  });

  it('excludes the diagonal corners from the fence', () => {
    const b = board([
      '.........',
      '.........',
      '..####...',
      '..#..#...',
      '..#..#...',
      '..####...',
    ]);

    const fence = b.findEnclosures()[0].fence;
    for (const [row, col] of [[2, 2], [2, 5], [5, 2], [5, 5]]) {
      expect(b.getCell(row, col)).not.toBeNull();      // it is a block…
      expect(hasCell(fence, row, col)).toBe(false);    // …but not a fence block
    }
  });

  it('never claims empty cells that touch the board edge', () => {
    // (0,0) is walled on both of its only two neighbours, yet it sits on the
    // edge, so by the one rule it is outside.
    const b = board([
      '.#.......',
      '##.......',
    ]);

    expect(b.getCell(0, 0)).toBeNull();
    expect(b.findEnclosures()).toEqual([]);
  });

  it('never claims a whole edge-hugging pocket', () => {
    // A 6-cell pocket in the top-left, sealed on every side but the board edge.
    const b = board([
      '...#.....',
      '...#.....',
      '####.....',
    ]);

    expect(b.findEnclosures()).toEqual([]);
  });
});

describe('findClosingCells', () => {
  it('returns exactly the one cell that completes a fence', () => {
    // A single-cell room at (4,4) walled on three sides; (4,5) is the gap.
    const b = board([
      '.........',
      '.........',
      '.........',
      '....#....',
      '...#.....',
      '....#....',
    ]);

    expect(b.findEnclosures()).toEqual([]);
    expect(keys(b.findClosingCells())).toEqual(['4,5']);
  });

  it('leaves the board untouched while probing', () => {
    const rows = [
      '.........',
      '.........',
      '.........',
      '....#....',
      '...#.....',
      '....#....',
    ];
    const b = board(rows);
    const before = JSON.stringify(b.grid);
    b.findClosingCells();
    expect(JSON.stringify(b.grid)).toBe(before);
  });

  it('finds nothing on an open board', () => {
    expect(board([]).findClosingCells()).toEqual([]);
  });
});

describe('shared walls', () => {
  it('lists a shared wall column in the fence of both rooms', () => {
    // Two 2×2 rooms either side of the wall at column 4.
    const b = board([
      '.........',
      '.........',
      '..##.##..',
      '.#..#..#.',
      '.#..#..#.',
      '..##.##..',
    ]);

    const regions = b.findEnclosures();
    expect(regions).toHaveLength(2);
    expect(regions.map(r => r.area)).toEqual([4, 4]);

    const [left, right] = regions;
    expect(keys(left.cells)).toEqual(['3,2', '3,3', '4,2', '4,3']);
    expect(keys(right.cells)).toEqual(['3,5', '3,6', '4,5', '4,6']);

    for (const [row, col] of [[3, 4], [4, 4]]) {
      expect(hasCell(left.fence, row, col)).toBe(true);
      expect(hasCell(right.fence, row, col)).toBe(true);
    }
  });
});
