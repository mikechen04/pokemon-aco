import { join } from 'node:path';
import { app } from 'electron';

/** Everything the app writes lives under the per-user data folder (%APPDATA%\Pokemon ACO on Windows). */
export const paths = {
  get userData(): string {
    return app.getPath('userData');
  },
  get data(): string {
    return join(app.getPath('userData'), 'data');
  },
  get logs(): string {
    return join(app.getPath('userData'), 'logs');
  },
  get catalog(): string {
    return join(app.getPath('userData'), 'catalog.json');
  },
  get overrides(): string {
    return join(app.getPath('userData'), 'retailer-overrides.json');
  },
  dataFile(name: string): string {
    return join(app.getPath('userData'), 'data', name);
  },
};
