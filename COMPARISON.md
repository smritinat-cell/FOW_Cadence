# Transcript comparison

**Before & after** uses the current Simulation and Scorecard flow. Completed
sandbox tests load their paired results from `/api/comparisons`; the screen keeps
the performance review, prompt changes and prompt-copy action from the latest app.

The transcript cards use the shipped word alignment, showing removed words in
red and added words in green. Counts and highlights come from the same alignment.
The original text is preserved for display, copying and TXT downloads. Large
transcripts use the server alignment to keep the screen responsive.

The recording heading uses the sample filename supplied in Step 1. Older run
filenames have the upload timestamp removed for display. Comparison styling is
isolated in `comparison.css` and uses the current Cadence fonts and color tokens.

If the selected recording’s run fails, its earlier saved pair can appear as a
fallback. The included pair is for `M_0061_14y8m_1.wav`, with 59 words removed and
23 added. It is labelled as earlier results, has no new performance scores or
prompt-apply action, and is used only for that recording. Loading this fallback
makes no provider requests. Successful live comparisons take precedence.

Run verification with:

```sh
node --test tests/*.test.js tests/*.test.cjs
```

## Complete saved demo

Open `/?demo=1#/setup` to walk through the app using the saved transcript.
Setup shows the recording and demo transcript. Simulation shows the baseline.
Scorecard’s **Fix prompt** reveals the completed improved output and exact system
prompt from the previous demo. Before & after shows the same saved pair.
All stages in this mode load local assets and make no Ultravox requests.
The normal flow remains available without `demo=1`.
