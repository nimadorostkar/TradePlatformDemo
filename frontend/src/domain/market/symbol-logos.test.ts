import { describe, expect, it } from 'vitest';
import { symbolLogoUrls } from './symbol-logos';

describe('symbolLogoUrls', () => {
  it('maps a major pair to base and quote flags, base first', () => {
    expect(symbolLogoUrls('EURUSD')).toEqual(['/symbol-logos/eu.svg', '/symbol-logos/us.svg']);
    expect(symbolLogoUrls('GBPUSD')).toEqual(['/symbol-logos/gb.svg', '/symbol-logos/us.svg']);
    expect(symbolLogoUrls('USDJPY')).toEqual(['/symbol-logos/us.svg', '/symbol-logos/jp.svg']);
  });

  it('maps crosses and exotics', () => {
    expect(symbolLogoUrls('AUDNZD')).toEqual(['/symbol-logos/au.svg', '/symbol-logos/nz.svg']);
    expect(symbolLogoUrls('USDCNH')).toEqual(['/symbol-logos/us.svg', '/symbol-logos/cn.svg']);
    expect(symbolLogoUrls('EURTRY')).toEqual(['/symbol-logos/eu.svg', '/symbol-logos/tr.svg']);
  });

  it('gives metals an ingot icon on the base side', () => {
    expect(symbolLogoUrls('XAUUSD')).toEqual(['/symbol-logos/xau.svg', '/symbol-logos/us.svg']);
    expect(symbolLogoUrls('XAGUSD')).toEqual(['/symbol-logos/xag.svg', '/symbol-logos/us.svg']);
  });

  it('gives indices the flag of their home market', () => {
    expect(symbolLogoUrls('DAXEUR')).toEqual(['/symbol-logos/de.svg']);
    expect(symbolLogoUrls('SPXUSD')).toEqual(['/symbol-logos/us.svg']);
    expect(symbolLogoUrls('DXY')).toEqual(['/symbol-logos/us.svg']);
  });

  it('gives energies a product icon', () => {
    expect(symbolLogoUrls('WTIUSD')).toEqual(['/symbol-logos/oil.svg']);
    expect(symbolLogoUrls('BRNUSD')).toEqual(['/symbol-logos/oil.svg']);
    expect(symbolLogoUrls('NGCUSD')).toEqual(['/symbol-logos/gas.svg']);
  });

  it('maps crypto CFDs', () => {
    expect(symbolLogoUrls('BTCUSD')).toEqual(['/symbol-logos/btc.svg', '/symbol-logos/us.svg']);
    expect(symbolLogoUrls('ETHUSD')).toEqual(['/symbol-logos/eth.svg', '/symbol-logos/us.svg']);
  });

  it('tolerates a gateway name that still carries an account-type suffix', () => {
    expect(symbolLogoUrls('EURUSD.')).toEqual(['/symbol-logos/eu.svg', '/symbol-logos/us.svg']);
    expect(symbolLogoUrls('XAUUSD!')).toEqual(['/symbol-logos/xau.svg', '/symbol-logos/us.svg']);
    expect(symbolLogoUrls('SPXUSD#')).toEqual(['/symbol-logos/us.svg']);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(symbolLogoUrls(' eurusd ')).toEqual(['/symbol-logos/eu.svg', '/symbol-logos/us.svg']);
  });

  it('returns undefined for anything unrecognised, never a broken url', () => {
    expect(symbolLogoUrls('AAPL')).toBeUndefined();
    expect(symbolLogoUrls('SOMETHING')).toBeUndefined();
    expect(symbolLogoUrls('ABCXYZ')).toBeUndefined(); // six letters, unknown codes
    expect(symbolLogoUrls('')).toBeUndefined();
  });
});
