/**
 * Mock Confido "hosted fields" browser SDK  ->  window.gravityLegal
 *
 * Implements every member of the interface declared in
 * src/confido-legal-hook/ConfidoLegal.d.ts, backed by the mock server's
 * control API (e2e/PLAN.md sections 3.4 and 4.1).
 *
 * Loaded two ways, and must behave identically under both:
 *   1. <script async src="{MOCK}/js/hosted-fields.js"> rendered by _document.tsx
 *      from NEXT_PUBLIC_CONFIDO_SDK_URL.
 *   2. page.addInitScript() from the Playwright `shims` fixture.
 * Hence: plain ES2019, no imports, no build step, and idempotent.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  // Idempotency guard: whichever of the two load paths wins, the other is a no-op.
  if (window.gravityLegal) return;

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

  var DEFAULT_SURCHARGE_RATE = 0.03;
  var DEBIT_CARD_NUMBER = '4000056655665556';

  var CARD_KEYS = ['cardNumber', 'cardExpirationDate', 'cardSecurityCode'];
  var ACH_KEYS = ['accountHolderName', 'accountNumber', 'routingNumber'];
  var ALL_KEYS = CARD_KEYS.concat(ACH_KEYS);

  // -------------------------------------------------------------------------
  // Module state (one hosted-fields "instance" per page, like the real SDK).
  // -------------------------------------------------------------------------

  var listeners = [];
  var initialized = false;
  var token = null;
  var activeForm = 'card';
  /** key -> containerId, from the last init() call. */
  var fieldConfigs = {};
  /** key -> string typed by the user. */
  var values = {};
  /** key -> { message } | null */
  var errors = {};
  var paymentProcessing = false;
  var loadError = null;
  var paymentLink = null;
  var surchargingEnabled = false;
  var surchargeRate = DEFAULT_SURCHARGE_RATE;
  var principalAmount = 0;
  /** Bumps on every init() so a stale session fetch can never clobber state. */
  var loadGeneration = 0;
  var observer = null;

  function mockUrl() {
    // Precedence: the fixture's explicit global (tests pin it, so they stay
    // deterministic), then the origin this script was served from, then the
    // local default.
    return window.__CONFIDO_MOCK_URL || SCRIPT_ORIGIN || DEFAULT_MOCK_URL;
  }

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  function digitsOf(v) {
    return String(v == null ? '' : v).replace(/\D/g, '');
  }

  function trimmed(v) {
    return String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
  }

  /** PLAN.md section 4.1: 4 -> visa, 5|2 -> mastercard, 3 -> amex, 6 -> discover. */
  function brandFor(cardDigits) {
    var first = cardDigits.charAt(0);
    if (first === '4') return 'visa';
    if (first === '5' || first === '2') return 'mastercard';
    if (first === '3') return 'amex';
    if (first === '6') return 'discover';
    return 'generic';
  }

  function currentCardDigits() {
    return digitsOf(values.cardNumber);
  }

  function currentPaymentMethod() {
    if (activeForm === 'ach') return 'ACH';
    return currentCardDigits() === DEBIT_CARD_NUMBER ? 'DEBIT' : 'CREDIT';
  }

  function currentCardData() {
    var d = currentCardDigits();
    if (!d) return undefined;
    var brand = brandFor(d);
    return {
      bin: d.slice(0, 6),
      cardType: currentPaymentMethod() === 'DEBIT' ? 'debit' : 'credit',
      brand: brand
    };
  }

  function currentSurcharging() {
    var willBeApplied =
      !!surchargingEnabled &&
      activeForm === 'card' &&
      currentPaymentMethod() === 'CREDIT';
    return {
      active: !!surchargingEnabled,
      amount: willBeApplied
        ? { fee: Math.round(principalAmount * surchargeRate) }
        : null,
      willBeApplied: willBeApplied,
      rate: surchargeRate
    };
  }

  /**
   * A *fresh* HostedFieldsState object every time. React bails out of a
   * re-render when setState is handed the same reference, so sharing one
   * object across emits would silently freeze the UI.
   */
  function snapshot() {
    var fields = {};
    var keys = Object.keys(fieldConfigs);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      fields[key] = {
        containerId: fieldConfigs[key],
        // Never "loading": the mock has no iframes to wait for, and
        // HostedFieldInput spins forever until this is false.
        loading: false,
        error: errors[key] || null
      };
    }

    var state = {
      activeForm: activeForm,
      fields: fields,
      loading: false,
      paymentProcessing: paymentProcessing,
      paymentMethod: currentPaymentMethod(),
      surcharging: currentSurcharging()
    };

    var cardData = currentCardData();
    if (cardData) state.cardData = cardData;
    if (loadError) state.loadError = loadError;
    if (paymentLink) {
      state.paymentLink = {
        id: paymentLink.id,
        totalAmount: paymentLink.totalAmount
      };
    }

    return state;
  }

  function emit(type) {
    var event = { type: type, state: snapshot() };
    var snapshotOfListeners = listeners.slice();
    for (var i = 0; i < snapshotOfListeners.length; i++) {
      try {
        snapshotOfListeners[i](event);
      } catch (e) {
        // A throwing consumer must not break the other listeners.
        if (window.console && window.console.error) {
          window.console.error('[hosted-fields shim] listener threw', e);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // DOM: one <input> appended into each container the app hands us.
  // -------------------------------------------------------------------------

  function onFieldInput(key, input) {
    return function () {
      values[key] = input.value;
      errors[key] = null;
      emit('change');
    };
  }

  function attachField(key) {
    var containerId = fieldConfigs[key];
    if (!containerId) return false;
    var container = document.getElementById(containerId);
    if (!container) return false;

    var selector = '[data-testid="hf-' + key + '"]';
    if (container.querySelector(selector)) return false;

    var input = document.createElement('input');
    input.setAttribute('type', 'text');
    input.setAttribute('data-testid', 'hf-' + key);
    input.setAttribute('aria-label', key);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('data-lpignore', 'true');
    input.style.border = 'none';
    input.style.outline = 'none';
    input.style.background = 'transparent';
    input.style.padding = '0';
    input.style.margin = '0';
    input.style.width = '100%';
    input.style.height = '100%';
    input.style.font = 'inherit';
    input.style.color = 'inherit';
    // Survive a React remount of the container (tab switches, modal reopen).
    input.value = values[key] || '';
    input.addEventListener('input', onFieldInput(key, input));
    container.appendChild(input);
    return true;
  }

  /** Returns the number of inputs newly attached. */
  function attachFields() {
    var attached = 0;
    for (var i = 0; i < ALL_KEYS.length; i++) {
      if (attachField(ALL_KEYS[i])) attached++;
    }
    return attached;
  }

  /**
   * Push `values` back into whatever inputs are already in the DOM. Needed when
   * init() runs again on a new token against containers React did not remount:
   * without this the box still shows the old card number while the shim would
   * stage an empty one.
   */
  function syncInputsToValues() {
    for (var i = 0; i < ALL_KEYS.length; i++) {
      var key = ALL_KEYS[i];
      var containerId = fieldConfigs[key];
      if (!containerId) continue;
      var container = document.getElementById(containerId);
      if (!container) continue;
      var input = container.querySelector('[data-testid="hf-' + key + '"]');
      if (input) input.value = values[key] || '';
    }
  }

  /**
   * Containers can appear after init(): the stored-payment-method form lives in
   * a Chakra portal, and React remounts containers on tab/route changes. Watch
   * the document and (re)attach whenever that happens.
   */
  function startObserver() {
    if (observer || typeof window.MutationObserver !== 'function') return;
    var root = document.documentElement || document.body;
    if (!root) return;
    observer = new window.MutationObserver(function () {
      if (!initialized) return;
      // Appending our own input re-enters here, finds nothing to do, and stops.
      if (attachFields() > 0) emit('change');
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  // -------------------------------------------------------------------------
  // Session bootstrap
  // -------------------------------------------------------------------------

  function loadSession(sessionToken, generation) {
    if (!sessionToken) {
      loadError = new Error('Invalid payment token');
      emit('load');
      return;
    }

    var url =
      mockUrl() + '/__control/sessions/' + encodeURIComponent(sessionToken);

    window
      .fetch(url, { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 404) {
          var notFound = new Error('Invalid payment token');
          notFound.__expected = true;
          throw notFound;
        }
        if (!res.ok) {
          throw new Error(
            'Hosted fields session load failed (' + res.status + ')'
          );
        }
        return res.json();
      })
      .then(function (view) {
        if (generation !== loadGeneration) return;
        loadError = null;
        if (view && view.paymentLink) {
          paymentLink = {
            id: view.paymentLink.id,
            totalAmount: view.paymentLink.totalAmount
          };
        }
        surchargingEnabled = !!(view && view.surchargingEnabled);
        if (view && typeof view.surchargeRate === 'number') {
          surchargeRate = view.surchargeRate;
        }
        emit('load');
      })
      .catch(function (err) {
        if (generation !== loadGeneration) return;
        loadError =
          err instanceof Error ? err : new Error('Invalid payment token');
        emit('load');
      });
  }

  // -------------------------------------------------------------------------
  // Public API (src/confido-legal-hook/ConfidoLegal.d.ts)
  // -------------------------------------------------------------------------

  function init(options) {
    options = options || {};

    var nextToken = options.paymentToken || options.savePaymentMethodToken || null;
    var tokenChanged = nextToken !== token;

    token = nextToken;
    activeForm = options.activeForm === 'ach' ? 'ach' : 'card';

    fieldConfigs = {};
    var fields = options.fields || {};
    for (var i = 0; i < ALL_KEYS.length; i++) {
      var key = ALL_KEYS[i];
      var config = fields[key];
      if (config && config.containerId) fieldConfigs[key] = config.containerId;
    }

    if (tokenChanged) {
      // A new session: nothing the user typed for the old one may carry over.
      values = {};
      paymentLink = null;
      surchargingEnabled = false;
      surchargeRate = DEFAULT_SURCHARGE_RATE;
    }
    errors = {};
    loadError = null;
    paymentProcessing = false;

    var surchargingOptions = options.surchargingOptions;
    if (
      surchargingOptions &&
      typeof surchargingOptions.principalAmount === 'number' &&
      isFinite(surchargingOptions.principalAmount)
    ) {
      principalAmount = surchargingOptions.principalAmount;
    }

    initialized = true;
    attachFields();
    syncInputsToValues();
    startObserver();

    // First event: every field loading:false, so the spinners clear even if the
    // control API is slow or unreachable.
    emit('init');

    loadSession(token, ++loadGeneration);
  }

  function addChangeListener(cb) {
    if (typeof cb !== 'function') return;
    if (listeners.indexOf(cb) === -1) listeners.push(cb);
    if (!initialized) return;
    // A listener that arrives after init() (React remount, second consumer)
    // still needs the current state, or its spinners never clear.
    window.setTimeout(function () {
      if (listeners.indexOf(cb) === -1) return;
      try {
        cb({ type: 'change', state: snapshot() });
      } catch (e) {
        if (window.console && window.console.error) {
          window.console.error('[hosted-fields shim] listener threw', e);
        }
      }
    }, 0);
  }

  function removeChangeListener(cb) {
    var index = listeners.indexOf(cb);
    if (index !== -1) listeners.splice(index, 1);
  }

  function getState() {
    return snapshot();
  }

  function setActiveForm(form) {
    activeForm = form === 'ach' ? 'ach' : 'card';
    emit('change');
  }

  function recalculateSurcharging(opts) {
    var amount = opts && opts.principalAmount;
    principalAmount =
      typeof amount === 'number' && isFinite(amount) && amount > 0 ? amount : 0;
    if (!initialized) return;
    emit('change');
  }

  function buildInstrument() {
    var instrument = {
      form: activeForm,
      paymentMethod: currentPaymentMethod()
    };

    if (activeForm === 'card') {
      var cardDigits = currentCardDigits();
      instrument.cardNumber = cardDigits;
      instrument.cardExpirationDate = trimmed(values.cardExpirationDate);
      instrument.cardSecurityCode = digitsOf(values.cardSecurityCode);
      instrument.cardBrand = brandFor(cardDigits);
      instrument.lastFour = cardDigits.slice(-4);
    } else {
      var accountDigits = digitsOf(values.accountNumber);
      instrument.accountNumber = accountDigits;
      instrument.routingNumber = digitsOf(values.routingNumber);
      instrument.accountHolderName = trimmed(values.accountHolderName);
      instrument.lastFour = accountDigits.slice(-4);
    }

    return instrument;
  }

  function submitFields() {
    return new Promise(function (resolve) {
      var required = activeForm === 'card' ? CARD_KEYS : ACH_KEYS;
      var missing = [];

      // Clear stale errors from the other form too, so switching tabs after a
      // failed submit does not leave orphaned "Required" messages behind.
      errors = {};
      for (var i = 0; i < required.length; i++) {
        var key = required[i];
        if (!trimmed(values[key])) {
          errors[key] = { message: 'Required' };
          missing.push(key);
        }
      }

      if (missing.length) {
        emit('change');
        resolve({ success: false, error: new Error('Invalid fields') });
        return;
      }

      paymentProcessing = true;
      emit('change');

      var finish = function (result) {
        paymentProcessing = false;
        emit('change');
        resolve(result);
      };

      if (!token) {
        finish({ success: false, error: new Error('Invalid payment token') });
        return;
      }

      var url =
        mockUrl() +
        '/__control/sessions/' +
        encodeURIComponent(token) +
        '/stage';

      window
        .fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildInstrument())
        })
        .then(function (res) {
          if (!res.ok) {
            throw new Error(
              'Failed to stage payment instrument (' + res.status + ')'
            );
          }
          finish({ success: true });
        })
        .catch(function (err) {
          finish({
            success: false,
            error: err instanceof Error ? err : new Error(String(err))
          });
        });
    });
  }

  window.gravityLegal = {
    addChangeListener: addChangeListener,
    getState: getState,
    init: init,
    recalculateSurcharging: recalculateSurcharging,
    removeChangeListener: removeChangeListener,
    setActiveForm: setActiveForm,
    submitFields: submitFields
  };

  window.__hostedFieldsShim = { version: 1 };
})();
