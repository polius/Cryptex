// @vitest-environment jsdom
/** A component that only shows copy follows the language picked in the menu: t() subscribes it to the language, so
 *  it re-renders even when nothing else about it changed (Your account and Your links stayed in English). */
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { expect, it } from 'vitest';
import { setLocale, t } from './i18n';

const Title = () => <h1>{t('account.title')}</h1>;

it('re-renders copy when the language changes', async () => {
  const root = document.createElement('div');
  await act(() => render(<Title />, root));
  expect(root.textContent).toBe('Your account');
  await act(() => setLocale('es'));
  expect(root.textContent).toBe('Tu cuenta');
  await act(() => setLocale('en'));
  expect(root.textContent).toBe('Your account');
});
