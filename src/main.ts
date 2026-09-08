import { Application } from 'pixi.js';
import { LayoutManager } from './rendering/LayoutManager';
import { SceneManager } from './scenes/SceneManager';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { GameOverScene } from './scenes/GameOverScene';
import { AudioManager } from './audio/AudioManager';
import { Leaderboard } from './core/Leaderboard';
import { Difficulty, DIFFICULTY_CONFIGS } from './core/Config';
import { incrementGamesPlayed } from './core/Settings';
import { RunSummary } from './core/types';
import { THEME } from './rendering/Theme';

const LAST_DIFFICULTY_KEY = 'enclave_last_difficulty';

function readLastDifficulty(): Difficulty {
  try {
    const raw = localStorage.getItem(LAST_DIFFICULTY_KEY);
    if (raw === 'classic' || raw === 'blitz') return raw;
  } catch { /* */ }
  return 'classic';
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
  const leaderboard = new Leaderboard(selectedDifficulty);

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
        leaderboard.switchDifficulty(difficulty).then(() => {
          if (sceneManager.current === menu) menu.refreshLeaderboard();
        });
      },
      () => startGame(false),
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

  function startGame(skipCountdown: boolean = false) {
    // Recompute the layout on the way in: handedness may have been changed
    // in the menu since it was last measured.
    layoutManager.recalculate(window.innerWidth, window.innerHeight);
    const config = DIFFICULTY_CONFIGS[selectedDifficulty];
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
      () => startGame(false),
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
