import type { AcoBridge } from '../shared/ipc';

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. */
    aco: AcoBridge;
  }
}

export {};
