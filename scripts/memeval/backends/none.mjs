// No-memory baseline: retain no history and always abstain.
export function createBackend() {
  return {
    name: 'none',
    reset() {},
    observe() {},
    answer() { return { answer: null, memoryIds: [] } },
  }
}
