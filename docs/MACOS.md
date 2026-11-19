# Closed Cluely on macOS

## Open the app

- **Build:** run `npm run pack:mac` for `dist/mac-arm64/Closed Cluely.app`, or `npm run build:mac` for a DMG.
- **Install:** move the app to Applications, then open it. A small star appears in the menu bar. There is no Dock icon.
- **Signing:** local builds are signed with your local signing identity, or ad hoc. They are not notarized. If macOS blocks a build you trust, use **Privacy & Security → Open Anyway**.

## Permissions

| Permission | Needed for | When it is asked |
| --- | --- | --- |
| Microphone | Listening: the microphone **and** BlackHole or other loopback inputs | The first time you start listening |
| Screen & System Audio Recording | Screenshots only | The first screenshot |

Both can be opened from Listening settings or Settings. Restart the app after changing Screen Recording.

## Hiding from screen sharing

**Request capture protection** uses the only window-level control macOS offers. ScreenCaptureKit-based recorders and meeting apps can still capture the overlay; Apple provides no public API that prevents this. To stay private on a Mac:

- share a single window or app, not the entire screen; or
- keep the overlay on a display you are not sharing.

Check the sharing preview in your meeting app.

## Quitting and startup

Closed Cluely has no quit protection and no automatic reopening. **Quit Closed Cluely**, ⌘Q, Force Quit and logout all end it normally, and nothing relaunches it. The **Start in menu bar when I sign in** login item stays an opt-in setting.

## Saved data

Data lives in `~/Library/Application Support/Closed Cluely`:

- preferences;
- encrypted API keys (chat and speech-to-text);
- optionally, encrypted conversations, transcript and meeting context;
- downloaded speech models, in `stt-models`.

Audio and image pixels are never saved.

## Shortcuts

⌘⌥Space or F7 shows and hides the overlay, and ⌘⌥L starts or stops listening. ⌘⌥Return suggests a response, ⌘⌥I toggles click-through, ⌘⌥S or F6 takes a screenshot, and F8 / F9 copy a screenshot to the clipboard and paste it. Escape hides the overlay.
