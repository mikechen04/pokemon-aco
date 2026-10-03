// All retailer modules. Each reads its DEFAULTS merged with retailer-overrides.json on
// every call, so edits to the overrides file apply the next time a task starts.
import type { RetailerId } from '../../shared/types';
import type { OverridesRepo } from '../data/overrides';
import { AMAZON_DEFAULTS, createAmazon } from './amazon';
import { BESTBUY_DEFAULTS, createBestBuy } from './bestbuy';
import { createPokemonCenter, POKEMON_CENTER_DEFAULTS } from './pokemoncenter';
import { createTarget, TARGET_DEFAULTS } from './target';
import type { RetailerModule } from './types';

export function createRetailerModules(overrides: OverridesRepo): Record<RetailerId, RetailerModule> {
  return {
    target: createTarget(() => overrides.forRetailer('target', TARGET_DEFAULTS)),
    bestbuy: createBestBuy(() => overrides.forRetailer('bestbuy', BESTBUY_DEFAULTS)),
    amazon: createAmazon(() => overrides.forRetailer('amazon', AMAZON_DEFAULTS)),
    pokemoncenter: createPokemonCenter(() => overrides.forRetailer('pokemoncenter', POKEMON_CENTER_DEFAULTS)),
  };
}
