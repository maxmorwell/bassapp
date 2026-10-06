# tests/reference/ — local only

Everything here except this README is git-ignored. Each session, copy in:

- `bass_shake_gen.py` — the reference generator, from the VIDEO project (`tools/`).
  `tests/golden.py` checks its md5 against `REF_MD5`; a mismatch fails the test.
  Re-copy and investigate; never just update the fingerprint.
- `work_areas.json` — frames → [audio file, offset s] for the shipped edits
  (from the VIDEO project's `reference/source/README.md`). Only needed for `--shipped`.
