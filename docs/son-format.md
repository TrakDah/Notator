# The Creator/Notator `.SON` layout, as far as it is known

Everything here was derived from a **single** song file. Offsets marked *assumed* held for
that file and may not hold for other versions of Creator or Notator. Corrections welcome.

All multi-byte values are **big-endian** (68000).

## File-level fields

| Offset | Size | Meaning |
|--------|------|---------|
| `0x0000` | 2 | Signature. `3B 9E` in the reference file. |
| `0x0006` | 2 | Tempo in BPM. |
| `0x0022` | 2 | Ticks per bar. `768` in the reference file. |
| `0x040C` | 4 | Pointer to the Arrange track. |
| `0x0440` | 6400 | Pattern pointer table: 100 patterns × 16 tracks × 4-byte pointer. |
| `0x21BE` | 800 | Pattern names: 100 × 8 bytes, NUL-padded. |

Resolution is **192 PPQ**. Stored timestamps are offset by a constant **7680 ticks**
(ten bars) which must be subtracted; the pre-roll exists so the sequencer could send SysEx
and other setup data before bar 1. Text is close to CP437 but the Atari character set is
not identical — keep the raw bytes.

## Track header

44 bytes at the pointer, then event records.

| Offset | Meaning |
|--------|---------|
| `+3` | Routing byte. `>> 5` is the MIDI port (0=A … 5=F). Low 5 bits, minus 1, are the channel override; zero means use each event's own channel. |
| `+4` | Quantize code. **Unverified** — read but not applied. |
| `+5` | Transpose, signed. |
| `+6` | Velocity offset, signed. |
| `+7` | Compression code. **Unverified.** |
| `+18` | Loop length in beats. Zero means no loop. |
| `+22` | Track name, 8 bytes. |
| `+44` | First event record. |

A track's loop length is cross-checkable: a loop marker event should appear at
`loop_beats × 192`. Disagreement means the header or the parse is wrong.

## Event records — 6 bytes

| Byte | Meaning |
|------|---------|
| 0 | Bit 7 = continuation flag. Bits 0–6 = data byte 1 (note number, controller number). |
| 1 | High nibble = event kind (`0x80` off, `0x90` on, `0xB0` controller, `0x40` marker). Low nibble = high bits of the timestamp. |
| 2–3 | Low 16 bits of the timestamp. |
| 4 | Data byte 2 (velocity, controller value) `>> 1`. |
| 5 | Low nibble = the event's own MIDI channel. |

Timestamp = `((byte1 & 0x0F) << 16) | u16(byte2..3)` minus 7680.

A `0x40` record whose byte 5 low nibble is zero is the track loop marker, not a musical
event. Track data ends at `7F FF FF FF` or `00 0F FF FF`.

## Arrange records — 24 bytes

Read from the Arrange track pointer + 44, terminated by the same boundary markers.
Each record is four 6-byte sub-records; bytes 6, 12 and 18 have bit 7 set as continuation
markers, which is why some fields are packed oddly.

| Byte | Meaning |
|------|---------|
| 0 | Pattern number. Zero marks the song stop. |
| 1–3 | Timestamp, same encoding as events. |
| 5 | Arrange chain, 0–3 = A–D. |
| 7–9 | Source offset within the pattern: `(u16(8..9) | ((byte7 & 0x0F) << 16)) - 7680`. |
| 6, 10, 11 | Mute word — see below. |
| 12–23 | Unknown. |

### The mute word

This is the field that makes the whole exercise worthwhile, and it is the least certain.

```
mute = ((b[10] & 0x7F) << 8) | (b[11] & 0x7F) | ((b[6] & 1) << 7) | ((b[6] & 2) << 14)
```

Bit *n* set means **track *n+1* is muted** at this arrangement entry. The two bits
displaced into byte 6 are presumably there because bit 7 of bytes 10 and 11 is used for
something else.

**Evidence for.** Scored against every other plausible byte pair in the record, only this
decoding produced musically coherent results. On the reference song it gives:

- A 12-track MonoBass pattern lighting **exactly one** variant at all 11 occurrences, with
  every other candidate decoding averaging 2 to 12.
- **Zero** of 93 entries with all tracks playing. The known-broken behaviour is exactly
  93 of 93.
- A drum pattern adding one track per bar through bars 1–5, then returning to the exact
  bar-1 combination at bar 95.

**Evidence missing.** No comparison against the song playing on original hardware.

### The experiment that would settle it

In Steem or Hatari, build a throwaway song with one pattern and four tracks. Save it.
Mute track 1 only, save as a second file. Diff the two. Repeat per track. Twenty minutes of
that pins the encoding to the wall as ground truth rather than inference — and the same
method would resolve the quantize and compression codes.

## Behaviour worth knowing

**Arrange entries need not start on a bar line.** An entry placed mid-bar truncates the
previous pattern on that chain at that instant. In the reference song a half-beat entry at
bar 58.875 cuts two drill notes and substitutes a 1/32-offset figure — audible, and
intended. Do not "fix" this.

**One pattern per chain at a time.** A new entry on a chain replaces whatever was playing
on it. A note falling exactly on the switch instant is currently dropped; whether Notator
gave that tick to the outgoing or incoming pattern is unresolved.

**Ports are separate synths.** Port A was the ST's built-in MIDI; B–F were expander
outputs. Two tracks on channel 1 of different ports were different instruments, and folding
them onto one MIDI channel will make them collide.
