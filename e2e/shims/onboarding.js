/**
 * Mock Confido onboarding browser SDK  ->  window.confidoOnboarding
 *
 * Implements the interface declared in src/confido-legal-hook/ConfidoLegal.d.ts
 * (renderForm / renderOwnerForm / refresh), per e2e/PLAN.md section 4.2.
 *
 * Consumers:
 *   src/components/onboarding-form/OnboardingFormModal.tsx  -> renderForm
 *   src/pages/owner-form.tsx                                -> renderOwnerForm
 *
 * Loaded both as {MOCK}/js/onboarding.js (<script async> from _document.tsx via
 * NEXT_PUBLIC_CL_ONBOARDING_JS_URL) and via page.addInitScript(). Plain ES2019,
 * no imports, no build step, idempotent.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  // Idempotency guard: whichever load path wins, the other is a no-op.
  if (window.confidoOnboarding) return;

  var DEFAULT_MOCK_URL = 'http://127.0.0.1:7002';
  /**
   * Origin of the <script src> that loaded this shim, captured at load time —
   * `document.currentScript` is only non-null while the script body is running,
   * so it cannot be read lazily from inside a callback.
   *
   * This matters whenever the mock is not on 127.0.0.1:7002: a shim served from
   * an origin should talk to that origin. Without it, a browser on any other
   * machine (a tunnelled or hosted demo) would send its control-API calls to
   * *its own* localhost and the payment would hang.
   */
  var SCRIPT_ORIGIN = (function () {
    try {
      var el = document.currentScript;
      if (el && el.src) return new URL(el.src, window.location.href).origin;
    } catch (e) {
      /* older browsers, or a shim evaluated without a script element */
    }
    return null;
  })();

  var CONTAINER_POLL_MS = 25;
  var CONTAINER_POLL_TRIES = 80; // ~2s

  function mockUrl() {
    // Precedence: the fixture's explicit global, then the origin this script was
    // served from, then the local default. See hosted-fields.js for why.
    return window.__CONFIDO_MOCK_URL || SCRIPT_ORIGIN || DEFAULT_MOCK_URL;
  }

  /**
   * The container is rendered by the same React commit that schedules the
   * effect calling us, so it is normally already there; poll anyway for the
   * modal/portal cases where it is not.
   */
  function withContainer(containerId, fn) {
    if (!containerId) return;
    var tries = 0;
    var attempt = function () {
      var container = document.getElementById(containerId);
      if (container) {
        fn(container);
        return;
      }
      if (++tries >= CONTAINER_POLL_TRIES) return;
      window.setTimeout(attempt, CONTAINER_POLL_MS);
    };
    attempt();
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function labelledInput(id, labelText, name) {
    var wrapper = document.createElement('div');

    var label = document.createElement('label');
    label.setAttribute('for', id);
    label.textContent = labelText;

    var input = document.createElement('input');
    input.setAttribute('id', id);
    input.setAttribute('name', name);
    input.setAttribute('type', 'text');
    input.setAttribute('aria-label', labelText);
    input.setAttribute('data-testid', id);
    input.setAttribute('autocomplete', 'off');

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    return { wrapper: wrapper, input: input };
  }

  function renderForm(opts) {
    opts = opts || {};
    var token = opts.token;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

    withContainer(opts.containerId, function (container) {
      // Re-rendering the same token into the same container would duplicate the
      // form (React re-runs the effect on remount); rendering a new token must
      // replace whatever is there.
      if (container.getAttribute('data-onboarding-token') === String(token)) {
        return;
      }
      clear(container);
      container.setAttribute('data-onboarding-token', String(token));

      var form = document.createElement('form');
      form.setAttribute('data-testid', 'onboarding-form');
      form.setAttribute('novalidate', 'novalidate');

      var legalName = labelledInput(
        'onboarding-legal-business-name',
        'Legal business name',
        'legalBusinessName'
      );
      var ein = labelledInput('onboarding-ein', 'EIN', 'ein');

      var submit = document.createElement('button');
      submit.setAttribute('type', 'submit');
      submit.setAttribute('data-testid', 'onboarding-submit');
      submit.textContent = 'Submit application';

      form.appendChild(legalName.wrapper);
      form.appendChild(ein.wrapper);
      form.appendChild(submit);
      container.appendChild(form);

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submit.disabled = true;

        var url =
          mockUrl() +
          '/__control/onboarding/' +
          encodeURIComponent(String(token)) +
          '/submit';

        window
          .fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              legalBusinessName: legalName.input.value,
              ein: ein.input.value
            })
          })
          .then(function (res) {
            if (!res.ok) {
              throw new Error(
                'Onboarding submission failed (' + res.status + ')'
              );
            }
            clear(container);
            var done = document.createElement('div');
            done.setAttribute('data-testid', 'onboarding-submitted');
            done.textContent = 'Application submitted';
            container.appendChild(done);
            if (onChange) onChange({ type: 'submitted', token: token });
          })
          .catch(function (err) {
            submit.disabled = false;
            var existing = container.querySelector(
              '[data-testid="onboarding-error"]'
            );
            if (!existing) {
              existing = document.createElement('div');
              existing.setAttribute('data-testid', 'onboarding-error');
              container.appendChild(existing);
            }
            existing.textContent = err && err.message ? err.message : String(err);
          });
      });
    });
  }

  function renderOwnerForm(opts) {
    opts = opts || {};
    var code = opts.code;

    withContainer(opts.containerId, function (container) {
      if (container.getAttribute('data-owner-code') === String(code)) return;
      clear(container);
      container.setAttribute('data-owner-code', String(code));

      var div = document.createElement('div');
      div.setAttribute('data-testid', 'owner-form');
      div.textContent = 'Owner form for ' + String(code);
      container.appendChild(div);
    });
  }

  function refresh() {
    // No-op: nothing to re-fetch in the mock.
  }

  window.confidoOnboarding = {
    refresh: refresh,
    renderForm: renderForm,
    renderOwnerForm: renderOwnerForm
  };

  window.__onboardingShim = { version: 1 };
})();
