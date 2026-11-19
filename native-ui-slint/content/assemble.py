# Builds content/reply.md from parts/reply.template.md and the diff of the two invented shelf files.
# Run from anywhere: python3 native-ui-slint/content/assemble.py
import pathlib, re, subprocess
here = pathlib.Path(__file__).parent
parts = here / 'parts'
d = subprocess.run(['diff', '-U6', '--label', 'a/src/shelf/shelf.ts', '--label', 'b/src/shelf/shelf.ts',
                    str(parts / 'journal_before.ts'), str(parts / 'journal_after.ts')], capture_output=True, text=True).stdout
diff = "```diff\ndiff --git a/src/shelf/shelf.ts b/src/shelf/shelf.ts\nindex 4be1c07..9a7e2d1 100644\n" + d + "```"
out = (parts / 'reply.template.md').read_text().replace('{{DIFF}}', diff)
(here / 'reply.md').write_text(out)
print('words', len(out.split()), 'chars', len(out))
print('code', len(re.findall(r'^```(typescript|rust|json|shell)$', out, re.M)),
      'activity', len(re.findall(r'^```activity$', out, re.M)), 'diff lines', diff.count('\n') - 1,
      'tables', len(re.findall(r'^\| --- ', out, re.M)))
