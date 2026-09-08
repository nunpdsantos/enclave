import { Container } from 'pixi.js';

export interface Scene {
  container: Container;
  enter(): void;
  exit(): void;
  resize?(width: number, height: number): void;
  update?(dt: number): void;
}

export class SceneManager {
  private stage: Container;
  private currentScene: Scene | null = null;

  constructor(stage: Container) {
    this.stage = stage;
  }

  switchTo(scene: Scene): void {
    if (this.currentScene) {
      this.currentScene.exit();
      this.stage.removeChild(this.currentScene.container);
    }
    this.currentScene = scene;
    this.stage.addChild(scene.container);
    scene.enter();
  }

  resize(width: number, height: number): void {
    this.currentScene?.resize?.(width, height);
  }

  update(dt: number): void {
    this.currentScene?.update?.(dt);
  }

  get current(): Scene | null {
    return this.currentScene;
  }
}
