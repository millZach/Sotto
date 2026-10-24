# When your own model server lets a turn down

Checked on Windows on October 23, 2026, for phase 2 of your own model servers (ADR-0124, amended October 24), in the built app with Owl features on, over Sotto's stand-in OpenCode (`tests/fixtures/fakeOpenCodeServer.mjs`). Zach picked placement A from `prototype/own-server-turn-errors`: everything is said in the transcript, where the reply would be.

## What was done

**In the built app** (`tests/e2e/own-server-turn-errors.spec.ts`, 25 s): a server named Sparks at `http://spark-head:8888/v1` was added with one model, DeepSeek V4.1 Flash. The stand-in OpenCode now lists the servers Sotto declares to it in `OPENCODE_CONFIG_CONTENT`, as OpenCode 2.1.4 does, so the model was in the composer's model menu under Sparks and a new OpenCode thread ran on it. The stand-in then played OpenCode's side of each case:

- A silent server. The turn's line worked as always, then 30 seconds in (the window's clock was moved on, not waited out) said "Still waiting for Sparks to start answering." with its time, **Stop**, and "A long prompt can take a few minutes. The turn stops waiting at 5 minutes." under it. With reduced motion on, its dot held still.
- **Stop** from the keyboard. Shift+Tab from the composer reached **Stop** first, named "Stop agent". Enter stopped the turn, the line said "Stopped after …", and focus went to the composer.
- OpenCode trying the server again. The line said "Sparks isn’t answering. Trying again (1 of 10).", then "(3 of 10)" as the next try came, in the attention colour, with **Stop**.
- Each way the server lets a turn down, as the turn's "Failed after …" line with its reason under it, the first sentence in the error colour:
  - no answer after the tries;
  - nothing back within OpenCode's five minutes (Sotto stopped the turn at OpenCode's first header timeout);
  - the key turned down;
  - the model gone from the server;
  - the thread too long for the model.

  Only the newest failure kept its buttons. The server's own message ("Invalid API key.") was never shown.
- The key failure from the keyboard. Tab reached **Open Settings** ("Open Settings at Your own model servers"), then **Try again** ("Try again, sending your last message to Sparks again"). Enter on **Open Settings** opened Settings › Providers at **Your own model servers**, in view and focused, with Sparks in it.
- **Try again** from the keyboard. Enter sent the last message again as a new send: the thread had it twice, the turn ran, and focus went to the composer. The turn then finished normally.

Every state was captured at 1600x1000, 1280x800 and the 820x560 minimum, in Sotto dark and Sotto light: 42 captures, with nothing clipped or spilling sideways at any size. 132 text measurements were taken (`artifacts/own-server-turn-errors/contrast.json`). The lowest was 6.05:1, for the error-coloured first sentence.

The check found and fixed three things:

- A retry never reached the window. Main tells the window a record changed by its signature (`agentActivitySignature`), which left out the turn's own server. A new try keeps the turn running, so it looked unchanged. The signature now includes the server's try and failure.
- **Stop** and **Try again** left focus on a button that goes away. Focus now goes to the composer of the pane they were pressed in.
- The still-waiting line's time is now in the muted colour, as in the prototype.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/own-server-turn-errors/retrying-1280-dark.png` | OpenCode trying Sparks again, on its third try, with Stop |
| `artifacts/own-server-turn-errors/waiting-1280-light.png` | Still waiting for Sparks, with its time, Stop and what the wait means, light |
| `artifacts/own-server-turn-errors/waiting-1280-dark-reduced-motion.png` | The same with reduced motion: the dot holds still |
| `artifacts/own-server-turn-errors/fail-unreachable-1600-dark.png` | Sparks didn’t answer, with Try again |
| `artifacts/own-server-turn-errors/fail-timeout-1600-light.png` | Sparks didn’t start answering within 5 minutes; the earlier failure has no buttons |
| `artifacts/own-server-turn-errors/fail-key-refused-820-light.png` | The key turned down, with Open Settings and Try again, at the minimum window |
| `artifacts/own-server-turn-errors/fail-too-long-1280-dark.png` | The thread too long for the model, under the model-gone failure |
| `artifacts/own-server-turn-errors/open-settings-1280-dark.png` | Open Settings landing on Your own model servers |

## Not checked here

- A real model server. The Sparks were not running, and no other server Sotto could reach was. Every failure here is the stand-in OpenCode saying what OpenCode 2.1.4 sends, as captured against a fake server (`src/main/ownModelServers/turnFailure.ts`). So the "Failed after" times are the stand-in's fractions of a second, not OpenCode's minute and a half of tries or its five minutes.
- The real OpenCode's retries reaching the window. `tests/integration/opencodeOwnServerTurns.test.ts` covers the adapter against the stand-in; the live suite does not play a failing server.
- What a screen reader says. The try and the still-waiting words are a polite status. A failure is not announced, as no failed turn is (the prototype had it as an alert).
- Threads on a remote host, phones and Watcher's news, which read the English reason main keeps.
- Interface languages other than English. The words are in the catalogs, but no translated run was captured.
- macOS and Linux.
