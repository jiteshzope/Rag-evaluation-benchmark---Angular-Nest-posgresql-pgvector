import { buildOriginMatcher } from './app-config';

/**
 * CORS is the only thing standing between this API and any website that wants
 * to spend the visitor's quota, so the wildcard support added for Vercel
 * previews has to widen the allow-list exactly as far as intended and no
 * further.
 */
describe('buildOriginMatcher', () => {
  it('matches an exact origin', () => {
    const allows = buildOriginMatcher(['https://ragbench.vercel.app']);

    expect(allows('https://ragbench.vercel.app')).toBe(true);
    expect(allows('https://other.vercel.app')).toBe(false);
  });

  it('matches any of several origins', () => {
    const allows = buildOriginMatcher(['http://localhost:5173', 'https://ragbench.vercel.app']);

    expect(allows('http://localhost:5173')).toBe(true);
    expect(allows('https://ragbench.vercel.app')).toBe(true);
    expect(allows('http://localhost:4173')).toBe(false);
  });

  it('matches Vercel preview hostnames through a wildcard', () => {
    const allows = buildOriginMatcher(['https://*.vercel.app']);

    expect(allows('https://ragbench.vercel.app')).toBe(true);
    expect(allows('https://ragbench-git-main-jitesh.vercel.app')).toBe(true);
    expect(allows('https://ragbench-k2n4x9q1c-jitesh.vercel.app')).toBe(true);
  });

  // ── The cases that make a wildcard dangerous if written carelessly ────────

  it('does not let a suffix be appended to an exact origin', () => {
    const allows = buildOriginMatcher(['https://ragbench.vercel.app']);

    expect(allows('https://ragbench.vercel.app.attacker.com')).toBe(false);
    expect(allows('https://ragbench.vercel.app/../evil')).toBe(false);
  });

  it('does not let a prefix be prepended to an exact origin', () => {
    const allows = buildOriginMatcher(['https://ragbench.vercel.app']);

    expect(allows('https://evil.com#https://ragbench.vercel.app')).toBe(false);
    expect(allows('https://notragbench.vercel.app')).toBe(false);
  });

  it('stops a wildcard at a slash, so a path cannot impersonate a host', () => {
    const allows = buildOriginMatcher(['https://*.vercel.app']);

    expect(allows('https://evil.com/.vercel.app')).toBe(false);
    expect(allows('https://evil.com/x.vercel.app')).toBe(false);
  });

  it('does not treat a wildcard as spanning the scheme', () => {
    const allows = buildOriginMatcher(['https://*.vercel.app']);

    expect(allows('http://ragbench.vercel.app')).toBe(false);
  });

  it('treats regex metacharacters in a pattern literally', () => {
    // A dot in the pattern must not match an arbitrary character.
    const allows = buildOriginMatcher(['https://app.example.com']);

    expect(allows('https://appXexample.com')).toBe(false);
    expect(allows('https://app.example.com')).toBe(true);
  });

  it('allows nothing when the list is empty', () => {
    const allows = buildOriginMatcher([]);

    expect(allows('https://ragbench.vercel.app')).toBe(false);
    expect(allows('http://localhost:5173')).toBe(false);
  });
});
