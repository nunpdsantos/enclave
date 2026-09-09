import { describe, it, expect, afterEach } from 'vitest';
import { Difficulty } from '../src/core/Config';
import { Leaderboard, RunStarter, RunTicket } from '../src/core/Leaderboard';
import { signTicket, TICKET_VERSION } from '../src/core/Ticket';
import { emptyReplay } from './helpers';

/**
 * The client half of the leaderboard: the board it reads and the run it
 * starts. Both of them are races, and both of them shipped.
 *
 * Nothing here touches the network or the DOM. `fetch` is replaced with a
 * function the test resolves by hand, because the bug in each case is *when*
 * an answer arrives rather than what it says — and a test that cannot hold a
 * response open cannot see either of them.
 */

// ── A fetch a test can hold open ──

interface Pending {
  url: string;
  /** 'GET' for a board read, 'POST' for a submission */
  method: string;
  /** Answered already, so `only` stops offering it */
  settled: boolean;
  /** Answer this request with a board, or with whatever body a test wants */
  resolve: (body: unknown) => void;
  /** Answer it with a failure, as an offline device would */
  reject: () => void;
}

const realFetch = globalThis.fetch;
let pending: Pending[] = [];

function deferredFetch(): void {
  pending = [];
  globalThis.fetch = ((
    input: RequestInfo | URL, init?: RequestInit,
  ) => new Promise((resolve, reject) => {
    const request: Pending = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      settled: false,
      resolve: (body) => {
        request.settled = true;
        resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      },
      reject: () => {
        request.settled = true;
        reject(new Error('offline'));
      },
    };
    pending.push(request);
  })) as typeof fetch;
}

/**
 * The one unanswered request of that kind, and there must be exactly one —
 * a test that picks the wrong request of two proves nothing about either.
 */
function only(method: string, url?: string): Pending {
  const matches = pending.filter(
    p => !p.settled && p.method === method && (!url || p.url.includes(url)),
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Let every microtask the resolved promises queued actually run. */
function settle(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

afterEach(() => {
  globalThis.fetch = realFetch;
  pending = [];
});

function row(name: string, score: number): unknown {
  return { name, score, date: '2026-09-09' };
}

describe('finding 7 — a board read answers for the board it asked about', () => {
  it('drops a response that arrives after the player has changed boards', async () => {
    deferredFetch();
    const board = new Leaderboard('classic');
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toContain('difficulty=classic');

    // Switch while Classic's read is still in the air
    const switched = board.switchDifficulty('daily', '2026-09-09');
    await settle();
    expect(pending).toHaveLength(2);
    expect(pending[1].url).toContain('difficulty=daily-2026-09-09');

    // The Daily answers first, then Classic's read finally lands. It used to
    // be applied to whatever board was current when it arrived — Classic's
    // ten drawn under the Daily's heading, and written into the Daily's
    // local cache, where they stayed.
    pending[1].resolve([row('Daily player', 500)]);
    await settle();
    pending[0].resolve([row('Classic player', 9000)]);
    await switched;
    await settle();

    expect(board.getBoardId()).toBe('daily-2026-09-09');
    expect(board.getEntries().map(e => e.name)).toEqual(['Daily player']);
  });

  it('keeps the newest answer when the player switches away and back', async () => {
    deferredFetch();
    const board = new Leaderboard('daily', '2026-09-09');
    void board.switchDifficulty('classic');
    const back = board.switchDifficulty('daily', '2026-09-09');
    await settle();
    expect(pending).toHaveLength(3);

    // Three reads in the air, two of them for the board that is now loaded.
    // The board id alone cannot separate those two, so the older of them
    // would land last and overwrite the newer.
    pending[2].resolve([row('Fresh', 200)]);
    await settle();
    pending[0].resolve([row('Stale', 100)]);
    pending[1].resolve([row('Classic', 9000)]);
    await back;
    await settle();

    expect(board.getEntries().map(e => e.name)).toEqual(['Fresh']);
  });

  it('leaves the board alone when the read fails', async () => {
    deferredFetch();
    const board = new Leaderboard('classic');
    pending[0].reject();
    await board.waitForRemote();
    expect(board.getEntries()).toEqual([]);
  });
});

describe('finding 3 — one Play is one run', () => {
  /** A ticket the server would have signed, so its payload reads as one. */
  async function ticket(mode: Difficulty, seed: number = 7): Promise<RunTicket> {
    const token = await signTicket('secret', {
      v: TICKET_VERSION, id: 'p1', mode, seed, issuedAt: Date.now(),
    });
    return { seed, token, mode };
  }

  it('ignores a second Play while the first is still waiting for its ticket', async () => {
    let asked = 0;
    let release: (() => void) | null = null;
    const held = new Promise<void>(r => { release = r; });
    const starter = new RunStarter(async (mode) => {
      asked++;
      await held;
      return ticket(mode);
    });

    const first = starter.start('daily');
    await settle();
    expect(starter.inFlight).toBe(true);

    // The double-tap. It used to start a second run that replaced the first —
    // and on the old server the second ticket was a practice one, so a
    // double-tap on the Daily turned a real attempt into a practice run.
    expect(await starter.start('daily')).toBeNull();
    expect(asked).toBe(1);

    release!();
    const started = await first;
    expect(started?.mode).toBe('daily');
    expect(started?.ticket).not.toBeNull();
    expect(starter.inFlight).toBe(false);

    // And once it is done, Play works again
    expect(await starter.start('daily')).not.toBeNull();
    expect(asked).toBe(2);
  });

  it('builds the run from the mode Play was pressed on, not the menu\'s latest', async () => {
    let selected: Difficulty = 'daily';
    const starter = new RunStarter(async (mode) => {
      // The player switches the menu to Blitz while the ticket is in the air
      selected = 'blitz';
      return ticket(mode);
    });

    const started = await starter.start('daily');
    // The mode used to be read again after the await, which paired a Blitz
    // game with the Daily's ticket and played it to the end to be refused.
    expect(selected).toBe('blitz');
    expect(started?.mode).toBe('daily');
    expect(started?.ticket?.mode).toBe('daily');
  });

  it('drops a ticket that came back for another mode', async () => {
    const starter = new RunStarter(async () => ticket('classic'));
    const started = await starter.start('blitz');

    // Nothing legitimate produces this, which is the point: a ticket that
    // does not say what this run is cannot vouch for it, and posting it would
    // spend it to be told `token`. The run plays unticketed and says so.
    expect(started).toEqual({ mode: 'blitz', ticket: null });
  });

  it('starts an unticketed run when the ticket cannot be had', async () => {
    const starter = new RunStarter(async () => null);
    expect(await starter.start('classic')).toEqual({ mode: 'classic', ticket: null });
  });

  it('frees the guard when the ticket request throws', async () => {
    const starter = new RunStarter(async () => { throw new Error('offline'); });
    await expect(starter.start('classic')).rejects.toThrow('offline');
    // A guard that a thrown request left stuck would take Play away for good
    expect(starter.inFlight).toBe(false);
  });

  it('passes the practice request through', async () => {
    const asked: boolean[] = [];
    const starter = new RunStarter(async (mode, practice) => {
      asked.push(practice);
      return ticket(mode);
    });
    await starter.start('daily', true);
    await starter.start('daily', false);
    expect(asked).toEqual([true, false]);
  });
});

describe('review 4, finding 1 — a score goes to the board its run was played in', () => {
  /** A ticket the server would have signed, so its payload reads as one. */
  async function ticketFor(mode: Difficulty, seed: number = 7): Promise<RunTicket> {
    const token = await signTicket('secret', {
      v: TICKET_VERSION, id: 'p1', mode, seed, issuedAt: Date.now(),
    });
    return { seed, token, mode };
  }

  it('posts a Classic run to Classic after the menu was switched to Blitz', async () => {
    deferredFetch();
    // The menu is on Classic. Play is pressed: the run's mode is captured
    // here and nothing after this can change it.
    const board = new Leaderboard('classic');
    only('GET', 'difficulty=classic').resolve([]);
    await board.waitForRemote();
    let release: (() => void) | null = null;
    const held = new Promise<void>(r => { release = r; });
    const starter = new RunStarter(async (mode) => {
      await held;
      return ticketFor(mode);
    });
    const starting = starter.start('classic');
    await settle();

    // The player switches the menu to Blitz while the ticket is still in the
    // air, which is all `MenuScene`'s callback does.
    const switched = board.switchDifficulty('blitz');
    await settle();
    only('GET', 'difficulty=blitz').resolve([row('Blitz player', 4000)]);
    await switched;
    expect(board.getBoardId()).toBe('blitz');

    release!();
    const started = await starting;
    // The run kept the mode Play was pressed on; the shared client followed
    // the menu. This is the state the game-over screen inherits.
    expect(started?.mode).toBe('classic');
    expect(board.getBoardId()).toBe('blitz');

    // The run ends and the player enters a name. Nothing here re-states the
    // mode: the replay is the run's own account of what was played, and the
    // submission goes where it says.
    const posted = board.submit(1200, 'Ann', emptyReplay('classic'), started!.ticket!.token);
    await settle();
    only('GET', 'difficulty=classic').resolve([row('Classic player', 9000)]);
    await settle();

    // The POST used to carry this Classic replay to `?difficulty=blitz`,
    // where the server refuses it as `shape`: a run played and proved, lost
    // to a menu tap. The board on screen follows it back to Classic.
    const post = only('POST');
    expect(post.url).toContain('difficulty=classic');
    expect(board.getBoardId()).toBe('classic');
    post.resolve({ rank: 1, entries: [row('Ann', 1200)] });
    expect(await posted).toEqual({ rank: 1, verified: true });
    expect(board.getEntries().map(e => e.name)).toEqual(['Ann']);
  });

  // review 5, finding 4 — the same routing, one await further on: the board
  // was derived from the replay and then read back off the client after the
  // corrective read, which is mutable state anything else can change.
  it('posts to the replay\'s board when the client is switched mid-submission', async () => {
    deferredFetch();
    // The client is on Blitz — the menu was left there — and the run being
    // posted was played in Classic.
    const board = new Leaderboard('blitz');
    only('GET', 'difficulty=blitz').resolve([]);
    await board.waitForRemote();

    const posted = board.submit(1200, 'Ann', emptyReplay('classic'), 'signed-token');
    await settle();
    // Pointing the client at Classic is itself a read, and the menu is still
    // on screen behind the name entry taking taps while it is in the air.
    const corrective = only('GET', 'difficulty=classic');

    const switched = board.switchDifficulty('daily', '2026-09-09');
    await settle();
    only('GET', 'difficulty=daily-2026-09-09').resolve([row('Daily player', 500)]);
    await switched;
    corrective.resolve([]);
    await settle();

    // The board on screen followed the menu; the POST followed the replay.
    // It used to read the board back off the client after the await, which
    // sent a Classic replay to `?difficulty=daily-2026-09-09` to be refused
    // as `shape` — a run played and proved, lost to a tap.
    expect(board.getBoardId()).toBe('daily-2026-09-09');
    const post = only('POST');
    expect(post.url).toContain('difficulty=classic');

    post.resolve({ rank: 1, entries: [row('Ann', 1200)] });
    expect(await posted).toEqual({ rank: 1, verified: true });
    // And Classic's answer is kept for Classic rather than drawn over the
    // board the player is now looking at.
    expect(board.getEntries().map(e => e.name)).toEqual(['Daily player']);
  });

  it('keeps a daily on the day it was dealt from', async () => {
    deferredFetch();
    const board = new Leaderboard('classic');
    only('GET', 'difficulty=classic').resolve([]);
    await board.waitForRemote();

    // A run that crossed UTC midnight: the replay carries the date it was
    // dealt from, and that is the board it belongs to whatever day it is now.
    const replay = { ...emptyReplay('daily'), dailyKey: '2026-09-08' };
    const posted = board.submit(700, 'Ann', replay, 'signed-token');
    await settle();
    only('GET', 'difficulty=daily-2026-09-08').resolve([]);
    await settle();

    const post = only('POST');
    expect(post.url).toContain('difficulty=daily-2026-09-08');
    post.resolve({ rank: 1, entries: [row('Ann', 700)] });
    await posted;
  });
});
