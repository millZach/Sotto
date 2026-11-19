# Writes content/history.json: 200 invented earlier messages (100 exchanges) for the bake-off thread.
import json, pathlib, random
rng = random.Random(2689)
topics = ['the export button', 'the shelf search', 'the title field', 'autosave', 'the sync badge', 'the import dialog',
          'the settings page', 'the tray menu', 'the empty state', 'keyboard focus in the list', 'the dark theme',
          'the upload queue', 'the crash harness', 'the release notes', 'the onboarding card']
asks = [
  'Can you look at {t}? It feels slow when the list is long.',
  'Why does {t} lose focus after I press Escape?',
  'Please tidy the copy on {t}. It still says "click here".',
  'Run the unit tests for {t} and tell me what fails.',
  'Is {t} covered by the end-to-end suite?',
  'Make {t} work from the keyboard alone.',
  'What changed in {t} since last week?',
  'Check {t} at the smallest window size.',
  'هل يمكنك مراجعة {t}؟ The Arabic labels are cut off on the right.',
  'یہ {t} اردو میں ٹھیک نظر نہیں آ رہا۔ Please check the right-to-left layout.',
]
answers = [
  'I looked at {t}. The list re-sorted on every keystroke; it now sorts once when the filter settles, and typing stays smooth with 5,000 entries.',
  'Fixed. {t} kept a stale ref after the dialog closed, so focus went back to the page body. It now returns to the button that opened it.',
  'Done. {t} now says what a press does:\n\n- **Export shelf** instead of "Click here to export"\n- **Choose a folder** instead of "Browse"',
  'Ran the tests for {t}: 31 passed, 2 failed. Both failures are the same snapshot that still has the old wording; I updated it and they pass now.',
  'Partly. {t} has two journeys, opening and closing, but nothing covers the error path. I added one that unplugs the fake server mid-request.',
  'It does now. Tab reaches every control in {t} in reading order, the arrow keys move inside the list, and `Escape` closes the menu.',
  'Three commits touched {t}: the wording change, a focus fix, and a rename of `ShelfRow` to `EntryRow`. Nothing that changes behaviour.',
  'At 820 by 560, {t} clipped the last button. I let the row wrap, and nothing overflows now in either theme.',
  'راجعت {t}. The labels were aligned left; they now follow the text direction, and the numbers stay in order: ٣ من ١٢ ملفات.',
  'میں نے {t} دیکھا۔ The layout now flips for اردو, the icons mirror, and mixed lines like "Saved 3 فائلیں" read correctly.',
]
msgs = []
for i in range(100):
    t = rng.choice(topics)
    k = rng.randrange(len(asks))
    msgs.append({'role': 'user', 'text': asks[k].format(t=t)})
    msgs.append({'role': 'assistant', 'text': answers[k].format(t=t)})
pathlib.Path(__file__).with_name('history.json').write_text(json.dumps(msgs, ensure_ascii=False, indent=1))
print(len(msgs))
