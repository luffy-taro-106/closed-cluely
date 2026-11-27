'use strict';

(() => {
  const displayDelimiters = [['$$', '$$'], ['\\[', '\\]']];
  const inlineDelimiters = [['\\(', '\\)'], ['$', '$']];
  const expressionLimit = 6000;

  function readDelimited(source, delimiters, singleLine = false) {
    for (const [open, close] of delimiters) {
      if (!source.startsWith(open) || (open === '$' && source.startsWith('$$'))) continue;
      let depth = 0;
      for (let index = open.length; index < Math.min(source.length, expressionLimit); index++) {
        if (singleLine && source[index] === '\n') break;
        if (depth === 0 && source.startsWith(close, index)) {
          const expression = source.slice(open.length, index);
          const end = index + close.length;
          if (!expression.trim()) break;
          // Keep dollar amounts such as "$20 and $30" as ordinary text.
          if (open === '$' && (/^\s|\s$/.test(expression) || /^[0-9$]/.test(source.slice(end, end + 1)))) break;
          return { raw: source.slice(0, end), expression: expression.trim() };
        }
        if (source[index] === '\\') index++;
        else if (source[index] === '{') depth++;
        else if (source[index] === '}') depth--;
      }
    }
  }

  function groupEnd(source, start) {
    if (source[start] !== '{') return -1;
    let depth = 1;
    for (let index = start + 1; index < Math.min(source.length, expressionLimit); index++) {
      const character = source[index];
      if (character === '\n') break;
      if (character === '\\') index++;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) return index + 1;
    }
    return -1;
  }

  function readFraction(source) {
    const command = /^\\[dt]?frac[ \t]*/.exec(source);
    if (!command) return;
    const numeratorEnd = groupEnd(source, command[0].length);
    if (numeratorEnd < 0) return;
    const spaces = /^[ \t]*/.exec(source.slice(numeratorEnd))[0].length;
    const denominatorEnd = groupEnd(source, numeratorEnd + spaces);
    if (denominatorEnd < 0) return;
    const raw = source.slice(0, denominatorEnd);
    return { raw, expression: raw };
  }

  function render(token, displayMode) {
    const element = displayMode ? 'div' : 'span';
    try {
      // Chromium lays out MathML directly, so the Markdown sanitizer and CSP
      // can keep blocking inline styles and external resources.
      const math = katex.renderToString(token.expression, {
        output: 'mathml', displayMode, trust: false, maxExpand: 100
      });
      return `<${element} class="answer-math${displayMode ? ' answer-math-block' : ''}">${math}</${element}>`;
    } catch {
      const fallback = document.createElement('span');
      fallback.textContent = token.raw;
      return fallback.innerHTML;
    }
  }

  const answerMarkdown = new marked.Marked({ breaks: true, gfm: true });
  answerMarkdown.use({ extensions: [
    {
      name: 'answerMathBlock', level: 'block',
      start(source) {
        const line = /(?:^|\n)(?=\$\$|\\\[)/.exec(source);
        if (line) return line.index + line[0].length;
      },
      tokenizer(source) {
        const match = readDelimited(source, displayDelimiters);
        const trailing = match && /^[ \t]*(?:\n|$)/.exec(source.slice(match.raw.length));
        if (trailing) return { ...match, raw: match.raw + trailing[0], type: 'answerMathBlock' };
      },
      renderer: token => render(token, true)
    },
    {
      name: 'answerMathInline', level: 'inline',
      start(source) { return /\$|\\(?:\(|\[|[dt]?frac\b)/.exec(source)?.index; },
      tokenizer(source) {
        const match = readDelimited(source, displayDelimiters, true) ||
          readDelimited(source, inlineDelimiters, true) || readFraction(source);
        if (match) return { ...match, type: 'answerMathInline' };
      },
      renderer: token => render(token, false)
    }
  ] });
  window.answerMarkdown = answerMarkdown;
})();
