'use strict';
const fs = require('fs');
const S = require('./sonlib.js');

// Build a synthetic six-port song by scattering CYBER's tracks across ports A-F,
// which forces more port/channel pairs than a MIDI file can hold.
const song = S.readSong(new Uint8Array(fs.readFileSync('CYBER.SON')), 'CYBER.SON');
let n = 0;
for (const p of song.patterns) for (const t of p.tracks) { t.port = n % 6; n += 1; }
const sel = S.selectionMap(song, true);
const warn = new S.Warnings();

const usage = S.channelUsage(song, sel, warn);
console.log('synthetic song: %d port/channel pairs across ports %s',
  usage.length, Array.from(new Set(usage.map((u) => S.portLetter(u.port)))).sort().join(''));
console.log('channelPlan returns:', S.channelPlan(song, sel), '(null means it cannot fit)');

// the greedy suggestion the UI offers
const order = usage.slice().sort((a, b) => b.notes - a.notes);
const assign = {}; const occ = [];
for (const u of order) {
  let placed = false;
  for (let c = 0; c < 16 && !placed; c += 1) if (!occ[c]) { occ[c] = [u]; assign[u.key] = c; placed = true; }
  if (placed) continue;
  let best = -1;
  for (let c = 0; c < 16 && best < 0; c += 1) if (!occ[c].some((o) => S.usageOverlaps(o, u))) best = c;
  if (best < 0) { best = 0; for (let c = 1; c < 16; c += 1)
    if (occ[c].reduce((s, o) => s + o.notes, 0) < occ[best].reduce((s, o) => s + o.notes, 0)) best = c; }
  occ[best].push(u); assign[u.key] = best;
}
let hard = 0, soft = 0;
for (let c = 0; c < 16; c += 1) {
  const g = occ[c] || [];
  for (let i = 0; i < g.length; i += 1) for (let j = i + 1; j < g.length; j += 1)
    (S.usageOverlaps(g[i], g[j]) ? hard : soft, S.usageOverlaps(g[i], g[j]) ? hard++ : soft++);
}
console.log('suggested assignment: %d unavoidable clashes, %d safe shares', hard, soft);

// manual render must keep all notes
const manual = S.renderWithAssignment(song, sel, warn, assign, 'synth');
const plain = S.renderArrangement(song, sel, warn, { remapChannels: false });
const countNotes = (b) => { let c = 0; for (let i = 0; i < b.length - 2; i += 1)
  if ((b[i] & 240) === 0x90 && b[i + 2] > 0 && b[i + 1] < 128) c += 1; return c; };
console.log('manual render: %d file(s), %d bytes', manual.length, manual[0].bytes.length);

// split render
const split = S.renderArrangementFiles(song, sel, warn, { strategy: 'split', base: 'synth' });
console.log('split render: %d files -> %s', split.length, split.map((f) => f.name.replace('synth_arrangement_', '')).join(' '));
const totalTracks = split.reduce((s, f) => {
  const dv = new DataView(f.bytes.buffer, f.bytes.byteOffset);
  return s + dv.getUint16(10) - 1; }, 0);
const dv0 = new DataView(plain.buffer);
console.log('tracks: %d across split files vs %d in the single file', totalTracks, dv0.getUint16(10) - 1);
console.log('warnings raised:', warn.items.map((w) => w.area + ': ' + w.message.slice(0, 60)));
