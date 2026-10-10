---
name: Demo context boundaries
description: User-defined boundaries between fictional pediatric agent scenarios, editable prompts, and transcription.
---

The sample recordings are ordinary conversations, not recordings of pediatric healthcare deployments. Their healthcare agent contexts are hard-coded demo scenarios.

Agent names, purposes, speech profile tags and selected use case are experiment metadata, never hidden system instructions. The visible editor contents are the sole editable agent system prompt. Use-case metadata must not be added to evaluator input either.

Use-case and sample selection must remain synchronized. Preserve edited auto-filled fields on repeat selection and restoration; use one confirmation for all edited fields before switching or resetting. Agent ID is always user-owned and must never be replaced by auto-fill or reset.

The fixed transcription baseline must remain exactly: `Transcribe the audio. Output only the transcript.`

**Why:** The user explicitly requested serious pediatric demo contexts and a use-case-driven setup without changing the audio, overwriting user-owned fields or silently changing provider instructions.

**How to apply:** Keep scenario metadata separate from prompt text in sample setup and future provider integration. Sample prompt presets must be visible and editable; do not append metadata to provider system prompts or substitute scenario prompts into the fixed baseline.
