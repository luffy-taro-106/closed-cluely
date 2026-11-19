# Light and dark appearance

Use the sun/moon button in the top bar to switch appearance. It saves immediately, works during an answer, and restores after quitting or restarting. Existing profiles keep Dark until you choose Light. The compact view keeps the button available.

Light uses a white window, neutral gray controls, dark text, pale code boxes, subtle separators and no native outer shadow. Dark also has no outer border or native shadow, so its edge blends into dark pages. Settings, confirmations, account connections, errors, custom dropdowns and drag/drop feedback also follow the appearance. There is no background sampling or extra screen permission. It visually blends with white pages; the underlying page's text and colors still influence readability when opacity is reduced.

App opacity and code box opacity keep their independent values in either appearance. Use Light on white pages and adjust App opacity to taste. A low opacity fades text too; increase it when content underneath interferes. Code boxes retain their separate slider.

The native theme changes only Closed Cluely's controls and dialogs, not macOS or other apps. The initial theme is applied before styles paint, and the main process persists the preference. Switching appearance does not activate the window, cancel a request or re-send a question.

## Design research

- [Apple: Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) — each appearance needs appropriate colors throughout the interface.
- [Apple: Materials](https://developer.apple.com/design/human-interface-guidelines/materials) — transparency keeps context visible but must be balanced against text legibility.
- [W3C: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) — ordinary text needs at least 4.5:1 contrast. The light palette uses dark foregrounds rather than faint white-page camouflage text. Arbitrary backgrounds and user-selected transparency can reduce the resulting contrast.

## Verification — 30 October 2026

Version 2.5.1 passed 114 unit tests, 41 desktop checks with no skips or renderer console errors, and four packaged-app checks on Apple Silicon macOS. Appearance coverage includes changing during a streamed fixture answer without restarting it, white code boxes, independent code opacity, Settings and custom menus, renderer reload, fresh-process preference restoration, invalid input and failed disk saves. No paid AI request is used in these tests.

At full opacity, light body text on white measures 14.80:1, secondary text 6.17:1 and code text 14.18:1. These measurements are palette checks, not a guarantee for arbitrary backgrounds at reduced opacity.
