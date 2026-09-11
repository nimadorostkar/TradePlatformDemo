import { describe, expect, it } from 'vitest';
import { assertNoTokenInUrl, sanitizedCredentialUrl } from './host-bootstrap';

describe('URL credential rejection', () => {
  it('rejects every supported credential spelling', () => {
    for (const name of ['token', 'access_token', 'crm_token', 'crmToken', 'jwt']) {
      expect(() => assertNoTokenInUrl(`?theme=dark&${name}=secret`)).toThrow(
        /could not be completed securely/i,
      );
    }
  });

  it('removes credentials while retaining benign query and fragment state', () => {
    expect(
      sanitizedCredentialUrl(
        'https://trade.example/terminal?theme=dark&token=secret&symbol=EURUSD#chart',
      ),
    ).toBe('/terminal?theme=dark&symbol=EURUSD#chart');
  });
});
