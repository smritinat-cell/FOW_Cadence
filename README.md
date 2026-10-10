# Accessibility Evaluation

Phase 1 implementation: application shell, navigation, and demo sample picker.

## Start the app

Run `npm start`. The app listens on port 5000.

Demo samples are discovered from JSON files in `demo-pack/`. Keep each sample's
JSON metadata there. The prototype's three recordings are served from the
original uploaded WAV files in `attached_assets/`; they are not duplicated into
the source tree. If no sample JSON files are present, the setup screen displays
three selectable placeholder cards.

These recordings are available in the workspace prototype only. Configure
Replit App Storage before publishing the audio; a storage bucket is not yet
configured for this project. WAV uploads are excluded from Git and publication.
The provided metadata leaves speech profiles, purposes, transcripts, and
reference material unspecified rather than inferring them from filenames.

Phase 1 does not make provider calls.
