// PriceMonitor - Price monitoring and range checking

import { LpClient } from '../../raydium/LpClient';

export class PriceMonitor {
  private client: LpClient;

  constructor(client: LpClient) {
    this.client = client;
  }

  /**
   * Get current price
   */
  async getCurrentPrice(poolId: string): Promise<number> {
    return this.client.getCurrentPrice(poolId);
  }

  // REMOVED: checkRange, checkRangeWithPrice, getDeviation,
  // getDeviationWithPrice, getStatusString.
  //
  // All five took a PositionState -- the shape of the deleted
  // `.orchestrator-state` store -- and were reached only from
  // `checkAllPositions`, which only the orchestrator CLI ran. The bot's own
  // in-range check is chain-derived, in `getPositionDetails`.
  //
  // Careful: there were THREE independent in-range implementations. This was
  // one; `src/monitor/state.ts` (deleted in A1) was another. The chain-derived
  // one is the only one that has ever been on the money path.
}
