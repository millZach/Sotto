# Sotto launch video: cue sheet

- **Tempo:** 100 BPM, 4/4. One beat is 0.6 s, one bar is 2.4 s. Positions are bar.beat from 1.1 at 0.0 s; ½ is the half-beat.
- **Length:** 37.2 s (2232 frames at 60 fps), ending on 16.3.
- **Bed:** `audio/PLACEHOLDER-music.mp3`, 37.2 s of silence, until a licensed track replaces it. The track should reach its first downbeat at 0.0, keep 100 BPM, and resolve by 33.0 (14.4), where the end card begins, then ring out under the card. No voiceover, no sound effects.
- **Source of truth:** `src/edit.ts`. If a cut moves there, it moves here.

## Cuts

| Time (s) | Bar.beat | Cut to | Take |
|---:|---|---|---|
| 0.0 | 1.1 | Hook: the empty composer | hook |
| 0.9 | 1.2½ | Hook: the widget listening | hook |
| 1.8 | 1.4 | Hook: the widget, stop and Transcribing | hook |
| 2.4 | 2.1 | The words landing, Enter, then the pull-back to the whole window (one shot to 7.2) | hook |
| 7.2 | 4.1 | Three threads side by side | split |
| 9.6 | 5.1 | The permission card, Allow once | requests |
| 11.1 | 5.3½ | The Codex question | requests |
| 12.6 | 6.2 | Browser in Tools | tools |
| 14.4 | 7.1 | Terminal in Tools | tools |
| 15.6 | 7.3 | Files in Tools | tools |
| 16.8 | 8.1 | Changes: selecting lines 12 and 13 | tools |
| 17.7 | 8.2½ | Changes: the comment added, easing back to the composer chip | tools |
| 19.2 | 9.1 | The Git action, Commit, push & PR | git |
| 19.8 | 9.2 | Commit changes, message left empty | git |
| 21.0 | 9.4 | Created PR #74 | git |
| 21.6 | 10.1 | The merge checklist | git |
| 23.4 | 10.4 | Merge pull request?, confirmed | git |
| 24.0 | 11.1 | Pull request merged | git |
| 24.6 | 11.2 | Workspace: New worktree | worktrees |
| 25.8 | 11.4 | The sidebar, a branch per thread | worktrees |
| 27.0 | 12.2 | The working-copy card, Remove worktree | worktrees |
| 28.8 | 13.1 | Notepad, dictation starts | anywhere |
| 29.7 | 13.2½ | Notepad, dictation stops | anywhere |
| 30.3 | 13.3½ | Notepad, the words pasted | anywhere |
| 31.8 | 14.2 | Theme: Sotto dark | still |
| 32.0 | 14.2 + ⅓ | Theme: Hush light | still |
| 32.2 | 14.2 + ⅔ | Theme: Linen dark | still |
| 32.4 | 14.3 | Theme: Nocturne light | still |
| 32.6 | 14.3 + ⅓ | Theme: Tropic dark | still |
| 32.8 | 14.3 + ⅔ | Theme: Citrine light | still |
| 33.0 | 14.4 | End card: the icon and Sotto | |
| 33.6 | 15.1 | End card: the tagline | |
| 34.8 | 15.3 | End card: Free and open source · Windows and macOS · No account | |
| 35.4 | 15.4 | End card: github.com/millZach/Sotto-releases | |
| 37.2 | 16.3 | End | |

The theme stills are cut in triplets, three to a beat.

## Captions

One at a time, each fading in over 8 frames and out over 8.

| In (s) | Out (s) | Bar.beat | Caption | Words | Minimum (s) |
|---:|---:|---|---|---:|---:|
| 4.2 | 7.2 | 2.4 to 4.1 | Your coding agents. One window. | 5 | 1.75 |
| 7.2 | 9.6 | 4.1 to 5.1 | Run them side by side. | 5 | 1.75 |
| 9.6 | 12.6 | 5.1 to 6.2 | You answer every request. | 4 | 1.4 |
| 12.6 | 16.8 | 6.2 to 8.1 | Browser, terminal, files and changes. | 5 | 1.75 |
| 16.8 | 19.2 | 8.1 to 9.1 | Beside every thread. | 3 | 1.2 |
| 19.2 | 21.9 | 9.1 to 9.4½ | Leave the message. The agent writes it. | 7 | 2.45 |
| 21.9 | 24.6 | 9.4½ to 11.2 | Commit, push and open a pull request. | 7 | 2.45 |
| 24.6 | 26.4 | 11.2 to 12.1 | Its own branch and folder. | 5 | 1.75 |
| 26.4 | 28.8 | 12.1 to 13.1 | Remove the folder when you’re done. | 6 | 2.1 |
| 29.4 | 31.8 | 13.2 to 14.2 | Dictation anywhere. | 2 | 1.2 |

## Key caps and on-screen moments

Key caps sit on the frame the key is pressed in the footage, so they are not on the grid. A licensed track needn't hit them.

| Time (s) | What |
|---:|---|
| 0.5 | Key caps `Ctrl` `Shift` `Space`: dictation starts |
| 2.05 | Key caps `Ctrl` `Shift` `Space`: dictation stops |
| 2.55 | The words land in the composer |
| 3.35 | Key cap `Enter`: the message sends |
| 10.5 | Allow once pressed |
| 13.6 | The demo page turns dark |
| 15.0 | The test results appear |
| 18.3 | The comment is added |
| 20.8 | Commit, push & PR pressed |
| 23.75 | Merge confirmed |
| 29.1 | Key caps `Ctrl` `Shift` `Space`: dictation starts |
| 29.9 | Key caps `Ctrl` `Shift` `Space`: dictation stops |
| 30.45 | The words are pasted into Notepad |
