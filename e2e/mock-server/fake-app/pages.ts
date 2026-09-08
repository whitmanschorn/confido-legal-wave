/**
 * HTML for the fake Confido app pages (PLAN.md §3.5).
 *
 * Owned by unit C. Every page is a self-contained document: no external
 * stylesheet, font, image or script. The `lockdown` fixture fails the suite on
 * any escaped network request, so a single <link href="https://..."> here would
 * be a suite-wide failure.
 *
 * These are plain functions rather than static .html files because every page
 * except the placeholders interpolates state (appId, connect state, firm name).
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE =
  'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
  'margin:0;padding:2rem;line-height:1.5;color:#1a202c;background:#fff}' +
  'main{max-width:38rem;margin:0 auto}' +
  'button{font:inherit;padding:.5rem 1rem;border:1px solid #2b6cb0;' +
  'border-radius:.375rem;background:#2b6cb0;color:#fff;cursor:pointer}' +
  'dt{font-weight:600}dd{margin:0 0 .5rem 0}code{font-family:ui-monospace,monospace}';

/** Minimal, valid, resource-free HTML document. */
export function layout(title: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' +
    escapeHtml(title) +
    '</title>\n<style>' +
    STYLE +
    '</style>\n</head>\n<body>\n<main>\n' +
    body +
    '\n</main>\n</body>\n</html>\n'
  );
}

export interface ConnectPageOptions {
  appId: string;
  state: string;
  /** Where the Authorize form posts (same path, state preserved). */
  action: string;
}

/**
 * GET /app/connect/:appId?state= — the fake Connect authorize screen.
 * Heading `Authorize Legal Wave`, one button named `Authorize`.
 */
export function connectPage(options: ConnectPageOptions): string {
  return layout(
    'Authorize Legal Wave',
    '<h1>Authorize Legal Wave</h1>\n' +
      '<p>Mock Confido Legal Connect. Authorizing creates an <strong>active</strong> ' +
      'mock firm and hands Legal Wave a one-time code.</p>\n' +
      '<dl>\n<dt>App ID</dt><dd><code>' +
      escapeHtml(options.appId) +
      '</code></dd>\n<dt>State</dt><dd><code>' +
      escapeHtml(options.state) +
      '</code></dd>\n</dl>\n' +
      '<form method="post" action="' +
      escapeHtml(options.action) +
      '">\n' +
      '<input type="hidden" name="state" value="' +
      escapeHtml(options.state) +
      '">\n' +
      '<button type="submit">Authorize</button>\n</form>\n',
  );
}

export interface SignupPageOptions {
  code: string;
  firmName: string;
}

/** GET /app/signup?s_code=<code> and GET /app/signup/<code>. */
export function signupPage(options: SignupPageOptions): string {
  return layout(
    'Mock Confido sign-up',
    '<h1>Mock Confido sign-up for ' +
      escapeHtml(options.firmName) +
      '</h1>\n' +
      '<p>This is the mock stand-in for the hosted Confido Legal sign-up flow.</p>\n' +
      '<dl>\n<dt>Sign-up code</dt><dd><code>' +
      escapeHtml(options.code) +
      '</code></dd>\n</dl>\n',
  );
}

/** GET /app — the "sandbox" link target. */
export function appIndexPage(): string {
  return layout(
    'Confido Legal (mock)',
    '<h1>Confido Legal (mock)</h1>\n' +
      '<p>Mock Confido Legal application. Nothing here talks to the real sandbox.</p>\n',
  );
}

/** GET /iframe-target — the standing-link iframe test target. */
export function iframeTargetPage(): string {
  return layout(
    'Mock standing link',
    '<h1>Mock standing link</h1>\n<p>Mock standing link page rendered by the Confido mock server.</p>\n',
  );
}

/** Any unrecognised page under the fake app. */
export function notFoundPage(message: string): string {
  return layout('Not found', '<h1>Not found</h1>\n<p>' + escapeHtml(message) + '</p>\n');
}
