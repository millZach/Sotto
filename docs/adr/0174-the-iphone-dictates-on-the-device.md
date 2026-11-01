# The iPhone dictates on the device

## Status

Accepted November 1, 2026, at Zach's request. It goes straight to stable and is not an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). Zach asked for the iPhone's reply box in the shape of Claude's iPhone composer, mic included, and picked "Dictate on this iPhone" for the mic from the prototype `docs/prototypes/ios-claude-composer-prototype.html`, kept as the tag `prototype/ios-claude-composer`, with variant A for the box ([ADR-0166](0166-the-iphones-reply-box-changes-what-a-thread-runs-with.md), November 1 amendment).

## Context

The iPhone app had no dictation of its own. Watcher's design left it to the keyboard's own mic key (Watcher pick 7A), and iOS gives an app no way to press that key. Claude's composer has a mic button in its row, and Zach wanted the same. On the desktop, dictation is transcribed on the computer by a local speech model ([ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md)), and dictation audio is never written to disk. Voice control was removed ([ADR-0068](0068-remove-voice-control-and-thread-management.md)): dictation is the only thing that listens, and nothing speaks.

iOS has a speech recognizer, `SFSpeechRecognizer`, that can be told to recognize on the device only (`requiresOnDeviceRecognition`) and fails rather than send audio to Apple. It needs the user's leave for the microphone and for speech recognition, each asked once by iOS with a sentence the app gives.

## Decision

**1. The mic dictates into its own box, on this iPhone only.** A press of the mic in a thread's reply box or Watcher's box asks iOS for the microphone and speech recognition the first time, then listens. What it hears goes after the words already in the box, revised as it hears more, with one space between where neither side has one. The mic fills with the accent and the row's left side says **Listening on this iPhone** while it listens. A second press, a send, or the box leaving the screen stops it. One box listens at a time; pressing another box's mic moves the listening there.

**2. Recognition stays on the device.** Every request sets `requiresOnDeviceRecognition`. Where the iPhone can't recognize its language on the device, the mic says so and does nothing: **This iPhone can't recognize speech in its language without sending it to Apple, so Sotto doesn't dictate here. The keyboard's own mic key still works.** Sotto adds no host, and the README's "Privacy and cost" says so.

**3. Nothing is kept.** The microphone's audio goes to the recognizer in memory and is never written to disk, recorded or sent. What is heard is never logged; it is the box's draft, and leaves the iPhone only when the user sends it. The phone keeps no dictation record ([CONTEXT.md](../../CONTEXT.md) **Dictation record** is the desktop's).

**4. Errors say what happened.** If iOS hasn't allowed the microphone or speech recognition, an alert says so with **Open iOS Settings**. If the microphone doesn't start, it says nothing was heard and the words are as they were.

## Consequences

- The app's Info.plist carries `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`, in all thirty interface languages ([ADR-0123](0123-sottos-interface-speaks-the-computers-language.md)).
- `DictatedWords.join` in SottoCore is how heard words join the box's, under `DictatedWordsTests`. The listening itself is `Dictation` in `Composer.swift`. CI's simulators can't grant the microphone, so the Focus journeys check the mic's place and name, not dictation.
- The keyboard's own mic key, Watcher's pick 7A, still works beside it.
- Dictation publishes only as it starts and stops; what it hears goes straight into the box's draft, which redraws the box and nothing else.
