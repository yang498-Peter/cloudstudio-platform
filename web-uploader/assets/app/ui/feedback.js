import { TOAST_DEFAULT_MS } from '../core/constants.js';

export function createFeedbackUi({
  getTranslator = null,
  getLocale = null,
  toastContainerId = 'toasts',
  statusElementId = null,
  statusValueSelector = null,
  statusClassName = '',
} = {}) {
  function resolveTranslator() {
    const translator = typeof getTranslator === 'function' ? getTranslator() : getTranslator;
    if (typeof translator === 'function') return translator;
    if (translator && typeof translator.translateText === 'function') {
      return value => translator.translateText(value);
    }
    if (translator && typeof translator.t === 'function') {
      return value => translator.t(value, {}, value);
    }
    return null;
  }

  const translate = (value) => {
    if (typeof value !== 'string') return value;
    const translator = resolveTranslator();
    return translator ? translator(value) : value;
  };

  function toast(message, type = 'info', ms = TOAST_DEFAULT_MS, options = {}) {
    const container = document.getElementById(options.toastContainerId || toastContainerId);
    if (!container) return null;
    const el = document.createElement('div');
    el.className = options.className || `toast ${type}`;
    el.textContent = options.translate === false ? message : translate(message);
    container.appendChild(el);
    const duration = Number.isFinite(ms) ? ms : TOAST_DEFAULT_MS;
    window.setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = options.dismissTransform || 'translateY(5px)';
      window.setTimeout(() => el.remove(), 300);
    }, duration);
    return el;
  }

  function setStatus(message, { type = '', raw = false } = {}) {
    if (!statusElementId) return null;
    const root = document.getElementById(statusElementId);
    if (!root) return null;
    const target = statusValueSelector ? root.querySelector(statusValueSelector) : root;
    if (!target) return null;
    if (statusClassName) {
      root.className = `${statusClassName} ${type || ''}`.trim();
    }
    target.textContent = raw ? message : translate(message);
    return target;
  }

  function setModalMessage(elementOrId, message, { type = '', raw = false, extraClass = '' } = {}) {
    const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!el) return null;
    const classNames = [type, extraClass].filter(Boolean).join(' ').trim();
    if (classNames) el.className = classNames;
    el.textContent = raw ? message : translate(message);
    return el;
  }

  return {
    getLocale() {
      return typeof getLocale === 'function' ? getLocale() : undefined;
    },
    toast,
    setStatus,
    setModalMessage,
  };
}
