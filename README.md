# Closed Cluely 1.0

A private meeting assistant for macOS and Windows. It listens to the meeting, shows a live transcript, keeps your notes and slides on hand as context, and suggests what to say. Answers come from the same AI providers as OpenCluely.

Closed Cluely is built from OpenCluely Overlay 2.5.1. It keeps every OpenCluely feature except quit protection and automatic reopening, which were removed. Quitting Closed Cluely simply quits.

## What it does

- **Listens two ways.**
  - **Manual:** press **Start recording**, then **Stop**. The recording is transcribed and answered once.
  - **Automatic:** voice detection notices when someone starts and stops speaking. Each turn is transcribed as it ends, and an answer is suggested when the other side finishes.
- **Hears both sides.** "Them" is the meeting audio: through BlackHole on Mac, or Windows system audio or a virtual cable. "Me" is your microphone. Each source can be turned off.
- **Speech-to-text of your choice.**
  - **On-device, offline:** NVIDIA Parakeet TDT v2/v3, OpenAI Whisper (turbo, small, base, tiny) and Moonshine, through sherpa-onnx. Models download from inside the app.
  - **Cloud:** OpenAI (GPT Transcribe, GPT-4o Transcribe, Whisper), Groq (Whisper large-v3 / turbo), Deepgram (Nova-3), ElevenLabs (Scribe v2/v3) and AssemblyAI (Universal-3 Pro). Any provider model ID can also be entered as a custom model.
- **Meeting context box.**
  - **Contents:** type notes, or add PDF, PowerPoint (.pptx, including speaker notes), Word (.docx), text, Markdown, CSV or HTML files.
  - **Use:** text is extracted on your computer and sent with every question in the chat, together with the live transcript.
- **AI providers.** As in OpenCluely: Claude API key, Gemini, OpenAI API key, ChatGPT account, Codex account and Claude account. Each has its own model and reasoning-effort controls.
- **All OpenCluely features:**
  - an always-on-top overlay with screenshots and up to 10 images per question
  - click-through and compact views
  - separate app and code-box opacity, and light/dark mode
  - encrypted history, previous chats and export
  - interrupted-answer recovery
- **Hidden from screen capture** by default. See the limits below.

## Screen-capture visibility: read this

- **Windows:** the overlay uses `WDA_EXCLUDEFROMCAPTURE`. Screen sharing and recording show what is behind the overlay, not the overlay itself.
- **macOS:** hiding is **best effort only**. Apple provides no public API that hides a window from ScreenCaptureKit, which modern Zoom, Teams, Meet and macOS screen recording use. They can capture the overlay even with protection on. To keep it private on a Mac, do one of these:
  - share a single window or app, not the entire screen;
  - keep the overlay on a display you are not sharing.

Always check your meeting app's sharing preview.

## Quick start (Mac)

1. Install BlackHole 2ch (you already have it).
2. In **Audio MIDI Setup**, create a **Multi-Output Device** with your headphones or speakers *and* BlackHole 2ch. Select it as the Mac's sound output, or as the speaker in your meeting app. You keep hearing the call while Closed Cluely hears it too.
3. Open Closed Cluely, then the 🎙 **Listening settings**.
   - **Meeting audio:** leave it on *Auto-detect BlackHole*.
   - **Speech to text:** download a local model (Parakeet v2 for English), or paste a cloud key.
4. Open ⚙ **Settings** and connect an AI provider.
5. Optional: open 📄 **Meeting context** and add your notes or slides.
6. Press **Start recording** or **Start listening**, or use the shortcut **⌘⌥L**. macOS asks for Microphone permission once. BlackHole is an audio input, so it needs the same permission.

Full setup, including Windows: [docs/LISTENING.md](docs/LISTENING.md).

## Shortcuts

| Action | Mac | Windows |
| --- | --- | --- |
| Show / hide | ⌘⌥Space or F7 | Ctrl+Alt+Space or F7 |
| Start / stop listening | ⌘⌥L | Ctrl+Alt+L |
| Suggest a response now | ⌘⌥Return | Ctrl+Alt+Enter |
| Click-through | ⌘⌥I | Ctrl+Alt+I |
| Screenshot to question | ⌘⌥S or F6 | Ctrl+Alt+S or F6 |
| Screenshot to clipboard / paste | F8 / F9 | F8 / F9 |

## Privacy

- **Audio:** audio is processed in memory and never written to disk.
  - With a local model, audio never leaves your computer.
  - With a cloud speech provider, each detected speech segment goes to that provider.
- **Transcript and context:** these are stored encrypted (Keychain or Windows encryption) only while **Restore my conversation after reopening** is on.
- **Keys:** API keys are verified, then stored encrypted. They never reach the window's renderer.
- **Consent:** recording or transcribing other people may require their consent where you are. Check before you use automatic listening.

## Develop

Requires Node.js 22.12+ (24 recommended).

```sh
npm ci
npm start
npm test              # unit tests (no keys or network)
npm run test:desktop  # real window, mocked providers and transcription
npm run pack:mac      # dist/mac-arm64/Closed Cluely.app
npm run build:mac     # DMG + ZIP
npm run build:win     # NSIS installer + portable
```

## Further documentation

- [docs/LISTENING.md](docs/LISTENING.md): audio setup, listening modes, speech-to-text choices, and the voice-detection research.
- [docs/MACOS.md](docs/MACOS.md): notes specific to macOS.
- The provider guides carried over from OpenCluely:
  - [docs/MODELS-AND-KEYS.md](docs/MODELS-AND-KEYS.md)
  - [docs/CHATGPT-SIGN-IN.md](docs/CHATGPT-SIGN-IN.md)
  - [docs/CLAUDE-SIGN-IN.md](docs/CLAUDE-SIGN-IN.md)

Based on OpenCluely Overlay, [arth-agrawal/OpenCluely](https://github.com/arth-agrawal/OpenCluely) and [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely). Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
