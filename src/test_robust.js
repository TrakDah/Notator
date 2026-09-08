'use strict';
const fs = require('fs');
const S = require('./sonlib.js');
const good = new Uint8Array(fs.readFileSync('CYBER.SON'));

function attempt(name, bytes) {
  let line = '  ' + name.padEnd(34);
  try {
    const song = S.readSong(bytes, name);
    const warn = new S.Warnings();
    let exported = 0;
    try { exported = S.exportSources(song, warn).length; } catch (e) { line += ' EXPORT THREW: ' + e.message; }
    const sev = song.warnings.filter((w) => w.severity === 'severe').length;
    line += 'read ok | patterns ' + String(song.patterns.length).padStart(3) +
      ' | arr ' + String(song.arrangement.length).padStart(3) +
      ' | midis ' + String(exported).padStart(3) +
      ' | warnings ' + song.warnings.length + ' (' + sev + ' severe)';
    console.log(line);
    song.warnings.slice(0, 2).forEach((w) => console.log('        - [' + w.severity + '] ' + w.message.slice(0, 96)));
  } catch (e) {
    console.log(line + 'refused: ' + e.message.slice(0, 100));
  }
}

const mutate = (fn) => { const c = good.slice(); fn(c); return c; };

console.log('reference:');
attempt('CYBER.SON (untouched)', good);

console.log('\ndamaged versions of a real song:');
attempt('magic bytes changed', mutate((c) => { c[0] = 0x12; c[1] = 0x34; }));
attempt('truncated to 60%', good.slice(0, Math.floor(good.length * 0.6)));
attempt('truncated to 20%', good.slice(0, Math.floor(good.length * 0.2)));
attempt('pointer table zeroed', mutate((c) => { for (let i = 0x440; i < 0x440 + 2048; i++) c[i] = 0; }));
attempt('pointer table randomised', mutate((c) => {
  for (let i = 0x440; i < 0x440 + 2048; i++) c[i] = (i * 37) & 255; }));
attempt('arrangement pointer broken', mutate((c) => { c[0x40c] = 0xff; c[0x40d] = 0xff; }));
attempt('arrangement records corrupted', mutate((c) => {
  const p = (c[0x40c] << 24 | c[0x40d] << 16 | c[0x40e] << 8 | c[0x40f]) >>> 0;
  for (let i = p + 44 + 48; i < p + 44 + 96; i++) c[i] = 0x5a; }));
attempt('tempo field nonsense', mutate((c) => { c[6] = 0xff; c[7] = 0xff; }));
attempt('all track terminators wiped', mutate((c) => {
  for (let i = 0x1d40; i + 4 < c.length; i++) {
    if (c[i] === 0x7f && c[i + 1] === 0xff && c[i + 2] === 0xff && c[i + 3] === 0xff) c[i] = 0x7e; } }));

console.log('\nfiles that are not Notator songs:');
attempt('a MIDI file', new Uint8Array(fs.readFileSync('CYBER_Arrange_PROV.mid')));
attempt('random noise (52k)', Uint8Array.from({ length: 52026 }, () => Math.floor(Math.random() * 256)));
attempt('all zero bytes (52k)', new Uint8Array(52026));
attempt('tiny file (100 bytes)', new Uint8Array(100));
attempt('empty file', new Uint8Array(0));
