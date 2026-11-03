// RangeSetup - Calculate new range and create Config

import { LpClient } from '../../raydium/LpClient';
import { Config, createConfig } from '../types';
import { newOperationId } from '../types/Config';


export class RangeSetup {
  // The client is accepted for API stability; range setup is pure maths.
  constructor(_client: LpClient) {}

  /*
   * REMOVED: create(input) and createFromPrevious(params).
   *
   * Both built a SYMMETRIC range from a `rangePercent` around the current
   * price, and neither had a caller -- every create goes through
   * createWithPrices with the model's asymmetric bounds. A symmetric range is
   * not what the model produces, and picking a width by eye is the
   * arbitrary-number failure that cost 19 positions.
   *
   * `create` also minted its own operation id from the clock alone, which is
   * the half of the collision that slice 4 missed.
   */

  createWithPrices(input: {
    poolId: string;
    priceLower: number;
    priceUpper: number;
    coin1Amount: number;
    coin2Amount: number;
    duration: number;
    coin1?: string;
    coin2?: string;
    /**
     * Supply the operation id rather than minting one here.
     *
     * The swap that funds a position happens BEFORE this is called, and its
     * ledger rows have to carry the same `operation_id` as the open they lead
     * to -- that id is what groups one P&L cycle. Generating it here would mean
     * booking the swap under an id that does not exist yet, or booking it after
     * the create and losing it entirely when the create throws.
     */
    operationId?: string;
  }): Config {
    const operationId = input.operationId ?? newOperationId();

    return createConfig({
      priceLower: input.priceLower,
      priceUpper: input.priceUpper,
      coin1: input.coin1 || 'SOL',
      coin2: input.coin2 || 'USDC',
      operationId,
      coin1Amount: input.coin1Amount,
      coin2Amount: input.coin2Amount,
      duration: input.duration,
      poolId: input.poolId,
    });
  }

}
