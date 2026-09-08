'use strict';
/* Notator/Creator .SON reader + SMF writer.
   Ported from the CYBER.SON research profile (son_recovery.py).
   Best-effort mode: structural surprises become warnings, not aborts.
   No dependencies. Runs in a browser or in Node. */

const PPQ = 192;
const ORIGIN = 7680;
const POINTER_TABLE = 0x440;
const PATTERN_NAMES = 0x21be;
const ARRANGE_POINTER = 0x40c;
const MIN_TRACK_POINTER = 0x1d40;
const MAX_PATTERNS = 100;
const TRACKS_PER_PATTERN = 16;

const CP437_HIGH =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5' +
  '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229' +
  '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';

// ---------------------------------------------------------------- primitives

const u16 = (d, o) => (d[o] << 8) | d[o + 1];
const u32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
const signed = (v) => (v < 128 ? v : v - 256);

function label(bytes) {
  let out = '';
  for (const b of bytes) {
    if (b === 0) break;
    out += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128];
  }
  return out.trim();
}

function matchesBoundary(d, o) {
  if (o + 4 > d.length) return false;
  const a = d[o], b = d[o + 1], c = d[o + 2], e = d[o + 3];
  return (a === 0x7f && b === 0xff && c === 0xff && e === 0xff) ||
         (a === 0x00 && b === 0x0f && c === 0xff && e === 0xff);
}

const storedTick = (d, o) => (((d[o + 1] & 15) << 16) | u16(d, o + 2));

class Warnings {
  constructor() { this.items = []; }
  add(severity, area, message) {
    const key = severity + '|' + area + '|' + message;
    const seen = this.items.find((w) => w.key === key);
    if (seen) { seen.count += 1; return; }
    this.items.push({ key, severity, area, message, count: 1 });
  }
  get worst() {
    if (this.items.some((w) => w.severity === 'severe')) return 'severe';
    if (this.items.length) return 'caution';
    return 'clean';
  }
}

// -------------------------------------------------------------------- reader

function readTrack(data, pointer, warn) {
  if (pointer < MIN_TRACK_POINTER || pointer + 44 > data.length) return null;
  const header = data.subarray(pointer, pointer + 22);
  const name = data.subarray(pointer + 22, pointer + 30);
  const records = [];
  let pos = pointer + 44;
  let closed = false;
  while (pos + 4 <= data.length) {
    if (matchesBoundary(data, pos)) { closed = true; break; }
    if (pos + 6 > data.length) break;
    const raw = data.subarray(pos, pos + 6);
    records.push({
      offset: pos,
      raw: Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join(''),
      continuation: Boolean(raw[0] & 128),
      kind: raw[1] & 240,
      tick: storedTick(data, pos) - ORIGIN,
      data1: raw[0] & 127,
      value: raw[4] >> 1,
      original_channel: raw[5] & 15,
    });
    pos += 6;
  }
  if (!closed) {
    warn.add('severe', 'track data',
      'A track ran to the end of the file without a terminator. Its events may be truncated or invented.');
  }
  const code = header[3];
  const loopBeats = u16(header, 18);
  const markers = records
    .filter((r) => !r.continuation && r.kind === 0x40 && (parseInt(r.raw.slice(10, 12), 16) & 15) === 0)
    .map((r) => r.tick);
  if (loopBeats && !(markers.length === 1 && markers[0] === loopBeats * PPQ)) {
    warn.add('severe', 'loop length',
      'A track header claims a loop length its own loop marker disagrees with. Repeats of that track are unreliable.');
  }
  return {
    pointer,
    end_offset: pos,
    name: label(name),
    name_raw: Array.from(name, (b) => b.toString(16).padStart(2, '0')).join(''),
    header_raw: Array.from(header, (b) => b.toString(16).padStart(2, '0')).join(''),
    port: code >> 5,
    channel_override: (code & 31) ? (code & 31) - 1 : null,
    transpose: signed(header[5]),
    velocity_offset: signed(header[6]),
    compression_code_unverified: header[7],
    quantize_code_unverified: header[4],
    loop_beats: loopBeats,
    records,
  };
}

function readSong(bytes, filename) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const warn = new Warnings();
  if (data.length < PATTERN_NAMES + 800) {
    throw new Error('This file is too small to be a Notator song. It is ' + data.length +
      ' bytes; the layout needs at least ' + (PATTERN_NAMES + 800) + '.');
  }
  const magic = (data[0] << 8) | data[1];
  if (magic !== 0x3b9e) {
    warn.add('severe', 'file identity',
      'The first two bytes are 0x' + magic.toString(16).padStart(4, '0') +
      ', not the 0x3b9e seen in the reference song. This is probably a different Notator version, and every offset below is a guess.');
  }

  const patterns = [];
  const cache = new Map();
  let badPointers = 0;
  for (let p = 0; p < MAX_PATTERNS; p += 1) {
    const tracks = [];
    for (let t = 0; t < TRACKS_PER_PATTERN; t += 1) {
      const at = POINTER_TABLE + p * 64 + t * 4;
      if (at + 4 > data.length) break;
      const pointer = u32(data, at);
      if (!cache.has(pointer)) cache.set(pointer, readTrack(data, pointer, warn));
      const source = cache.get(pointer);
      if (source === null) { if (pointer !== 0) badPointers += 1; continue; }
      if (source.records.length) tracks.push(Object.assign({}, source, { number: t + 1 }));
    }
    if (tracks.length) {
      patterns.push({
        number: p,
        name: label(data.subarray(PATTERN_NAMES + p * 8, PATTERN_NAMES + p * 8 + 8)),
        tracks,
      });
    }
  }
  if (badPointers) {
    warn.add('severe', 'pattern table',
      badPointers + ' track pointer(s) fell outside the file. Those tracks were dropped; the pattern table may sit at a different offset in this version.');
  }
  if (!patterns.length) {
    throw new Error('No readable patterns were found. The pattern pointer table is not at 0x440 in this file, so nothing can be decoded from it yet.');
  }

  const arrangement = [];
  let stop = null;
  const arrangePointer = u32(data, ARRANGE_POINTER);
  if (arrangePointer < MIN_TRACK_POINTER || arrangePointer + 44 > data.length) {
    warn.add('severe', 'arrangement',
      'The arrangement pointer at 0x40c does not land inside the file. No arrangement was read; only patterns can be exported.');
  } else {
    let pos = arrangePointer + 44;
    while (pos + 24 <= data.length && !matchesBoundary(data, pos)) {
      const raw = data.subarray(pos, pos + 24);
      if ((raw[1] & 240) !== 0x30 || raw[5] > 3) {
        warn.add('severe', 'arrangement',
          'An arrangement record at offset 0x' + pos.toString(16) +
          ' has an unexpected shape. Reading stopped there, so the arrangement is incomplete.');
        break;
      }
      if (!(raw[6] & 128) || !(raw[12] & 128) || !(raw[18] & 128)) {
        warn.add('caution', 'arrangement',
          'An arrangement record is missing its continuation markers. Its mute bits are especially doubtful.');
      }
      const pattern = raw[0];
      const tick = storedTick(data, pos) - ORIGIN;
      if (pattern === 0 && stop === null) stop = tick;
      arrangement.push({
        index: arrangement.length,
        offset: pos,
        raw: Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join(''),
        pattern,
        pattern_name: label(data.subarray(PATTERN_NAMES + pattern * 8, PATTERN_NAMES + pattern * 8 + 8)),
        chain: 'ABCD'[raw[5]],
        tick,
        bar_assuming_4_4: 1 + tick / 768,
        source_offset_assumed: (u16(raw, 8) | ((raw[7] & 15) << 16)) - ORIGIN,
        unresolved_fields: { byte6: raw[6], byte7: raw[7], word10_11: u16(raw, 10) },
        enabled_tracks: null,
      });
      pos += 24;
    }
  }

  if (stop === null && arrangement.length) {
    const last = Math.max(...arrangement.map((e) => e.tick));
    stop = last + 768;
    warn.add('severe', 'song end',
      'No explicit stop marker was found. The song end was assumed to be one bar after the last arrangement entry, which is a guess.');
  }

  const bpm = u16(data, 6);
  if (bpm < 20 || bpm > 400) {
    warn.add('caution', 'tempo',
      'The stored tempo reads as ' + bpm + ' BPM, which is outside the plausible range. Exports use 120 BPM instead.');
  }

  const severe = warn.items.filter((w) => w.severity === 'severe').length;
  let confidence = 'high';
  if (magic !== 0x3b9e) confidence = 'doubtful';
  else if (severe) confidence = 'partial';

  return {
    format_profile: 'CYBER.SON research profile v0.2 (best-effort)',
    status: 'INCOMPLETE: arrangement mute bit packing is unverified',
    confidence,
    source_name: filename || 'unknown.SON',
    size_bytes: data.length,
    bpm_header: bpm,
    bpm_used: (bpm < 20 || bpm > 400) ? 120 : bpm,
    ppq_assumed: PPQ,
    ticks_per_bar_header: u16(data, 0x22),
    stored_tick_origin_assumed: ORIGIN,
    stop_tick: stop,
    patterns,
    arrangement,
    warnings: warn.items.map(({ severity, area, message, count }) => ({ severity, area, message, count })),
    limitations: [
      'No verified decoding of all sixteen arrangement mute bits.',
      'Track quantization, groove, compression, filters and fine timing are not implemented.',
      'MIDI conversion uses stored timestamps; channel, transpose and velocity offset are inferred.',
      'Source offsets and note releases at chain transitions need comparison with original playback.',
      'Original hardware sounds and sampler contents are not present as audio.',
    ],
  };
}

// --------------------------------------------------------------- SMF writing

function vlq(n) {
  if (!(n >= 0 && n <= 0x0fffffff)) throw new Error('Invalid MIDI delta time ' + n);
  const out = [n & 127];
  let v = n;
  while (v >> 7) { v >>= 7; out.push(128 | (v & 127)); }
  return out.reverse();
}

const meta = (kind, payload) => [255, kind, ...vlq(payload.length), ...payload];
const textMeta = (kind, text) => meta(kind, Array.from(new TextEncoder().encode(text)));

function routeName(track) {
  const ch = track.channel_override;
  return 'MIDI ' + String.fromCharCode(65 + track.port) + (ch !== null ? String(ch + 1) : ':original');
}

function midiChunk(events, endTick) {
  const ordered = events.map((e, i) => [e[0], e[1], i])
    .sort((a, b) => (a[0] - b[0]) || (a[2] - b[2]));
  const body = [];
  let previous = 0;
  for (const [tick, message] of ordered) {
    if (tick < 0) throw new Error('Negative MIDI timestamp');
    body.push(...vlq(tick - previous), ...message);
    previous = tick;
  }
  body.push(...vlq(Math.max(previous, endTick) - previous), ...meta(47, []));
  const out = new Uint8Array(8 + body.length);
  out.set([0x4d, 0x54, 0x72, 0x6b], 0);
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 8);
  return out;
}

function writeMidi(title, tracks, bpm, endTick, markers, notes) {
  const conductor = [
    [0, textMeta(3, title)],
    [0, textMeta(1, 'Research export; timing and mutes are provisional')],
    [0, meta(81, [...new Uint8Array(new Uint32Array([Math.round(60000000 / bpm)]).buffer).reverse().slice(1)])],
    [0, meta(88, [4, 2, 24, 8])],
  ];
  for (const line of (notes || [])) conductor.push([0, textMeta(1, line)]);
  for (const [tick, name] of (markers || [])) conductor.push([tick, textMeta(6, name)]);
  const chunks = [midiChunk(conductor, endTick)];
  for (const [name, port, events] of tracks) {
    chunks.push(midiChunk([[0, textMeta(3, name)], [0, meta(33, [port])], ...events], endTick));
  }
  const head = new Uint8Array(14);
  head.set([0x4d, 0x54, 0x68, 0x64], 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 6); dv.setUint16(8, 1); dv.setUint16(10, chunks.length); dv.setUint16(12, PPQ);
  const total = 14 + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(head, 0);
  let at = 14;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ------------------------------------------------------------ event shaping

function trackEvents(track, warn) {
  const events = [];
  for (const record of track.records) {
    if (record.continuation) continue;
    let kind = record.kind;
    const rawByte5 = parseInt(record.raw.slice(10, 12), 16);
    if (kind === 0x40 && (rawByte5 & 15) === 0) continue;
    let channel = track.channel_override;
    if (channel === null) channel = record.original_channel;
    if (!(channel >= 0 && channel < 16)) {
      if (warn) warn.add('severe', 'channels', 'A track produced an out-of-range MIDI channel. Those events were dropped.');
      continue;
    }
    if (kind !== 0x80 && kind !== 0x90 && kind !== 0xb0) {
      if (warn) {
        warn.add('caution', 'event types',
          'Event type 0x' + kind.toString(16) + ' is not understood and was left out of the MIDI. Nothing was guessed in its place.');
      }
      continue;
    }
    let first = record.data1;
    let second = record.value;
    if (kind === 0x80 || kind === 0x90) {
      first += track.transpose;
      if (first < 0 || first > 127) {
        if (warn) warn.add('severe', 'transpose', 'A track transpose pushed notes outside the MIDI range. Those notes were dropped.');
        continue;
      }
      if (kind === 0x80 || second === 0) { kind = 0x80; second = 0; }
      else second = Math.max(1, Math.min(127, second + track.velocity_offset));
    }
    events.push([record.tick, [kind | channel, first, second]]);
  }
  return events.map((e, i) => [e[0], e[1], i]).sort((a, b) => (a[0] - b[0]) || (a[2] - b[2]))
    .map(([t, m]) => [t, m]);
}

function placeTrack(track, sourceStart, duration, warn) {
  const source = trackEvents(track, warn);
  const loop = track.loop_beats * PPQ;
  const candidates = [];
  if (loop) {
    const firstCycle = Math.max(0, Math.floor(sourceStart / loop));
    const lastCycle = Math.floor((sourceStart + duration) / loop);
    for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
      for (const [tick, message] of source) {
        if (!(tick >= 0 && tick < loop)) continue;
        const position = cycle * loop + tick - sourceStart;
        if (position >= 0 && position < duration) candidates.push([position, message]);
      }
      const boundary = (cycle + 1) * loop - sourceStart;
      if (boundary > 0 && boundary < duration) candidates.push([boundary, null]);
    }
  } else {
    for (const [tick, message] of source) {
      const position = tick - sourceStart;
      if (position >= 0 && position < duration) candidates.push([position, message]);
    }
  }
  candidates.push([duration, null]);
  const ordered = candidates.map((c, i) => [c[0], c[1], i])
    .sort((a, b) => (a[0] - b[0]) || ((a[1] !== null) - (b[1] !== null)) || (a[2] - b[2]));
  const active = new Map();
  const result = [];
  for (const [tick, message] of ordered) {
    if (message === null) {
      for (const key of Array.from(active.keys()).sort()) {
        const [channel, note] = key.split(':').map(Number);
        for (let i = 0; i < active.get(key); i += 1) result.push([tick, [0x80 | channel, note, 0]]);
      }
      active.clear();
      continue;
    }
    const kind = message[0] & 240, channel = message[0] & 15, note = message[1];
    const key = channel + ':' + note;
    if (kind === 0x90) active.set(key, (active.get(key) || 0) + 1);
    else if (kind === 0x80) {
      if (!active.get(key)) continue;
      const left = active.get(key) - 1;
      if (left === 0) active.delete(key); else active.set(key, left);
    }
    result.push([tick, message]);
  }
  return result;
}

// ----------------------------------------------------------------- exporters

function exportSources(song, warn) {
  const files = [];
  for (const pattern of song.patterns) {
    const tracks = [];
    let endTick = 0;
    for (const track of pattern.tracks) {
      const source = trackEvents(track, warn);
      const duration = (source.length ? Math.max(...source.map((e) => e[0])) : 0) + 1;
      const unlooped = Object.assign({}, track, { loop_beats: 0 });
      tracks.push([
        'T' + String(track.number).padStart(2, '0') + ' ' + track.name + ' [' + routeName(track) + ']',
        track.port,
        placeTrack(unlooped, 0, duration, warn),
      ]);
      endTick = Math.max(endTick, duration);
    }
    const safe = pattern.name.replace(/ /g, '_').replace(/:/g, '').replace(/[\\/*?"<>|]/g, '');
    files.push({
      name: 'source_patterns/P' + String(pattern.number).padStart(2, '0') + '_' + safe + '_SOURCE.mid',
      bytes: writeMidi('SOURCE PATTERN: all stored variants, not arrangement', tracks, song.bpm_used, endTick, []),
    });
  }
  return files;
}

const MUTE_FORMULA = 'b[10]&127 << 8 | b[11]&127 | (b[6]&1) << 7 | (b[6]&2) << 14';

function muteWord(raw) {
  return ((raw[10] & 127) << 8) | (raw[11] & 127) | ((raw[6] & 1) << 7) | ((raw[6] & 2) << 14);
}

function selectionMap(song, applyHypothesis) {
  const available = new Map(song.patterns.map((p) => [p.number, p.tracks.map((t) => t.number)]));
  const entries = song.arrangement.map((row) => {
    const tracks = available.get(row.pattern) || [];
    const entry = Object.assign({}, row, { available_tracks: tracks });
    entry.enabled_tracks = tracks.length ? null : [];
    if (applyHypothesis) {
      const raw = Uint8Array.from(row.raw.match(/../g).map((h) => parseInt(h, 16)));
      const mute = muteWord(raw);
      entry.candidate_mute_word = mute.toString(16).padStart(4, '0');
      entry.enabled_tracks = tracks.filter((t) => !(mute & (1 << (t - 1))));
    }
    return entry;
  });
  const map = {
    source_name: song.source_name,
    instructions: 'Fill enabled_tracks with confirmed track numbers for each occurrence. null means UNKNOWN, [] means all muted.',
    entries,
  };
  if (applyHypothesis) {
    map.verification_status = 'INFERRED_NOT_CONFIRMED';
    map.hypothesis = {
      formula: MUTE_FORMULA,
      meaning: 'Hypothesis only: bit 0..15 corresponds to tracks 1..16; 1 means muted.',
      evidence: 'Internal musical consistency on the reference song only. No original-playback comparison.',
    };
  }
  return map;
}

function channelPlan(song, selections) {
  const patterns = new Map(song.patterns.map((p) => [p.number, p]));
  const selected = new Map(selections.entries.map((e) => [e.index, e]));
  const pairs = new Set();
  for (const row of song.arrangement) {
    if (row.tick >= song.stop_tick) continue;
    const enabled = (selected.get(row.index) || {}).enabled_tracks || [];
    for (const track of (patterns.get(row.pattern) || { tracks: [] }).tracks) {
      if (!enabled.includes(track.number)) continue;
      for (const [, msg] of trackEvents(track, null)) pairs.add(track.port * 16 + (msg[0] & 15));
    }
  }
  if (!pairs.size || pairs.size > 16) return null;
  const order = Array.from(pairs).sort((a, b) => a - b);
  // Channel 10 is the General MIDI drum channel. Put the most percussive
  // port/channel there so a plain MIDI player picks sensible sounds.
  if (order.length > 9) {
    const score = new Map(order.map((k) => [k, 0]));
    const DRUMMY = /(drum|snare|hihat|hi-?hat|\bhh\b|kick|\bbd\b|\bsd\b|cymb|tom|clap|perc|rythm|rhythm|hat)/i;
    for (const row of song.arrangement) {
      if (row.tick >= song.stop_tick) continue;
      const enabled = (selected.get(row.index) || {}).enabled_tracks || [];
      for (const track of (patterns.get(row.pattern) || { tracks: [] }).tracks) {
        if (!enabled.includes(track.number) || !DRUMMY.test(track.name)) continue;
        for (const [, msg] of trackEvents(track, null)) {
          const k = track.port * 16 + (msg[0] & 15);
          if (score.has(k)) score.set(k, score.get(k) + 1);
        }
      }
    }
    let best = null;
    for (const [k, v] of score) if (v > 0 && (best === null || v > score.get(best))) best = k;
    if (best !== null) {
      const at = order.indexOf(best);
      if (at !== 9) { const tmp = order[9]; order[9] = best; order[at] = tmp; }
    }
  }
  const plan = new Map();
  order.forEach((key, i) => plan.set(key, i));
  return plan;
}

function buildArrangement(song, selections, warn, options) {
  const opts = options || {};
  const plan = opts.remapChannels ? channelPlan(song, selections) : null;
  if (opts.remapChannels && !plan) {
    warn.add('caution', 'channels',
      'This song needs more than 16 port/channel combinations, so they cannot all be given their own MIDI channel. Original channels were kept and some tracks will share one.');
  }
  const remap = (msg, port) => {
    if (!plan) return msg;
    const to = plan.get(port * 16 + (msg[0] & 15));
    return to === undefined ? msg : [(msg[0] & 240) | to, msg[1], msg[2]];
  };
  const selected = new Map(selections.entries.map((e) => [e.index, e]));
  const patterns = new Map(song.patterns.map((p) => [p.number, p]));
  const rows = song.arrangement.filter((e) => e.tick < song.stop_tick);
  if (!rows.length) throw new Error('There is no arrangement to render in this file. Export the patterns instead.');
  for (const row of rows) {
    const supplied = selected.get(row.index);
    if (!supplied || supplied.raw !== row.raw) throw new Error('Selection entry ' + row.index + ' is missing or does not match this file.');
    if (!Array.isArray(supplied.enabled_tracks)) throw new Error('Entry ' + row.index + ' has no decided mute selection, so no arrangement was written.');
  }
  const start = Math.min(0, ...rows.map((e) => e.tick));
  const placed = new Map();
  const markers = [];
  rows.forEach((row, index) => {
    let end = song.stop_tick;
    for (let j = index + 1; j < rows.length; j += 1) {
      if (rows[j].chain === row.chain) { end = rows[j].tick; break; }
    }
    const duration = end - row.tick;
    const enabled = selected.get(row.index).enabled_tracks;
    markers.push([row.tick - start,
      'Atari bar ' + (+row.bar_assuming_4_4.toFixed(4)) + ': chain ' + row.chain + ' P' + row.pattern +
      ' ' + row.pattern_name + ' tracks ' + (enabled.join(',') || 'none')]);
    if (duration <= 0) {
      warn.add('caution', 'arrangement',
        'An arrangement entry has zero or negative length and was skipped. Two entries may share a position on one chain.');
      return;
    }
    for (const track of (patterns.get(row.pattern) || { tracks: [] }).tracks) {
      if (!enabled.includes(track.number)) continue;
      const key = row.chain + '|' + row.pattern + '|' + track.number;
      let route = routeName(track);
      if (plan) {
        const chans = Array.from(new Set(trackEvents(track, null)
          .map(([, m]) => plan.get(track.port * 16 + (m[0] & 15)))
          .filter((c) => c !== undefined))).sort((a, b) => a - b);
        if (chans.length) route += ' as ch ' + chans.map((c) => c + 1).join('/');
      }
      const name = 'Arr ' + row.chain + ' P' + String(row.pattern).padStart(2, '0') +
        ' T' + String(track.number).padStart(2, '0') + ' ' + track.name + ' [' + route + ']';
      if (!placed.has(key)) placed.set(key, [name, track.port, []]);
      for (const [t, msg] of placeTrack(track, row.source_offset_assumed, duration, warn)) {
        placed.get(key)[2].push([t + row.tick - start, remap(msg, track.port)]);
      }
    }
  });
  const built = { tracks: Array.from(placed.values()), markers, endTick: song.stop_tick - start, plan };
  const notes = [];
  if (plan) {
    notes.push('Channels were reassigned so each Notator port/channel pair gets its own MIDI channel.');
    Array.from(plan.entries()).sort((a, b) => a[1] - b[1]).forEach(([pair, ch]) => {
      notes.push('ch ' + String(ch + 1).padStart(2) + '  was  MIDI ' +
        String.fromCharCode(65 + Math.floor(pair / 16)) + ((pair % 16) + 1));
    });
  } else {
    notes.push('Original Notator channels kept. Tracks on different ports may share a MIDI channel.');
  }
  built.notes = notes;
  return built;
}

function portLetter(p) { return String.fromCharCode(65 + p); }

/* Three ways to fit a multi-port Notator song into Standard MIDI Files:
   'fold'   one file, ports folded into one 16-channel space (only when they fit)
   'single' one file, original channels kept, ports marked with FF 21 meta events
   'split'  one file per Notator port, each a plain 16-channel file            */
function renderArrangementFiles(song, selections, warn, options) {
  const opts = options || {};
  const ports = new Set();
  for (const p of song.patterns) for (const tr of p.tracks) ports.add(tr.port);
  const plan = channelPlan(song, selections);
  let strategy = opts.strategy || (plan ? 'fold' : (ports.size > 1 ? 'split' : 'single'));
  if (strategy === 'fold' && !plan) {
    strategy = 'split';
    warn.add('caution', 'channels',
      'This song uses more than 16 port and channel combinations, so they cannot share one 16-channel file. One file per Notator port was written instead.');
  }
  const built = buildArrangement(song, selections, warn, { remapChannels: strategy === 'fold' });
  const base = (opts.base || 'song');
  if (strategy !== 'split') {
    if (strategy === 'single' && ports.size > 1) {
      built.notes = ['Original Notator channels kept, one track per source track.',
        'Ports are marked with FF 21 port meta events, which many players ignore.',
        'If instruments collide, use the one-file-per-port export instead.'];
    }
    return [{ name: base + '_arrangement.mid',
      bytes: writeMidi('Arrangement with Notator Arrange mutes applied', built.tracks,
        song.bpm_used, built.endTick, built.markers, built.notes) }];
  }
  const files = [];
  for (const port of Array.from(ports).sort((a, b) => a - b)) {
    const mine = built.tracks.filter((tr) => tr[1] === port);
    if (!mine.length) continue;
    files.push({
      name: base + '_arrangement_MIDI-' + portLetter(port) + '.mid',
      bytes: writeMidi('Arrangement, Notator port ' + portLetter(port), mine, song.bpm_used,
        built.endTick, built.markers,
        ['Only the tracks Notator sent to port ' + portLetter(port) + ' are in this file.',
         'Original channel numbers are kept, so load each port file onto its own instrument set.']),
    });
  }
  return files;
}

function renderArrangement(song, selections, warn, options) {
  const built = buildArrangement(song, selections, warn, options);
  return writeMidi('Arrangement with Notator Arrange mutes applied', built.tracks,
    song.bpm_used, built.endTick, built.markers, built.notes);
}

// ----------------------------------------------------------------- zip (store)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const body = file.bytes;
    const crc = crc32(body);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x504b0304, false); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, body.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, body);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x504b0102, false); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true); dv.setUint32(16, crc, true);
    dv.setUint32(20, body.length, true); dv.setUint32(24, body.length, true);
    dv.setUint16(28, nameBytes.length, true); dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x504b0506, false);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

function muteEvidence(song) {
  const avail = new Map(song.patterns.map((p) => [p.number, p.tracks.map((t) => t.number)]));
  const map = selectionMap(song, true);
  const rows = map.entries.filter((e) => (avail.get(e.pattern) || []).length > 0);
  const result = {
    rows: rows.length, all_on: 0, none_on: 0, variant_selectors: [], varying: [], verdict: 'inconclusive',
  };
  if (!rows.length) return result;
  const byPattern = new Map();
  for (const e of rows) {
    const a = avail.get(e.pattern);
    const n = e.enabled_tracks.length;
    if (n === a.length) result.all_on += 1;
    if (n === 0) result.none_on += 1;
    if (!byPattern.has(e.pattern)) byPattern.set(e.pattern, { available: a.length, counts: [], combos: new Set() });
    const rec = byPattern.get(e.pattern);
    rec.counts.push(n);
    rec.combos.add(e.enabled_tracks.join(','));
  }
  const named = new Map(song.patterns.map((p) => [p.number, p.name]));
  for (const [number, rec] of byPattern) {
    const label = 'P' + String(number).padStart(2, '0') + ' ' + (named.get(number) || '');
    if (rec.available >= 3 && rec.counts.length >= 3 && rec.counts.every((c) => c === 1)) {
      result.variant_selectors.push({ pattern: label, of: rec.available, occurrences: rec.counts.length });
    }
    if (rec.counts.length >= 2 && rec.combos.size >= 2) {
      result.varying.push({ pattern: label, occurrences: rec.counts.length, combinations: rec.combos.size });
    }
  }
  const allOnRatio = result.all_on / rows.length;
  if (allOnRatio > 0.95) result.verdict = 'suspect';
  else if (result.variant_selectors.length || result.varying.length >= 2) result.verdict = 'corroborated';
  else if (allOnRatio < 0.9) result.verdict = 'plausible';
  return result;
}

/* What actually sounds on each Notator port/channel, so a person can decide
   which sources may share a MIDI channel when there are more than sixteen. */
function channelUsage(song, selections, warn) {
  const built = buildArrangement(song, selections, warn, { remapChannels: false });
  const map = new Map();
  for (const [name, port, events] of built.tracks) {
    const clean = name.replace(/^Arr \S+ P\d+ T\d+ /, '').replace(/ \[.*$/, '').trim();
    const active = new Map();
    for (const [tick, msg] of events) {
      const kind = msg[0] & 240, ch = msg[0] & 15, key = port * 16 + ch;
      if (!map.has(key)) map.set(key, { port, channel: ch, notes: 0, tracks: new Set(), spans: [] });
      const rec = map.get(key);
      if (kind === 0x90 && msg[2]) { rec.notes += 1; rec.tracks.add(clean); active.set(msg[1], tick); }
      else if (kind === 0x80 && active.has(msg[1])) {
        rec.spans.push([active.get(msg[1]), tick]); active.delete(msg[1]);
      }
    }
  }
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(function (e) {
    const v = e[1];
    v.spans.sort((a, b) => a[0] - b[0]);
    return { key: e[0], port: v.port, channel: v.channel, label: portLetter(v.port) + (v.channel + 1),
      notes: v.notes, tracks: Array.from(v.tracks), spans: v.spans };
  });
}

function usageOverlaps(a, b) {
  let i = 0, j = 0;
  while (i < a.spans.length && j < b.spans.length) {
    const x = a.spans[i], y = b.spans[j];
    if (x[1] > y[0] && y[1] > x[0]) return true;
    if (x[1] <= y[1]) i += 1; else j += 1;
  }
  return false;
}

function renderWithAssignment(song, selections, warn, assignment, base) {
  const built = buildArrangement(song, selections, warn, { remapChannels: false });
  const tracks = built.tracks.map(function (tr) {
    const [name, port, events] = tr;
    const moved = events.map(function (e) {
      const to = assignment[port * 16 + (e[1][0] & 15)];
      return to === undefined ? e : [e[0], [(e[1][0] & 240) | to, e[1][1], e[1][2]]];
    });
    const chans = Array.from(new Set(moved.map((e) => (e[1][0] & 15)))).sort((a, b) => a - b);
    return [name.replace(/\]$/, '') + ' as ch ' + chans.map((c) => c + 1).join('/') + ']', port, moved];
  });
  const notes = ['Channels were assigned by hand for this export.'];
  Object.keys(assignment).map(Number).sort((a, b) => assignment[a] - assignment[b]).forEach(function (k) {
    notes.push('ch ' + String(assignment[k] + 1).padStart(2) + '  was  MIDI ' + portLetter(Math.floor(k / 16)) + ((k % 16) + 1));
  });
  return [{ name: (base || 'song') + '_arrangement.mid',
    bytes: writeMidi('Arrangement with Notator Arrange mutes applied', tracks,
      song.bpm_used, built.endTick, built.markers, notes) }];
}

const API = {
  readSong, exportSources, selectionMap, renderArrangement, trackEvents, placeTrack,
  writeMidi, makeZip, routeName, muteEvidence, channelPlan, renderArrangementFiles, portLetter,
  channelUsage, usageOverlaps, renderWithAssignment,
  Warnings, PPQ, MUTE_FORMULA,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.SONLIB = API;
