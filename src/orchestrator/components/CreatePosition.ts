// CreatePosition - Create Raydium CLMM position

import { LpClient } from '../../raydium/LpClient';
import { Config, CreatePositionResult } from '../types';

export class CreatePosition {
  private client: LpClient;

  constructor(client: LpClient) {
    this.client = client;
  }

  /**
   * Create new LP position based on Config
   * Now uses asymmetric price bounds directly (priceLower/priceUpper)
   */
  async execute(config: Config): Promise<CreatePositionResult> {
    console.log(`[CreatePosition] Creating position...`);
    console.log(`  - Pool: ${config.poolId}`);
    console.log(`  - Range: $${config.priceLower.toFixed(2)} - $${config.priceUpper.toFixed(2)}`);
    console.log(`  - ${config.coin1}: ${config.coin1Amount}`);
    console.log(`  - ${config.coin2}: ${config.coin2Amount}`);

    // Create position with actual price bounds (asymmetric ranges supported)
    const result = await this.client.createPosition(
      config.poolId,
      config.coin1Amount,
      config.coin2Amount,
      config.priceLower,
      config.priceUpper
    );

    console.log(`[CreatePosition] Position created!`);
    console.log(`  - NFT Mint: ${result.nftMint}`);
    console.log(`  - TX: ${result.txId}`);

    return {
      nftMint: result.nftMint,
      txId: result.txId,
      solDeposited: result.solDeposited,
      usdcDeposited: result.usdcDeposited,
    };
  }

  /**
   * Create position with directly specified priceLower/Upper
   */
  async executeWithPrices(
    poolId: string,
    coin1Amount: number,
    coin2Amount: number,
    priceLower: number,
    priceUpper: number
  ): Promise<CreatePositionResult> {
    const result = await this.client.createPosition(
      poolId,
      coin1Amount,
      coin2Amount,
      priceLower,
      priceUpper
    );

    return {
      nftMint: result.nftMint,
      txId: result.txId,
      solDeposited: result.solDeposited,
      usdcDeposited: result.usdcDeposited,
    };
  }
}
