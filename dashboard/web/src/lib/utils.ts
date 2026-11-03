/**
 * The `cn` helper every shadcn component imports.
 *
 * `clsx` resolves conditionals; `twMerge` then drops the loser when two
 * utilities target the same property, so a caller's `className` can override
 * a component's own default instead of depending on source order.
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
