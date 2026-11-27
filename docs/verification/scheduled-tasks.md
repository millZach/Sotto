# Scheduled tasks on Windows

Run `npm run build` and `npx playwright test tests/e2e/scheduled-tasks.spec.ts --workers=1` with the Node version in `.node-version`. The journey launches the built app with an owned test profile, the scheduled tasks Owl feature on, and a fake provider. It uses no live provider or GitHub account.

- The **Run scheduled tasks on this computer** switch starts off. Turn it on, save a playbook task in a project, and press **Run now**.
- The run waits for a decision. Close the app and reopen it with the same profile. Answer **Go on** and check that the single run finishes.
- Check the Settings page at 1600 × 1000, 1280 × 800 and 820 × 560, in both light and dark appearance with reduced motion on. The Settings pane fits without horizontal scrolling at each size.

Both captures show the waiting decision at the minimum window size.

- [Dark appearance](../../artifacts/scheduled-tasks/waiting-dark-820x560.png)
- [Light appearance](../../artifacts/scheduled-tasks/waiting-light-820x560.png)
