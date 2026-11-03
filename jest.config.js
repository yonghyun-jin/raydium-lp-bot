/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  // Network-dependent suites are opt-in via `npm run test:live`.
  //
  // `.worktrees/` holds git worktrees of OTHER branches. It is gitignored, but
  // Jest walks the filesystem rather than the index, so without this the root
  // `npm test` silently runs a second branch's suite alongside this one --
  // observed as 747 tests becoming 1426. A stale copy passing or failing there
  // tells you nothing about the branch you are on.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/\\.worktrees/',
    '\\.live\\.test\\.ts$',
  ],
  setupFiles: ['<rootDir>/tests/setup/no-money.ts'],
  // @solana/web3.js -> rpc-websockets -> uuid@14, which is ESM-only and cannot
  // be require()d by Jest. See tests/shims/uuid.js.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/tests/shims/uuid.js',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  verbose: true,
  testTimeout: 10000,

  // Coverage is scoped to the code that moves money. Dead modules must not
  // inflate the number: 53 of the repo's 97 original tests covered modules
  // nothing imports.
  collectCoverageFrom: [
    'src/raydium/client.ts',
    'src/raydium/jito.ts',
    'src/raydium/guard.ts',
    'src/orchestrator/**/*.ts',
    'src/telegram/state.ts',
    '!src/orchestrator/cli.ts',
    '!src/**/*.d.ts',
  ],
};
