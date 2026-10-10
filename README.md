# Speech Prompt Lab

Phase 1 implementation: application shell, navigation, and demo sample picker.

## Start the app

Run `npm start`. The app listens on port 5000.

Demo samples are discovered from JSON files in `demo-pack/`. Keep each sample's
JSON and audio asset in that directory; the JSON can refer to its audio with
`audio_file`, `audio_path`, `audio_filename`, or `audio_url`. If no sample JSON
files are present, the setup screen displays three selectable placeholder cards.

This phase does not make provider calls.
