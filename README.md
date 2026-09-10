# Notator song recovery

Reads Atari ST **Creator/Notator `.SON`** files and writes Standard MIDI Files —
including the per-occurrence **Arrange mute settings that Notator itself never exported**.
How to run this tool:

Click the green Code button near the top of this repository.
Select Download ZIP.
Extract the downloaded folder on your computer.
Double-click the main file (e.g., index.html) to open it safely in your web browser.

## The problem this solves

In Creator/Notator you could mute individual tracks *as part of the Arrange list*. A
pattern holding five tracks — two bass variants, kick, snare, hi-hat — could play Bass 1
in bars 1–4 and Bass 2 with the full kit in bars 5–9, just by toggling mutes in the
column between Arrange and Pattern.

That was never supported by any export path. Notator's own MIDI export ignored it, and so
did the Mac versions that replaced the Atari. The result: every exported arrangement plays
**every track of every pattern, all the time**. Decades of arrangement decisions, stored in
the file but unreadable by the program that wrote them.

This tool reads those mute bits and applies them.

## Using it

1. Open 'notator-son-to-midi v0.2.html' locally — it works offline and is a single self-contained file.
2. Drop a `.SON` file on the page.
3. Read the report: patterns, tracks, arrangement entries, and any warnings.
4. Press the button. You get one `.mid` file containing the whole arrangement.

Pattern-by-pattern MIDI files and the decoded structure as JSON are available as extras.

### MIDI channels

Notator addressed up to six ports (A–F) of 16 channels each, one per expander, and each
port was usually a different synth. A Standard MIDI File has only 16 channels, and there is
no way around that — the channel field is four bits wide.

- **16 or fewer port/channel pairs in use:** each gets its own MIDI channel automatically.
  The most percussive part is placed on channel 10 so ordinary players pick drum sounds.
  The mapping is written into the file as text events.
- **More than 16:** the page asks you to decide. It shows what plays on each source and
  flags which sources actually sound *simultaneously*, so you can tell a real clash from
  two parts that merely share a patch. There is also a one-file-per-port export, which is
  the only option guaranteed correct in every player.

## What is reliable, and what is not

**Reliable.** Pattern decoding is a direct read of stored events. Every note pairs, nothing
is invented, and unknown event types are skipped rather than guessed at.

**Corroborated but unverified.** The reading of the Arrange mute bits produces musically
coherent results — on the song it was developed against, a 12-track bass pattern lights
exactly one variant at each of its 11 occurrences, and the drum pattern builds one track per
bar through the intro then recapitulates that exact combination 94 bars later. That is
strong circumstantial evidence, but it has **never been checked against a song playing on
original hardware**. If you can run an emulator and compare, please do — see
[`docs/son-format.md`](docs/son-format.md) for the experiment that would settle it.

**Not implemented.** Track quantize, groove, compression and filter settings are read but
not applied. Note releases at chain transitions follow a chosen rule, not a verified one.

**Not general yet.** The layout was reverse engineered from a *single* song file. The page
checks its own assumptions and tells you loudly when they fail. If your song reports
warnings, that is useful information — please open an issue with what it said.

## Contributing

The most valuable contributions right now, in order:

1. **A `.SON` file that produces warnings**, with a note on which Notator version wrote it.
2. **A hardware or emulator comparison** confirming or refuting the mute decoding.
3. Format details for anything listed as unverified in `docs/son-format.md`.

## Building

`index.html` is generated from `src/`. To rebuild after editing:

```
python3 src/build.py
```

The tests need a `.SON` file of your own plus reference output to compare against; see the
comments in `src/test_port.js`. `src/test_robust.js` needs only a `.SON` file and checks that
damaged and foreign files degrade safely rather than producing confident nonsense.

## Licence

GPL-3.0-or-later. Copyright © 2026 YOUR NAME HERE. See [`LICENSE`](LICENSE).

You may use, study, share and modify this. If you distribute a modified version you must
distribute the source under the same licence, so improvements stay available to everyone
with the same dead files.

## Credits and provenance

The `.SON` layout was reverse engineered from one song file. The first decoder was written
in Python by GPT‑6 Astra; it was ported to JavaScript, given the port and channel handling,
and built into this page with Claude. Ownership of AI-written code is unsettled in many
jurisdictions — that is a statement about the law, not advice.

Creator and Notator were Emagic products and those names belong to their owners. This is an
independent tool for reading your own files.
