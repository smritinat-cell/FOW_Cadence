---
name: App Storage readiness
description: Why default-client initialization is not proof that durable media storage is configured
---

An App Storage client can be constructed even when the project has no configured default bucket. Confirm bucket readiness before treating uploads as available.

**Why:** The SDK initialized successfully here, but its first upload failed with “A bucket name is needed to use Cloud Storage.” Default-bucket selection is not bucket provisioning.

**How to apply:** For future durable media setup, configure and verify a bucket through App Storage before migrating prototype uploads. If prototype files are used temporarily, make that source explicit and keep large binaries out of Git and publication.
