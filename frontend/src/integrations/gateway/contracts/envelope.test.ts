import { describe, expect, it } from 'vitest';
import { decodeGatewayData, gatewayEnvelopeSchema, unwrapAnswer } from './envelope';

describe('decodeGatewayData', () => {
  it('parses exactly one layer of encoded JSON', () => {
    // `internal/domain/domain.go#toEnvelope` sets data = string(body) for every
    // RAW_STRING endpoint, so `data` is a JSON string containing JSON.
    expect(decodeGatewayData('{"answer":{"Balance":100}}')).toEqual({
      answer: { Balance: 100 },
    });
    expect(decodeGatewayData('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('never parses a second layer', () => {
    // After the single decode, any nested JSON-looking STRING must stay a
    // string. Recursively parsing would turn a trade comment or an encoded
    // field into an object and corrupt it.
    const encoded = JSON.stringify({ comment: '{"not":"parsed"}', rows: ['[1,2]'] });
    expect(decodeGatewayData(encoded)).toEqual({
      comment: '{"not":"parsed"}',
      rows: ['[1,2]'],
    });
  });

  it('leaves a JSON-encoded string value alone (it is not brace-prefixed)', () => {
    // `"\"text\""` decodes to the string `text` only if parsed — we do not
    // parse it, because it does not begin with a brace or bracket.
    expect(decodeGatewayData('"just text"')).toBe('"just text"');
  });

  it('leaves objects and arrays untouched', () => {
    const object = { answer: [1] };
    expect(decodeGatewayData(object)).toBe(object);
    const array = [{ id: '1' }];
    expect(decodeGatewayData(array)).toBe(array);
  });

  it('leaves a non-JSON string alone', () => {
    expect(decodeGatewayData('Invalid TP value')).toBe('Invalid TP value');
    expect(decodeGatewayData('EURUSD')).toBe('EURUSD');
  });

  it('does not parse a string that merely starts with a brace', () => {
    // A trade comment could legitimately look like this.
    expect(decodeGatewayData('{not json')).toBe('{not json');
  });

  it('treats an empty string as null', () => {
    expect(decodeGatewayData('')).toBeNull();
    expect(decodeGatewayData('   ')).toBeNull();
  });

  it('passes primitives through', () => {
    expect(decodeGatewayData(42)).toBe(42);
    expect(decodeGatewayData(null)).toBeNull();
    expect(decodeGatewayData(true)).toBe(true);
  });
});

describe('unwrapAnswer', () => {
  it('unwraps exactly one answer level', () => {
    expect(unwrapAnswer({ answer: { Balance: 1 } })).toEqual({ Balance: 1 });
  });

  it('leaves a value with no answer key untouched', () => {
    expect(unwrapAnswer({ Balance: 1 })).toEqual({ Balance: 1 });
  });

  it('does not unwrap arrays', () => {
    const array = [{ answer: 1 }];
    expect(unwrapAnswer(array)).toBe(array);
  });
});

describe('gatewayEnvelopeSchema', () => {
  it('accepts the documented envelope', () => {
    const result = gatewayEnvelopeSchema.safeParse({
      data: null,
      errorMessage: null,
      message: 'Success: Action performed successfully.',
      success: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a body without `success`', () => {
    expect(gatewayEnvelopeSchema.safeParse({ data: 1 }).success).toBe(false);
  });
});
