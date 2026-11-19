'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { extractText, validateContext, publicContext, meetingPreamble, MAX_CONTEXT_CHARS } = require('../overlay/context');

// Writes a minimal ZIP (deflate) like an Office file.
function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(content)), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(content), 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(content), 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function minimalPdf(lines) {
  const stream = `BT /F1 18 Tf 72 720 Td ${lines.map((line, i) => `${i ? '0 -24 Td ' : ''}(${line}) Tj`).join(' ')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'closedcluely-context-test-'));
test.after(() => fs.rmSync(folder, { recursive: true, force: true }));

test('PowerPoint slides and speaker notes are extracted in slide order', async () => {
  const slide = text => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>Second &amp; line</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const file = path.join(folder, 'deck.pptx');
  fs.writeFileSync(file, zip({ '[Content_Types].xml': '<Types/>', 'ppt/slides/slide10.xml': slide('Roadmap'), 'ppt/slides/slide2.xml': slide('Q3 revenue grew 14%'),
    'ppt/notesSlides/notesSlide2.xml': '<p:notes><a:p><a:r><a:t>Mention the EU launch</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>' }));
  const text = await extractText(file);
  assert.ok(text.indexOf('[Slide 2]') < text.indexOf('[Slide 10]'));
  assert.match(text, /Q3 revenue grew 14%\nSecond & line/);
  assert.match(text, /Speaker notes: Mention the EU launch$/m);
});

test('Word paragraphs, text, Markdown and HTML are extracted', async () => {
  const docx = path.join(folder, 'brief.docx');
  fs.writeFileSync(docx, zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Agenda</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Budget </w:t></w:r><w:r><w:t>review</w:t></w:r></w:p></w:body></w:document>' }));
  assert.equal(await extractText(docx), 'Agenda\nBudget review');
  fs.writeFileSync(path.join(folder, 'notes.md'), '# Talking points\r\n\r\n\r\n\r\n- Hiring plan   \n');
  assert.equal(await extractText(path.join(folder, 'notes.md')), '# Talking points\n\n- Hiring plan');
  fs.writeFileSync(path.join(folder, 'page.html'), '<style>p{}</style><p>Hello <b>team</b></p><script>alert(1)</script>');
  assert.equal(await extractText(path.join(folder, 'page.html')), 'Hello team');
});

test('PDF text is extracted with page markers', async () => {
  const file = path.join(folder, 'agenda.pdf');
  fs.writeFileSync(file, minimalPdf(['Meeting agenda', 'Item one budget']));
  const text = await extractText(file);
  assert.match(text, /^\[Page 1\]/); assert.match(text, /Meeting agenda/); assert.match(text, /Item one budget/);
});

test('unsupported, empty and damaged files are rejected with clear messages', async () => {
  fs.writeFileSync(path.join(folder, 'tool.exe'), 'x');
  await assert.rejects(extractText(path.join(folder, 'tool.exe')), /Add \.txt/);
  fs.writeFileSync(path.join(folder, 'empty.txt'), '   ');
  await assert.rejects(extractText(path.join(folder, 'empty.txt')), /no readable text/);
  fs.writeFileSync(path.join(folder, 'broken.pptx'), 'not a zip');
  await assert.rejects(extractText(path.join(folder, 'broken.pptx')), /damaged/);
});

test('the preamble carries notes, files and transcript, bounded in size', () => {
  const context = validateContext({ notes: 'My goal: approve the hiring plan.', files: [{ id: '1', name: 'deck.pptx', text: 'Slide text' }, { id: '2', name: 'huge.txt', text: 'x'.repeat(MAX_CONTEXT_CHARS + 50) }] });
  const preamble = meetingPreamble(context, 'Them: What is the budget?');
  assert.match(preamble, /<meeting_context>[\s\S]*## My notes\nMy goal[\s\S]*## deck\.pptx\nSlide text[\s\S]*\[Truncated\][\s\S]*<\/meeting_context>/);
  assert.match(preamble, /<live_transcript>[\s\S]*Them: What is the budget\?[\s\S]*<\/live_transcript>/);
  assert.ok(preamble.length < MAX_CONTEXT_CHARS + 2000);
  assert.equal(meetingPreamble(validateContext(null), ''), '');
  assert.deepEqual(publicContext(context).files.map(file => file.name), ['deck.pptx', 'huge.txt']);
  assert.equal('text' in publicContext(context).files[0], false, 'The renderer receives sizes, not full text');
});
