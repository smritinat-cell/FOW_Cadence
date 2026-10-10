---
name: Transcription trigger
description: The user's requested trigger for live sample transcription.
---

Selecting an audio sample should trigger an Ultravox flow to transcribe the sample.

**Why:** The user explicitly requested this behavior after the initial prototype-only phase, replacing the earlier run-button-only restriction for this transcription action.

**How to apply:** Tie transcription creation to deliberate sample selection. Loading, refreshing, restoring a stored selection, or polling an existing run must not start new paid calls. Keep unavailable transcripts visibly unavailable rather than generating placeholder results.
