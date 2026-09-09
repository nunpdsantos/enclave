import { Application } from 'pixi.js';
import { LayoutManager } from './rendering/LayoutManager';
import { SceneManager } from './scenes/SceneManager';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { GameOverScene } from './scenes/GameOverScene';
import { AudioManager } from './audio/AudioManager';
import { Leaderboard, requestRunTicket } from './core/Leaderboard';
import { Difficulty, DIFFICULTY_CONFIGS, GameConfig, siegeConfig } from './core/Config';
import { isMissionId } from './core/Missions';
import { incrementGamesPlayed, loadSettings } from './core/Settings';
import { RunSummary } from './core/types';
import { THEME } from './rendering/Theme';

const LAST_DIFFICULTY_KEY = 'enclave_last_difficulty';

function readLastDifficulty(): Difficulty {
  try {
    const raw = localStorage.getItem(LAST_DIFFICULTY_KEY);
    if (raw === 'classic' || raw === 'blitz' || raw === 'daily' || raw === 'siege') return raw;
  } catch { /* */ }
  return 'classic';
}

/**
 * The siege the picker last left selected.
 *
 * Read here rather than held in the menu because the run is started from
 * here, and a config assembled from anything but the persisted choice would
 * be a run that does not match the screen the player pressed PLAY on.
 */
function currentSiegeConfig(): GameConfig {
  const s = loadSettings();
  return siegeConfig(
    isMissionId(s.siegeMission) ? s.siegeMission : 'm1',
    s.siegeEnemy,
    s.siegeGoal,
  );
}

function saveLastDifficulty(d: Difficulty): void {
  try { localStorage.setItem(LAST_DIFFICULTY_KEY, d); } catch { /* */ }
}

async function boot() {
  const container = document.getElementById('game-container')!;

  const app = new Application();
  await app.init({
    background: THEME.bg,
    resizeTo: window,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });

  container.appendChild(app.canvas);
  app.canvas.style.touchAction = 'none';

  const layoutManager = new LayoutManager();
  const audioManager = new AudioManager();
  const sceneManager = new SceneManager(app.stage);

  // Browsers require a user gesture before audio can start. Unlock on the
  // very first interaction so the first sound effect isn't swallowed.
  const unlockAudio = () => {
    audioManager.unlock();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  let selectedDifficulty: Difficulty = readLastDifficulty();
  // The siege has no board, so a run of it must not send the menu asking for
  // one the server would refuse
  const leaderboard = new Leaderboard(
    selectedDifficulty === 'siege' ? 'classic' : selectedDifficulty,
  );

  function showMenu() {
    const layout = layoutManager.recalculate(window.innerWidth, window.innerHeight);
    app.renderer.background.color = THEME.bg;
    const menu = new MenuScene(
      layout.width, layout.height,
      leaderboard,
      audioManager,
      selectedDifficulty,
      (difficulty) => {
        selectedDifficulty = difficulty;
        saveLastDifficulty(difficulty);
        // The siege has no shared board in this prototype, so there is nothing
        // to fetch and nothing the server would recognise if we asked.
        if (difficulty === 'siege') return;
        leaderboard.switchDifficulty(difficulty).then(() => {
          if (sceneManager.current === menu) menu.refreshLeaderboard();
        });
      },
      () => { void startGame(false); },
    );
    sceneManager.switchTo(menu);
    // Remote scores may arrive after the menu is drawn
    leaderboard.waitForRemote().then(() => {
      if (sceneManager.current === menu) menu.refreshLeaderboard();
    });
  }

  /** Set the app background color (for color temperature shifting) */
  function setBgColor(color: number): void {
    app.renderer.background.color = color;
  }

  /**
   * The ticket the current run was started with, or null when it could not
   * be had. It travels no further than the game-over screen, which is the
   * only place it is used: posting the score.
   */
  let runToken: string | null = null;

  async function startGame(skipCountdown: boolean = false) {
    // Recompute the layout on the way in: handedness may have been changed
    // in the menu since it was last measured.
    layoutManager.recalculate(window.innerWidth, window.innerHeight);

    // The deal is the server's to choose, so the ticket has to be in hand
    // before the first piece is dealt. Without one the run still plays — on
    // a local seed, as practice — and the game-over screen says the score
    // stayed here rather than pretending it went out.
    const ticket = await requestRunTicket(selectedDifficulty);
    runToken = ticket?.token ?? null;
    const base = DIFFICULTY_CONFIGS[selectedDifficulty];
    const config: GameConfig = ticket
      ? {
        ...base,
        seed: ticket.seed,
        ...(ticket.dailyKey ? { dailyDate: ticket.dailyKey } : {}),
      }
      : base;
    incrementGamesPlayed(selectedDifficulty);
    const gameScene = new GameScene(
      app.canvas,
      layoutManager,
      audioManager,
      config,
      selectedDifficulty,
      skipCountdown,
      (summary) => showGameOver(summary),
      () => showMenu(),
      setBgColor,
    );
    sceneManager.switchTo(gameScene);
  }

  function showGameOver(summary: RunSummary) {
    const layout = layoutManager.layout;
    const gameOver = new GameOverScene(
      layout.width, layout.height,
      summary,
      leaderboard,
      audioManager,
      selectedDifficulty,
      runToken,
      () => { void startGame(false); },
      () => showMenu(),
    );
    sceneManager.switchTo(gameOver);
  }

  // Resize handling
  window.addEventListener('resize', () => {
    const layout = layoutManager.recalculate(window.innerWidth, window.innerHeight);
    sceneManager.resize(layout.width, layout.height);
  });

  // Game loop
  app.ticker.add((ticker) => {
    sceneManager.update(ticker.deltaTime / 60);
  });

  showMenu();
}

boot().catch(console.error);
