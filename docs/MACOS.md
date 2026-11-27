# Closed Cluely on macOS

## Install from source

Install Node.js 22.12 or newer and Xcode Command Line Tools. Run `xcode-select --install` if the command line tools are missing.

```sh
git clone https://github.com/luffy-taro-106/closed-cluely.git
cd closed-cluely
npm ci
npm run pack:mac
```

On Apple silicon, the bundle is at `dist/mac-arm64/Closed Cluely.app`. Use `npm run build:mac` for an Apple silicon DMG or `npm run build:mac:all` to also build for Intel. The first build downloads Electron. If signing reports Finder metadata or a resource fork, build from a checkout outside synced folders.

Move **Closed Cluely.app** to Applications and open it. Use its menu bar icon, **F7**, or **⌘⌥Space** to show the overlay. To update, quit Closed Cluely and replace the app bundle in Applications. The existing profile lives in Application Support.

Local builds use ad hoc signing or your local signing identity. If macOS blocks a build you trust, check **System Settings → Privacy & Security** for **Open Anyway**.

## Permissions

| Permission | Needed for | When it is asked |
| --- | --- | --- |
| Microphone | Listening: the microphone **and** BlackHole or other loopback inputs | The first time you start listening |
| Screen & System Audio Recording | Screenshots only | The first screenshot |

Both can be opened from **Recording settings** or **Settings**. In **System Settings → Privacy & Security**, check **Microphone** for recording and **Screen & System Audio Recording** for screenshots. If you need to add the installed app manually, choose `/Applications/Closed Cluely.app`. Restart it after changing screen recording permission.

## Meeting audio with headphones

1. Connect your headphones and install [BlackHole 2ch](https://existential.audio/blackhole/).
2. In **Audio MIDI Setup**, create a **Multi-Output Device** and select both your headphones and **BlackHole 2ch**. Name it **Closed Cluely Meeting Audio** so it is easy to find. Use the headphones as the primary device and enable drift correction for BlackHole.
3. In the meeting app, choose **Closed Cluely Meeting Audio** as the speaker. Choose your headphones' microphone or the built-in microphone as the meeting mic. If the app only offers a system default speaker, also select the combined output in **System Settings → Sound → Output**.
4. In Closed Cluely, open **Recording settings**, choose **BlackHole 2ch** as **Audio input**, and select your speech-to-text model. Under **Settings**, connect an AI provider for suggested replies.
5. Play speech or ask someone to speak. Press **Start**, check the input meter, then press **Stop** to finish. The transcript panel shows recognized speech.

If the meter is flat, check that the meeting speaker still points to the combined output. Reconnecting Bluetooth headphones can change the system default.

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
