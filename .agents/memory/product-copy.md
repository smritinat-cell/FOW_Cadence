---
name: Product copy boundaries
description: Why the normal product avoids developer/process language and evaluation disclaimers.
---

Normal screens are for people at any company building a voice AI agent, not for developers inspecting this build. Avoid build-process and implementation language, model-review disclaimers, repeated agent-name headings, and explanations of what a screen does not do. Empty states should say what to do next; failures should be short, friendly, and actionable.

**Why:** The user explicitly requested a complete copy sweep on 2026-10-10 because internal language had repeatedly appeared in the product. This intentionally supersedes earlier requirements to display model-review disclaimers and measurement-unavailable panels.

**How to apply:** Keep technical records, diagnostics, raw responses, and unverified findings outside the main view. The later review-screen request permits these in a collapsed Run details area; additional developer content and fixed comparison examples remain in the unlinked `debug=1` mode. Normal Before & after shows only real stored runs, otherwise an action-oriented empty state. Copy changes alone do not authorize changing scoring mathematics, exposing credentials, automatically applying prompts, or starting paid calls without a click.
