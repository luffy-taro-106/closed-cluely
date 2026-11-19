'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeTheme } = require('electron');

exports.run = async ({ runtime, win, js, until, delay, work }) => {
  const original = { ...runtime.currentState().settings };
  let finish;
  const previousAnswer = runtime.setAnswerFunction(async ({ onDelta }) => {
    const text = 'A readable answer on a white page.\n\n```javascript\nconst appearance = "light";\n```';
    onDelta(text);
    await new Promise(resolve => { finish = resolve; });
    return { text, truncated: false };
  });
  const choose = async theme => {
    if (runtime.currentState().settings.theme !== theme) await js('document.getElementById("themeButton").click()');
    await until(async () => runtime.currentState().settings.theme === theme && await js(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && !document.getElementById('themeButton').disabled`));
    assert.equal(runtime.store.read('preferences.json', {}).theme, theme);
    assert.equal(nativeTheme.themeSource, theme);
  };
  try {
    await runtime.ask({ text: 'Appearance fixture' });
    await until(() => !!finish);
    await until(async () => await js('!!document.querySelector(".message:last-child pre")'));
    const request = runtime.currentState().active.id;
    for (const theme of ['light', 'dark', 'light']) {
      await choose(theme);
      assert.equal(runtime.currentState().busy, true);
      assert.equal(runtime.currentState().active.id, request, 'Changing appearance must not restart the answer');
      assert.equal(runtime.currentState().settings.opacity, original.opacity);
      assert.equal(runtime.currentState().settings.codeOpacity, original.codeOpacity);
      const styles = await js(`(() => {
        const style = selector => getComputedStyle(document.querySelector(selector));
        const pre = document.querySelector('.message:last-child pre');
        let inherited = 1; for (let node=pre.parentElement;node;node=node.parentElement) inherited *= Number(getComputedStyle(node).opacity);
        return { scheme:style('html').colorScheme, background:style('#appBackdrop').backgroundColor, code: getComputedStyle(pre).backgroundColor,
          codeOpacity:Number(getComputedStyle(pre).opacity), inherited, text:style('body').color, pressed:document.getElementById('themeButton').getAttribute('aria-pressed'),
          overflow:document.documentElement.scrollWidth > innerWidth };
      })()`);
      assert.equal(styles.scheme, theme);
      assert.equal(styles.pressed, String(theme === 'light'));
      assert.equal(styles.overflow, false);
      assert.equal(styles.codeOpacity, original.codeOpacity); assert.equal(styles.inherited, 1);
      if (theme === 'light') {
        assert.equal(styles.background, 'rgb(255, 255, 255)');
        assert.equal(styles.code, 'rgb(250, 250, 250)');
        assert.equal(styles.text, 'rgb(37, 40, 44)');
        assert.equal(win.hasShadow(), false);
      }
    }
    finish(); await until(() => !runtime.currentState().busy);
    await js('document.getElementById("settingsButton").click()');
    assert.equal(await js('getComputedStyle(document.getElementById("settingsDialog")).backgroundColor'), 'rgb(255, 255, 255)');
    await js('document.getElementById("settingsProvider").previousElementSibling?.blur(); document.querySelector("[data-select-id=settingsProvider]").click()');
    assert.equal(await js('getComputedStyle(document.querySelector(".overlay-select-list:popover-open")).backgroundColor'), 'rgb(255, 255, 255)');
    await js('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true})); document.getElementById("closeSettings").click()');

    // Renderer reload exercises the before-paint cache as well as IPC restoration.
    win.reload();
    await until(async () => await js('!!window.overlay && document.documentElement.dataset.theme === "light" && document.getElementById("themeButton").getAttribute("aria-pressed") === "true"'));
    const rejected = await js('window.overlay.setTheme("invalid")');
    assert.equal(rejected.ok, false); assert.equal(runtime.currentState().settings.theme, 'light');
    const write = runtime.store.write.bind(runtime.store);
    runtime.store.write = () => { throw new Error('Appearance disk fixture failure'); };
    try { assert.equal((await js('window.overlay.setTheme("dark")')).ok, false); }
    finally { runtime.store.write = write; }
    assert.equal(runtime.currentState().settings.theme, 'light', 'Failed saves must leave appearance unchanged');

    // Capture only disposable fixture content. No user screenshots or AI calls.
    runtime.showOverlay(false); win.setContentProtection(false);
    for (const theme of ['light', 'dark']) {
      await choose(theme); await delay(220);
      fs.writeFileSync(path.join(work, `Appearance-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await choose('light');
  } finally {
    finish?.();
    if (runtime.currentState().busy) { runtime.cancel(); await until(() => !runtime.currentState().busy); }
    runtime.setAnswerFunction(previousAnswer);
    await js('document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close());document.querySelectorAll(":popover-open").forEach(popover=>popover.hidePopover())');
    win.setContentProtection(original.hideFromCapture);
    runtime.hideOverlay();
  }
};
