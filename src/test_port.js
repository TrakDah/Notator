'use strict';
const fs = require('fs');
const S = require('./sonlib.js');

function readSMF(buf) {
  const d = new Uint8Array(buf);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(...d.subarray(0, 4)) !== 'MThd') throw new Error('not smf');
  const count = dv.getUint16(10), ppq = dv.getUint16(12);
  let o = 14; const tracks = [];
  for (let n = 0; n < count; n += 1) {
    const len = dv.getUint32(o + 4);
    const raw = d.subarray(o + 8, o + 8 + len);
    o += 8 + len;
    let i = 0, tick = 0; const events = []; let name = null; const markers = [];
    const vlq = () => { let v = 0; for (;;) { const b = raw[i++]; v = (v << 7) | (b & 127); if (b < 128) return v; } };
    while (i < raw.length) {
      tick += vlq();
      const status = raw[i++];
      if (status === 255) {
        const kind = raw[i++]; const n2 = vlq();
        const payload = raw.subarray(i, i + n2); i += n2;
        if (kind === 3 && name === null) name = Buffer.from(payload).toString('utf8');
        if (kind === 6) markers.push([tick, Buffer.from(payload).toString('utf8')]);
        continue;
      }
      const nb = ((status & 240) === 0xc0 || (status & 240) === 0xd0) ? 1 : 2;
      events.push([tick, status, ...Array.from(raw.subarray(i, i + nb))]);
      i += nb;
    }
    tracks.push({ name, events, markers, end: tick });
  }
  return { ppq, tracks };
}

// Track names deliberately changed ('Chain X' -> 'Arr X', channel suffix), so
// compare event data separately from names.
const sig = (t) => t.events.map((e) => e.join(',')).join(';');
const norm = (n) => String(n).replace(/^Arr /, 'Chain ').replace(/ as ch [0-9/]+/, '');

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; } else { fail += 1; console.log('  FAIL ' + label + (detail ? ' :: ' + detail : '')); }
};

const bytes = new Uint8Array(fs.readFileSync('CYBER.SON'));
const warn = new S.Warnings();
const song = S.readSong(bytes, 'CYBER.SON');

console.log('parse: patterns=%d tracks=%d arrangement=%d stop=%d bpm=%d',
  song.patterns.length, song.patterns.reduce((s, p) => s + p.tracks.length, 0),
  song.arrangement.length, song.stop_tick, song.bpm_header);
console.log('warnings on reference file:', song.warnings.length);

// --- source patterns ---
const produced = S.exportSources(song, warn);
for (const f of produced) {
  const disk = 'source_patterns/' + f.name.split('/')[1];
  if (!fs.existsSync(disk)) { check(disk, false, 'python file missing'); continue; }
  const mine = readSMF(f.bytes), theirs = readSMF(fs.readFileSync(disk));
  check(disk + ' track count', mine.tracks.length === theirs.tracks.length,
    mine.tracks.length + ' vs ' + theirs.tracks.length);
  const a = mine.tracks.slice(1).map(sig).join('\n');
  const b = theirs.tracks.slice(1).map(sig).join('\n');
  check(disk + ' events', a === b);
}

// --- arrangement ---
const pyMap = JSON.parse(fs.readFileSync('CYBER_selection_EXPERIMENTAL.json', 'utf8'));
const myMap = S.selectionMap(song, true);
let mismatch = 0;
for (let i = 0; i < pyMap.entries.length; i += 1) {
  const p = pyMap.entries[i], m = myMap.entries[i];
  if (JSON.stringify(p.enabled_tracks) !== JSON.stringify(m.enabled_tracks)) mismatch += 1;
  if (p.candidate_mute_word !== m.candidate_mute_word) mismatch += 1;
}
check('mute hypothesis reproduces python map', mismatch === 0, mismatch + ' differing entries');

const rendered = S.renderArrangement(song, pyMap, warn, { remapChannels: false });
const mine = readSMF(rendered), theirs = readSMF(fs.readFileSync('CYBER_Arrange_PROV.mid'));
check('arrangement track count', mine.tracks.length === theirs.tracks.length,
  mine.tracks.length + ' vs ' + theirs.tracks.length);
const ma = mine.tracks.slice(1).map(sig), tb = theirs.tracks.slice(1).map(sig);
check('arrangement events', ma.join('\n') === tb.join('\n'),
  'first differing track: ' + (ma.findIndex((x, i) => x !== tb[i])));
check('arrangement track names', mine.tracks.slice(1).map((t) => norm(t.name)).join('|') ===
  theirs.tracks.slice(1).map((t) => t.name).join('|'));

// remapped variant must keep identical note data, only channels differ
const remapped = readSMF(S.renderArrangement(song, pyMap, warn, { remapChannels: true }));
check('remap preserves track count', remapped.tracks.length === mine.tracks.length);
let notesSame = true, chansChanged = 0;
for (let i = 1; i < remapped.tracks.length; i += 1) {
  const a = remapped.tracks[i].events, b = mine.tracks[i].events;
  if (a.length !== b.length) { notesSame = false; break; }
  for (let j = 0; j < a.length; j += 1) {
    if (a[j][0] !== b[j][0] || (a[j][1] & 240) !== (b[j][1] & 240) || a[j][2] !== b[j][2] || a[j][3] !== b[j][3]) notesSame = false;
    if ((a[j][1] & 15) !== (b[j][1] & 15)) chansChanged += 1;
  }
}
check('remap keeps every note, time and velocity', notesSame);
check('remap actually moved some channels', chansChanged > 0, String(chansChanged));
const used = new Set();
remapped.tracks.slice(1).forEach((t) => t.events.forEach((e) => used.add(e[1] & 15)));
check('remap fits inside 16 channels', used.size <= 16, 'used ' + used.size);
check('arrangement markers', JSON.stringify(mine.tracks[0].markers) === JSON.stringify(theirs.tracks[0].markers),
  'mine ' + mine.tracks[0].markers.length + ' vs ' + theirs.tracks[0].markers.length);
if (JSON.stringify(mine.tracks[0].markers) !== JSON.stringify(theirs.tracks[0].markers)) {
  for (let i = 0; i < 5; i += 1) {
    console.log('    mine  ', JSON.stringify(mine.tracks[0].markers[i]));
    console.log('    python', JSON.stringify(theirs.tracks[0].markers[i]));
  }
}
check('arrangement end tick', mine.tracks[0].end === theirs.tracks[0].end,
  mine.tracks[0].end + ' vs ' + theirs.tracks[0].end);

// --- zip sanity ---
const zip = S.makeZip([{ name: 'a.txt', bytes: new TextEncoder().encode('hello') }]);
fs.writeFileSync('/tmp/t.zip', zip);
console.log('\n%d passed, %d failed', pass, fail);
