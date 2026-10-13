import '@fontsource-variable/inter';
import '@fontsource-variable/inter/wght-italic.css';
import './ui/styles.css';
import { Game } from './game/game';

const status = (s: string) => {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = s;
};

async function boot() {
  try {
    if (!('OffscreenCanvas' in window)) throw new Error('This browser does not support OffscreenCanvas (needed for the map renderer). Please use a current Chrome, Edge, Firefox or Safari.');
    // make sure label fonts are ready before the first frame
    await Promise.race([
      Promise.all([document.fonts.load('600 12px "Inter Variable"'), document.fonts.load('italic 500 12px "Inter Variable"')]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    const game = new Game();
    (window as any).game = game;
    await game.start(status);
    // ready: wait for the player to press Play (also gives the page keyboard focus)
    status('Midtown is ready — Peachtree St & 10th St');
    const btn = document.getElementById('play') as HTMLButtonElement;
    const keys = document.getElementById('play-keys')!;
    btn.hidden = false;
    keys.hidden = false;
    btn.focus();
    await new Promise<void>((resolve) => {
      btn.addEventListener('click', () => resolve(), { once: true });
    });
    window.focus();
    document.getElementById('loading')!.classList.add('done');
    game.begin();
  } catch (e) {
    console.error(e);
    status(String((e as Error).message ?? e));
  }
}

boot();
