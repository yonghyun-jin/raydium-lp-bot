// Tick maths and tick-array discovery for the create path.

import { Connection, PublicKey } from '@solana/web3.js';
import { TickArrayLayout, TickArrayUtil } from '@raydium-io/raydium-sdk-v2';
import { config } from '../config';

/**
 * Convert tick to price
 */
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number): number {
  // price = 1.0001^tick * 10^(decimalsA - decimalsB)
  const price = Math.pow(1.0001, tick) * Math.pow(10, decimalsA - decimalsB);
  return price;
}

/**
 * Decode one tick out of a tick-array account. Null when the account is
 * missing or the slot is not present.
 */
export function readTickFromArray(
  account: { data: Buffer } | null,
  tick: number,
  tickSpacing: number
): any | null {
  if (!account) return null;
  const array: any = TickArrayLayout.decode(account.data);
  const offset = TickArrayUtil.getTickOffsetInArray(tick, tickSpacing);
  return array?.ticks?.[offset] ?? null;
}

/**
 * Calculate tick from price
 */
export function priceToTick(price: number, decimalsA: number, decimalsB: number, tickSpacing: number): number {
  // tick = log(price * 10^(decimalsB - decimalsA)) / log(1.0001)
  const adjustedPrice = price * Math.pow(10, decimalsB - decimalsA);
  const tick = Math.floor(Math.log(adjustedPrice) / Math.log(1.0001));

  // Round to tick spacing
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

/**
 * Calculate tick array start index for a given tick
 * Each tick array contains TICK_ARRAY_SIZE (60) * tickSpacing ticks
 */
export function getTickArrayStartIndex(tick: number, tickSpacing: number): number {
  const TICK_ARRAY_SIZE = 60;
  const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
  // Floor division to get start index
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

/**
 * Derive tick array PDA address.
 * startIndex MUST be big-endian to match the Raydium SDK; LE derives a
 * different (nonexistent) account.
 */
export function deriveTickArrayPda(poolId: PublicKey, startIndex: number, programId: PublicKey): PublicKey {
  const startIndexBuffer = Buffer.alloc(4);
  startIndexBuffer.writeInt32BE(startIndex); // Must be BE, not LE!

  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('tick_array'),
      poolId.toBuffer(),
      startIndexBuffer,
    ],
    programId
  );
  return pda;
}

/**
 * Find initialized tick arrays near the current tick and return valid range bounds
 * This finds a CONTIGUOUS range of initialized tick arrays that contains the current tick.
 */
export async function findValidTickRange(
  connection: Connection,
  poolId: string,
  tickCurrent: number,
  desiredTickLower: number,
  desiredTickUpper: number,
  tickSpacing: number
): Promise<{ tickLower: number; tickUpper: number; adjusted: boolean }> {
  const TICK_ARRAY_SIZE = 60;
  const ticksPerArray = TICK_ARRAY_SIZE * tickSpacing;
  const programId = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
  const poolPubkey = new PublicKey(poolId);

  // Search ±TICK_ARRAY_SEARCH_RANGE arrays around the current price
  // (default 20; for tickSpacing=4 that is ±4800 ticks ≈ -38% to +62%).
  const currentArrayStart = getTickArrayStartIndex(tickCurrent, tickSpacing);
  const searchRange = config.strategy.TICK_ARRAY_SEARCH_RANGE;

  const initializedArrays: number[] = [];

  console.log(`\n🔍 Searching for initialized tick arrays...`);
  console.log(`   tickCurrent: ${tickCurrent}`);
  console.log(`   tickSpacing: ${tickSpacing}`);
  console.log(`   ticksPerArray: ${ticksPerArray}`);
  console.log(`   currentArrayStart: ${currentArrayStart}`);
  console.log(`   Search range: ${currentArrayStart - searchRange * ticksPerArray} to ${currentArrayStart + searchRange * ticksPerArray}`);

  // Batch fetch for efficiency
  const pdaChecks: { startIndex: number; pda: PublicKey }[] = [];
  for (let i = -searchRange; i <= searchRange; i++) {
    const startIndex = currentArrayStart + (i * ticksPerArray);
    const pda = deriveTickArrayPda(poolPubkey, startIndex, programId);
    pdaChecks.push({ startIndex, pda });
  }

  // Fetch all accounts at once
  const accountInfos = await connection.getMultipleAccountsInfo(pdaChecks.map(p => p.pda));

  for (let i = 0; i < pdaChecks.length; i++) {
    if (accountInfos[i]) {
      initializedArrays.push(pdaChecks[i].startIndex);
    }
  }

  console.log(`\n📊 Found ${initializedArrays.length} initialized tick arrays`);
  if (initializedArrays.length > 0) {
    console.log(`   Arrays: [${initializedArrays.slice(0, 10).join(', ')}${initializedArrays.length > 10 ? ', ...' : ''}]`);
  }

  if (initializedArrays.length === 0) {
    throw new Error(
      'No initialized tick arrays found near current price. ' +
      'This pool may not have any active positions yet. ' +
      'Use Raydium UI to create your first position, which will initialize the tick arrays.'
    );
  }

  // Sort arrays
  const sortedArrays = initializedArrays.sort((a, b) => a - b);

  // Find the tick array containing current tick
  const currentTickArray = getTickArrayStartIndex(tickCurrent, tickSpacing);
  const currentTickArrayInitialized = sortedArrays.includes(currentTickArray);

  console.log(`   Current tick (${tickCurrent}) is in array ${currentTickArray}: ${currentTickArrayInitialized ? '✅' : '❌'}`);

  if (!currentTickArrayInitialized) {
    // Find the closest initialized array to current tick
    const closest = sortedArrays.reduce((prev, curr) =>
      Math.abs(curr - tickCurrent) < Math.abs(prev - tickCurrent) ? curr : prev
    );
    throw new Error(
      `The tick array containing current price is not initialized. ` +
      `Current tick: ${tickCurrent}, needed array: ${currentTickArray}. ` +
      `Closest initialized: ${closest}. Use Raydium UI to create a position.`
    );
  }

  // Find contiguous range of initialized arrays around current tick
  let lowerArrayBound = currentTickArray;
  let upperArrayBound = currentTickArray;

  // Extend lower
  for (let arr = currentTickArray - ticksPerArray; arr >= sortedArrays[0]; arr -= ticksPerArray) {
    if (sortedArrays.includes(arr)) {
      lowerArrayBound = arr;
    } else {
      break; // Gap found
    }
  }

  // Extend upper
  for (let arr = currentTickArray + ticksPerArray; arr <= sortedArrays[sortedArrays.length - 1]; arr += ticksPerArray) {
    if (sortedArrays.includes(arr)) {
      upperArrayBound = arr;
    } else {
      break; // Gap found
    }
  }

  // Convert array bounds to tick bounds
  const tickLowerBound = lowerArrayBound;
  const tickUpperBound = upperArrayBound + ticksPerArray - tickSpacing;

  console.log(`\n📏 Contiguous initialized range:`);
  console.log(`   Arrays: ${lowerArrayBound} to ${upperArrayBound}`);
  console.log(`   Ticks: ${tickLowerBound} to ${tickUpperBound}`);

  // Check if desired range fits within initialized range
  const desiredLowerArray = getTickArrayStartIndex(desiredTickLower, tickSpacing);
  const desiredUpperArray = getTickArrayStartIndex(desiredTickUpper, tickSpacing);

  console.log(`\n🎯 Desired range: [${desiredTickLower}, ${desiredTickUpper}]`);
  console.log(`   Requires arrays: ${desiredLowerArray} to ${desiredUpperArray}`);

  if (desiredTickLower >= tickLowerBound && desiredTickUpper <= tickUpperBound) {
    // Check ALL required arrays are initialized
    let allInitialized = true;
    for (let arr = desiredLowerArray; arr <= desiredUpperArray; arr += ticksPerArray) {
      if (!sortedArrays.includes(arr)) {
        console.log(`   ❌ Array ${arr} not initialized`);
        allInitialized = false;
      }
    }

    if (allInitialized) {
      console.log(`   ✅ All required tick arrays are initialized`);
      return { tickLower: desiredTickLower, tickUpper: desiredTickUpper, adjusted: false };
    }
  }

  // Need to constrain to contiguous initialized range
  console.log(`\n⚠️ Adjusting range to fit within initialized tick arrays...`);

  // Use the contiguous range, but don't go wider than desired
  const adjustedLower = Math.max(desiredTickLower, tickLowerBound);
  const adjustedUpper = Math.min(desiredTickUpper, tickUpperBound);

  // Align to tick spacing
  const finalLower = Math.ceil(adjustedLower / tickSpacing) * tickSpacing;
  const finalUpper = Math.floor(adjustedUpper / tickSpacing) * tickSpacing;

  console.log(`   Adjusted: [${finalLower}, ${finalUpper}]`);

  if (finalLower >= finalUpper) {
    throw new Error(
      `Cannot create position: no valid tick range within initialized arrays. ` +
      `Available range: [${tickLowerBound}, ${tickUpperBound}]. ` +
      `Use Raydium UI to initialize more tick arrays.`
    );
  }

  // Verify this new range only needs initialized arrays
  const finalLowerArray = getTickArrayStartIndex(finalLower, tickSpacing);
  const finalUpperArray = getTickArrayStartIndex(finalUpper, tickSpacing);

  for (let arr = finalLowerArray; arr <= finalUpperArray; arr += ticksPerArray) {
    if (!sortedArrays.includes(arr)) {
      throw new Error(
        `Internal error: adjusted range [${finalLower}, ${finalUpper}] still requires ` +
        `uninitialized array ${arr}. Use Raydium UI.`
      );
    }
  }

  // Calculate price for the adjusted range
  const priceLower = tickToPrice(finalLower, 9, 6); // SOL/USDC decimals
  const priceUpper = tickToPrice(finalUpper, 9, 6);
  console.log(`   Price range: $${priceLower.toFixed(4)} - $${priceUpper.toFixed(4)}`);

  return { tickLower: finalLower, tickUpper: finalUpper, adjusted: true };
}
