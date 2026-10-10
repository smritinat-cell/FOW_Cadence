# Saved transcript comparison

Open **Before & after** to compare two saved model responses. The initial pair is
the existing Ultravox comparison from `M_0061_14y8m_1.wav`, with 59 removed words
and 23 added words. Both runs used the same audio excerpt and hosted model.
The counts measure wording changes. A reference transcript is needed to measure
accuracy.

The screen preserves the original text, highlights deletions and additions, and
supports copying and downloading each response. **Load old result** and **Load new
result** accept the prompt lab's JSON exports, TXT transcripts, or pasted text.
Imported results stay in memory while the tab is open. JSON downloads include
allowlisted result metadata, with credentials, request payloads and raw events
omitted.

The implementation is isolated in `comparison.js`, `comparison.css`,
`transcript-diff.js` and `comparison-results.json`. The existing shell adds these
assets and dispatches the `/comparison` route to `CadenceComparison.mount`.
Setup, simulation, scorecard and the server are unchanged.

Future result producers can supply the same exported result shape through
`CadenceComparison.setResult("old", result)` and
`CadenceComparison.setResult("new", result)`. Provider execution remains part of
the simulation flow. This comparison screen makes no provider requests.

Run verification with:

```sh
node --test tests/*.test.cjs
```
