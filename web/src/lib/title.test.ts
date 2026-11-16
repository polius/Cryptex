/** M4: every page has its own title, and a link's page never carries the sender's title. */
import { describe, expect, it } from 'vitest';
import { pageTitle } from './title';

describe('pageTitle', () => {
  it('names the page, then the brand', () => {
    expect(pageTitle('/links', 'Acme')).toBe('Your links · Acme');
    expect(pageTitle('/server/limits', 'Acme')).toBe('Server · Limits · Acme');
    expect(pageTitle('/server', 'Acme')).toBe('Server · Overview · Acme');
    expect(pageTitle('/signin', 'Acme')).toBe('Sign in · Acme');
    expect(pageTitle('/s/Abc123defG', 'Acme')).toBe('Sealed secret · Acme');
    expect(pageTitle('/a/Abc123defG', 'Acme')).toBe('Request · Acme');
    expect(pageTitle('/nowhere', 'Acme')).toBe('Acme');
  });
});
