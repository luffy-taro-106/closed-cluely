# Resilience in Closed Cluely 2.3.1

Updated 20 October 2026. These changes protect saved work and improve recovery. They do not make the app immune to Force Quit, administrators, repeated termination, shutdown, or hardware failure.

## Behavior

| Event | Result |
| --- | --- |
| Close overlay window | Existing behavior: hide to the menu bar; main process keeps running. |
| Ordinary Quit | Closed Cluely quits normally; a pending text checkpoint is flushed first. |
| Renderer crashes | Reload the UI within the existing retry limit. A healthy provider request continues in the main process, and the UI restores its current state. |
| Main process is killed | Its network connection and computation stop. Nothing relaunches it; the saved partial answer appears the next time you open the app. |
| Reopen after interrupted answer | With conversation restoration enabled, show the saved question and partial text as interrupted. Never send another provider request automatically. |
| Original question included an image | Show an attachment reminder. The recovery button copies the question into the composer so the owner can reattach the image before sending. |
| Disk write or file flush fails | Preserve the preceding committed file and report the save failure. Generation may continue, but unsaved work remains at risk. |
| User disables restoration or clears the current conversation | Remove its unfinished-answer checkpoint and cancel pending checkpoint writes. |
| User quits, logs out, or shuts down | Flush a pending text checkpoint when the event is received. |

## Data and resource use

The main process owns provider connections and the UI owns presentation. Renderer failures can therefore recover without another worker or Electron instance. Main-process termination still interrupts generation; moving the work to another killable process would not establish immunity to a privileged host controller.

`interrupted-work.enc` contains the submitted question, partial output, request identifier, provider/model, optional attachment name, and a hash identifying the completed conversation. It uses the same native encryption provider as saved history. It excludes API keys, image pixels, and unsent composer drafts. A context mismatch prevents restoration into a different conversation. A completed request identifier prevents duplication if termination happens after history commits but before checkpoint deletion.

Checkpoint at request start, approximately once per second while output arrives, and on completion/cancellation. There is no idle polling or new service. Under normal load this limits recent unsaved output to roughly the checkpoint interval; a blocked event loop, failed disk write, or unavailable encryption can extend that loss. Recovery uses the latest successful save. Turning off **Restore my conversation after reopening** disables checkpoint persistence.

Saves use unique exclusive temporary files, private permissions on macOS, a file flush, then atomic replacement. Failed writes do not overwrite the last committed save. Encrypted files remain encrypted in staging. Removing a saved file also removes its abandoned staging files. This is not a transactional backup system or a guarantee against power failure, storage corruption, account compromise, or root access. Images remain in memory and must be reattached after process loss.

## Verification

Local macOS checks performed on 20 October 2026:

- 52 unit/process tests passed, including failed flush/rename, an actual `SIGKILL` between staging and replacement, malformed data, checkpoint throttling, deletion, history opt-out, wrong-chat exclusion, and the history-commit race.
- 24 desktop checks passed: 22 interactive Electron checks plus a fresh-process encrypted-profile restore and confirmed Quit. Both completed history and an active provider request were checked across renderer crashes.
- `test:interruption` passed using two real Electron launches with a disposable profile and the native encryption provider. The first main process was killed with `SIGKILL` after checkpointing. The second displayed the partial answer and completed history, remained idle, required image reattachment, and deleted saved content on opt-out.
- Provider calls in these checks were mocked. No real question was sent to a provider. Only disposable test processes were terminated; the installed production app was not terminated or modified by these tests.

Run `npm test`, `npm run test:desktop`, and `npm run test:interruption` to repeat the checks. The host's Homebrew Node installation had a missing ICU library; these runs used the bundled working Node runtime without changing the host's Node installation.

## Remaining boundary

[Apple documents that SIGKILL cannot be blocked](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/sigaction.2.html). Closed Cluely does not try to survive termination and does not relaunch itself; it only preserves the encrypted partial answer for review when you next open it.

References: [Electron native storage](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron renderer process events](https://www.electronjs.org/docs/latest/api/web-contents#event-render-process-gone).
