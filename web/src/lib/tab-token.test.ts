// @vitest-environment jsdom
/** M1: a reload after the key or token has left the address bar still finds what this tab did with it. */
import { describe, expect, it } from 'vitest';
import { answeredHere, markAnswered } from '../flows/reveal';
import { forgetTabToken, tabToken } from './router';

describe('in this tab', () => {
  it('an invite token survives a reload, but not in history, and is forgotten once used', () => {
    history.replaceState(null, '', '/invite#tok-123');
    expect(tabToken('/invite')).toBe('tok-123');
    expect(location.hash).toBe(''); // gone from the address bar
    expect(tabToken('/invite')).toBe('tok-123'); // a reload
    expect(tabToken('/reset')).toBe(''); // another page
    forgetTabToken('/invite');
    expect(tabToken('/invite')).toBe('');
  });

  it('an answered request is remembered with its time', () => {
    expect(answeredHere('Abc123defG')).toBeNull();
    markAnswered('Abc123defG');
    expect(Date.parse(answeredHere('Abc123defG')!)).toBeGreaterThan(0);
  });
});
