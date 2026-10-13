/// <reference lib="webworker" />
// Tile worker entry point — the work happens in tileService.ts.
import { createTileService } from './tileService';

declare const self: DedicatedWorkerGlobalScope;
const handle = createTileService((m, t) => self.postMessage(m, t ?? []));
self.onmessage = (ev: MessageEvent) => handle(ev.data);
