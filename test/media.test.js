import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resampler, wavHeader, codecOf, skippable } from '../app/record/media.js';

const tone = (hz, rate, secs) => Float32Array.from({ length: rate * secs }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

for (const rate of [48000, 44100]) {
  test(`media: ${rate} Hz speech band comes through the 16 kHz resampler, fed in uneven pieces`, () => {
    const rs = resampler(rate, 16000), input = tone(1000, rate, 1), out = [];
    for (let i = 0; i < input.length; i += 1234) out.push(...rs.push(input.subarray(i, i + 1234)));
    assert.ok(Math.abs(out.length - 16000) < 40, `length ${out.length}`);
    assert.ok(Math.abs(rms(out.slice(100, -100)) - 0.5 / Math.SQRT2) < 0.01);
  });
}

test('media: a tone above 8 kHz is filtered out, not folded back', () => {
  const rs = resampler(48000, 16000), out = rs.push(tone(12000, 48000, 1));
  assert.ok(rms(out.slice(100, -100)) < 0.02);
});

test('media: the wav header says 16-bit mono 16 kHz and the data length', () => {
  const h = new DataView(wavHeader(1000).buffer);
  assert.equal(h.getUint32(4, true), 2036);
  assert.equal(h.getUint16(22, true), 1);
  assert.equal(h.getUint32(24, true), 16000);
  assert.equal(h.getUint32(40, true), 2000);
});

test('media: codec strings for the tracks we meet', () => {
  assert.deepEqual(codecOf({ codec: 'V_VP8' }), { codec: 'vp8' });
  assert.equal(codecOf({ codec: 'V_MPEG4/ISO/AVC', private: Uint8Array.from([1, 0x64, 0x00, 0x33, 0xff]) }).codec, 'avc1.640033');
  assert.equal(codecOf({ codec: 'A_AAC', private: Uint8Array.from([0x11, 0x90]) }).codec, 'mp4a.40.2');
  assert.equal(codecOf({ codec: 'V_THEORA' }), null);
});

test('media: an H.264 B-frame nobody refers to can be skipped, a P-frame cannot', () => {
  const avc = { codec: 'V_MPEG4/ISO/AVC' };
  const nal = h => [0, 0, 0, 3, h, 0, 0];
  assert.equal(skippable(avc, Uint8Array.from([...nal(0x09), ...nal(0x01)])), true, 'AUD then a slice with nal_ref_idc 0');
  assert.equal(skippable(avc, Uint8Array.from(nal(0x41))), false, 'nal_ref_idc 2');
  assert.equal(skippable(avc, Uint8Array.from(nal(0x65))), false, 'IDR');
  assert.equal(skippable({ codec: 'V_VP8' }, Uint8Array.from(nal(0x01))), false);
});
