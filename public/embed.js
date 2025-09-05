/* public/embed.js
 * Voice-only Retell widget loader (dock + optional overlay), idempotent.
 * Exposes: window.AvatarWidget = { mount, open, close }
 * Emits:   avatar-widget:ready | avatar-widget:opened | avatar-widget:closed
 *
 * Iframe src remains:
 *   ORIGIN + '/embed?autostart=1&layout=compact&videoFirst=1'
 * allow attr:
 *   allow="microphone; autoplay; clipboard-read; clipboard-write; speaker-selection"
 */
(function () {
  var WNS = '__AvatarWidgetState__';
  if (!window[WNS]) {
    window[WNS] = {
      mounted: false,
      open: false,
      opts: null,
      origin: (function () {
        try {
          var s = document.currentScript;
          if (s && s.src) { var a = document.createElement('a'); a.href = s.src; return a.protocol + '//' + a.host; }
        } catch (e) {}
        return window.location.origin;
      })(),
      elements: { wrap: null, shell: null, iframe: null, header: null, closeBtn: null },
    };
  }

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent('avatar-widget:' + name, { detail: detail || {} })); } catch (e) {}
  }

  function ensureStyles() {
    if (document.getElementById('avatar-widget-styles')) return;
    var style = document.createElement('style');
    style.id = 'avatar-widget-styles';
    style.textContent = `
      .aw-wrap { position: fixed; z-index: 2147483000; inset: auto auto 88px  auto; right: 20px; }
      .aw-hidden { display: none !important; }
      .aw-shell {
        width: 420px; max-width: calc(100vw - 20px);
        height: 560px; max-height: calc(100vh - 20px);
        border-radius: 16px;
        position: relative;
        padding: 1px; /* holographic border */
        background: linear-gradient(120deg, rgba(125,211,252,.55), rgba(96,165,250,.35), rgba(59,130,246,.55)) border-box;
        box-shadow:
          0 20px 60px rgba(0,0,0,.35),
          0 0 24px rgba(96,165,250,.25),
          inset 0 0 10px rgba(125,211,252,.25);
        border: 1px solid rgba(255,255,255,.08);
      }
      .aw-header {
        position: absolute; inset: 0 0 auto 0; height: 42px;
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 10px; border-bottom: 1px solid rgba(255,255,255,.08);
        background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
        color: #e6e8ee; font-size: 13px; letter-spacing: .2px; border-top-left-radius: 15px; border-top-right-radius: 15px;
      }
      .aw-title { opacity: .9; }
      .aw-close {
        appearance: none; border: 0; background: transparent; color: #cfd3dc;
        width: 28px; height: 28px; border-radius: 6px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .aw-close:hover { background: rgba(255,255,255,.08); color: #fff; }
      .aw-iframe {
        position: absolute; inset: 0; top: 42px; height: calc(100% - 42px);
        width: 100%; border: 0; background: #0b0f19; border-bottom-left-radius: 15px; border-bottom-right-radius: 15px;
      }
      @media (max-width: 480px) {
        .aw-wrap { right: 10px !important; bottom: 10px !important; }
        .aw-shell { width: calc(100vw - 20px) !important; height: min(70vh, 560px) !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function buildDOM(opts) {
    var S = window[WNS];
    if (S.elements.wrap) return;

    ensureStyles();

    var wrap = document.createElement('div');
    wrap.className = 'aw-wrap aw-hidden';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Voice assistant');

    // position & size overrides
    if (opts && opts.offset) {
      if (typeof opts.offset.right === 'number') wrap.style.right = opts.offset.right + 'px';
      if (typeof opts.offset.bottom === 'number') wrap.style.bottom = opts.offset.bottom + 'px';
    }

    var shell = document.createElement('div');
    shell.className = 'aw-shell';
    if (opts && opts.size) {
      if (typeof opts.size.width === 'number') shell.style.width = opts.size.width + 'px';
      if (typeof opts.size.height === 'number') shell.style.height = opts.size.height + 'px';
    }

    var header = document.createElement('div');
    header.className = 'aw-header';
    var title = document.createElement('div');
    title.className = 'aw-title';
    title.textContent = 'Assistant';
    var close = document.createElement('button');
    close.className = 'aw-close';
    close.setAttribute('title', 'Close');
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&#x2715;';
    close.addEventListener('click', function () { API.close(); });

    header.appendChild(title); header.appendChild(close);

    var iframe = document.createElement('iframe');
    iframe.className = 'aw-iframe';
    iframe.allow = 'microphone; autoplay; clipboard-read; clipboard-write; speaker-selection';
    // src set when open()

    shell.appendChild(header);
    shell.appendChild(iframe);
    wrap.appendChild(shell);
    document.body.appendChild(wrap);

    // ESC closes (useful on overlay UX)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !wrap.classList.contains('aw-hidden')) { API.close(); }
    });

    S.elements.wrap = wrap; S.elements.shell = shell;
    S.elements.header = header; S.elements.closeBtn = close; S.elements.iframe = iframe;
  }

  function setIframeSrc() {
    var S = window[WNS];
    var iframe = S.elements.iframe;
    if (!iframe) return;
    if (!iframe.src) {
      iframe.src = S.origin + '/embed?autostart=1&layout=compact&videoFirst=1';
    }
  }

  function postToIframe(type, payload) {
    var S = window[WNS];
    var iframe = S.elements.iframe;
    try { iframe && iframe.contentWindow && iframe.contentWindow.postMessage({ type, payload: payload || {} }, '*'); } catch (e) {}
  }

  function mount(opts) {
    var S = window[WNS];
    if (S.mounted) {
      if (S.elements.shell && opts) {
        if (opts.size) {
          if (typeof opts.size.width === 'number') S.elements.shell.style.width = opts.size.width + 'px';
          if (typeof opts.size.height === 'number') S.elements.shell.style.height = opts.size.height + 'px';
        }
        if (opts.offset) {
          if (typeof opts.offset.right === 'number') S.elements.wrap.style.right = opts.offset.right + 'px';
          if (typeof opts.offset.bottom === 'number') S.elements.wrap.style.bottom = opts.offset.bottom + 'px';
        }
      }
      emit('ready', { updated: true });
      return;
    }
    S.opts = opts || {};
    buildDOM(S.opts);
    S.mounted = true;
    emit('ready', { mounted: true });
  }

  function open() {
    var S = window[WNS];
    if (!S.mounted) mount({});
    if (S.open) return;
    var wrap = S.elements.wrap; if (!wrap) return;
    wrap.classList.remove('aw-hidden');
    setIframeSrc();
    S.open = true;
    emit('opened');
    // Tell the iframe we were opened (use user gesture timing)
    setTimeout(function(){ postToIframe('avatar-widget:open'); }, 30);
  }

  function close() {
    var S = window[WNS];
    if (!S.mounted || !S.open) return;
    postToIframe('avatar-widget:close'); // stop mic/audio inside iframe
    var wrap = S.elements.wrap; if (wrap) wrap.classList.add('aw-hidden');
    S.open = false;
    emit('closed');
  }

  var API = { mount: mount, open: open, close: close };
  window.AvatarWidget = API;
})();
