import { describe, it, expect, afterEach } from 'vitest';
import { Difficulty } from '../src/core/Config';
import { Leaderboard, RunStarter, RunTicket } from '../src/core/Leaderboard';
import { signTicket, TICKET_VERSION } from '../src/core/Ticket';

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
  /** Answer this request with a board */
  resolve: (entries: unknown) => void;
  /** Answer it with a failure, as an offline device would */
  reject: () => void;
}

const realFetch = globalThis.fetch;
let pending: Pending[] = [];

function deferredFetch(): void {
  pending = [];
  globalThis.fetch = ((input: RequestInfo | URL) => new Promise((resolve, reject) => {
    pending.push({
      url: String(input),
      resolve: (entries) => resolve(new Response(JSON.stringify(entries), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })),
      reject: () => reject(new Error('offline')),
    });
  })) as typeof fetch;
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
