// The deep-polars release Passage reads, as pinned in
// contracts/shared-contracts.lock.json ("releases"); server/polars.test.mjs
// checks the two agree. Refresh both deliberately, never to pass a check.
export const DEEP_POLARS = Object.freeze({
  repository: 'deepregatta/deep-polars',
  version: '2026.2',
  commit: '1d1e72e61cb186e4ab01f4c2955a6439f37ae5c3',
  indexSha256: 'd9fffe0ec8fb42a8b3c41232f73daebe80fd8cd8ab198c55d4d029a58436795e',
});
