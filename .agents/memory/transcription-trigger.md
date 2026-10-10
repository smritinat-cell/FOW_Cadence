---
name: Transcription trigger
description: Paid Ultravox work starts only on explicit run/evaluate button clicks.
---

Paid Ultravox calls start only from an explicit run, review, or Test these changes click. Selecting a sample must not start transcription.

**Why:** The user explicitly replaced the earlier sample-selection trigger when requesting the real simulation/evaluation flow. Paid work must be deliberate, not a side effect of editing or restoring setup.

**How to apply:** Loading, reloading, sample selection, restoring, polling, timeouts, and applying suggested prompts must never create or retry calls. Retry only on an explicit click. Serialize runs and label incomplete output partial. The later sandbox request authorizes an audio run followed by a text review as one explicit Test these changes action; this is not permission to automatically review ordinary Simulation runs.
