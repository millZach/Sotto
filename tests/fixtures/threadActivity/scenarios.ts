/** The states the activity fixture page shows, shared by the page and the specs that drive it. */
export type Scenario = 'settled' | 'live' | 'disconnected' | 'restored' | 'steered' | 'asked' | 'images'
declare global { interface Window { activityFixture?: { show: (scenario: Scenario) => void } } }
