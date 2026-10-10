# Accessibility Evaluation

Cadence demo sample setup, live Ultravox baseline transcription, and text-only
Ultravox prompt review. Before & after currently shows a clearly labelled,
user-supplied demo comparison; live revised-prompt runs are coming next.

## Start the app

Run **`npm start`**. The app listens on port 5000. Node.js dependencies are tracked
in `package.json` and FFmpeg is configured in `.replit` under Nix dependencies.
The server requires the existing `ULTRAVOX_API_KEY` Replit secret; it never sends
the key or provider join URLs to the browser.

Demo samples are discovered from JSON files in `demo-pack/`. Keep each sample's
JSON metadata there. The prototype's three recordings are served from the
original uploaded WAV files in `attached_assets/`; they are not duplicated into
the source tree. If no sample JSON files are present, the setup screen displays
three disabled placeholder cards.

These recordings are available in the workspace prototype only. Configure
Replit App Storage before publishing the audio; a storage bucket is not yet
configured for this project. WAV uploads are excluded from Git and publication.
The three samples have explicit fictional pediatric agent contexts and editable
prompt presets. Selecting a different sample asks before replacing an edited
field. The recordings themselves are ordinary conversations, not healthcare
encounters.

Step 1's use-case dropdown comes from the three demo-pack entries and drives
the matching agent context and Step 2 audio selection. Cards and dropdown stay
in sync. Agent ID and excerpt choices are preserved; offsets are clamped to the
new sample. One confirmation protects all edited auto-filled fields. Reset
restores sample defaults without replacing Agent ID. Saved setup edits survive
reload. Jobs record the selected use case as metadata only, never model input.

## Deliberate provider calls

- **Simulation → Run baseline:** a new async job decodes the chosen excerpt
  with FFmpeg to 16 kHz mono 16-bit little-endian PCM. The server streams it at
  real-time speed followed by two seconds of silence, using the fixed prompt
  `Transcribe the audio. Output only the transcript.` and default VAD.
- **Evaluate transcript:** a separate text-output call reviews the raw baseline
  against the exact editor prompt and labelled agent metadata. It does not
  receive the audio recording, reference transcript or reference material.
  Server WebSocket silence maintains connection liveness while it responds.
- Only explicit button clicks create calls. Restore, navigation, sample
  selection, polling, timeouts and prompt application never start paid calls.
  Calls are globally serialized; Stop cancels active work.
- Model aliases come from Ultravox's model list; `ultravox-v0.6` is preferred
  when available, otherwise another listed model is selected. Evaluation keeps
  the selected model unless it is unavailable; this is resolved before the one
  call is created, not by retrying a failed call. Requested and resolved models
  are recorded independently.
- No automatic retries. Parse failures preserve raw responses and offer an
  explicit Retry button. Nonverbatim quotes and unapplied edits stay visible.
  Replacement edits cannot remove protected role/safety/escalation anchors.
- Findings are model review, not measured word accuracy, accessibility, or task
  completion. Those measurements remain Unavailable. The server alone computes
  the **Prompt readiness score (model-assessed)** from verified findings,
  confidence, coverage, and use-case weights in the versioned
  `config/prompt-readiness-rubric.json`. Unobserved themes are excluded, two
  observed themes are required for an overall score, and a verified uncovered
  critical issue caps it at 55. Exact penalties accumulate before whole-number
  rounding. The model never supplies a displayed score.
- Suggested prompt edits are advisory and server-validated. Unverified or
  fully covered findings cannot justify an edit. Missing/conflicting anchors,
  unsafe replacements, detected transcript personal details, unsupported
  terminology, and oversized edit sets stay visibly unapplied. Original
  characters are preserved in unchanged lines. Suggestions are saved as
  evaluation evidence, not as an active revised draft; Copy/Use/Export are
  explicit actions and never run a prompt.
- Scorecards retain immutable evaluated prompt snapshots and flag changed
  audio, excerpt, model, use case, or editor contents. A new baseline clears the
  displayed scorecard without deleting saved evaluations. Setup is locked while
  evaluation is active. Reopening an evaluation reads disk only, without a
  provider call.
- **Before & after:** the supplied before/after texts are fixed demo data, kept
  separately from sample metadata and real run history. Highlights and word-change
  counts describe text differences, not accuracy or improvement. Copy and TXT/JSON
  export preserve the exact supplied text. Live comparison buttons are disabled;
  this screen never sends either example to Ultravox or uses it as reference data.

## Evaluation routes

- `POST /api/evaluations` starts one explicit asynchronous job and returns its ID.
- `GET /api/jobs/:id` polls lifecycle; `POST /api/jobs/:id/stop` cancels it.
- `GET /api/evaluations/:id` reads an owner-scoped saved evaluation.
- `POST /api/evaluations/:id/state` checks current setup against saved evidence,
  without creating a job, updating the draft, or contacting a provider.
- `GET /api/evaluations/:id/suggested-prompt` returns exact plain text;
  `?download=1` adds a controlled, UUID-based TXT filename.

Pasted reference material is used only for server-side terminology validation.
It is not sent to the evaluator and is never a reference transcript or an
accuracy ground truth. Test fixtures are labelled test data and kept separate
from real results.

## Verification commands

- `npm test`: local protocol, runner, validation and FFmpeg checks, no paid calls.
- `node scripts/verify-ui.js`: controlled Preview UI responses, no paid calls.
- `node scripts/verify-preview.js --paid`: explicitly opted-in real button-driven
  Preview calls. Never part of startup or automatic tests. Wait for a replacement
  usable key before running this command again.

## Saved results and limits

Jobs are saved as permission-restricted JSON in `var/results/`, outside the
static web root and excluded from Git and publication. Server-owned session
hashes isolate history; the browser gets no provider credential or join URL.
Diagnostics use allowlisted event/status fields, not raw provider errors.
The local disk is not a durable cross-instance production store.

FFmpeg preparation has a 20-second bound, provider HTTP and WebSocket joining
have 12-/10-second bounds, baseline final-output waiting has a 25-second bound,
and evaluator waiting has a 60-second bound. Calls have matching bounded
provider durations. Runs interrupted by a restart are marked cancelled, not
retried. Partial output is preserved and never relabelled as a successful
baseline. A user can explicitly evaluate a selected partial baseline; all such
scores and evidence remain provisional.

## Verified protocol sources

Reviewed on 2026-10-10:
- https://docs.ultravox.ai/api-reference/calls/calls-post
- https://docs.ultravox.ai/apps/websockets
- https://docs.ultravox.ai/apps/datamessages
- https://docs.ultravox.ai/api-reference/other/models-get

WebSocket transcripts are assembled independently by role and ordinal. Full
text replaces the current utterance; deltas append. Wording is not cleaned up.
