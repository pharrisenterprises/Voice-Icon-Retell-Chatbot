/* public/embed.js
 * Voice-only widget loader, dock mode, idempotent.
 * Exposes: window.AvatarWidget = { mount, open, close }
 * Emits window events: avatar-widget:ready|opened|closed
 * Posts messages into the iframe: {type:'avatar-widget:open'|'avatar-widget:close'}
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
      elements: { container: null, iframe: null, header: null, closeBtn: null },
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
      .avatar-widget-container{position:fixed;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
      .avatar-widget-hidden{display:none!important}
      .avatar-widget-dock{right:20px;bottom:88px;width:420px;max-width:calc(100vw - 20px);height:560px;max-height:calc(100vh - 20px);border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);background:#0b0f19;display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.08)}
      .avatar-widget-header{flex:0 0 40px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));color:#e6e8ee;font-size:13px;border-bottom:1px solid rgba(255,255,255,.08)}
      .avatar-widget-header .title{opacity:.9}
      .avatar-widget-close{appearance:none;border:0;background:transparent;color:#cfd3dc;width:28px;height:28px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
      .avatar-widget-close:hover{background:rgba(255,255,255,.08);color:#fff}
      .avatar-widget-iframe{border:0;width:100%;height:calc(100% - 40px);background:#0b0f19}
      @media (max-width:480px){.avatar-widget-dock{right:10px!important;bottom:10px!important;width:calc(100vw - 20px)!important;height:min(70vh,560px)!important}}
    `;
    document.head.appendChild(style);
  }

  function buildDOM(opts) {
    var S = window[WNS];
    if (S.elements.container) return;
    ensureStyles();

    var container = document.createElement('div');
    container.className = 'avatar-widget-container avatar-widget-dock avatar-widget-hidden';
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-label', 'Voice assistant');

    if (opts && opts.offset) {
      if (typeof opts.offset.right === 'number') container.style.right = opts.offset.right + 'px';
      if (typeof opts.offset.bottom === 'number') container.style.bottom = opts.offset.bottom + 'px';
    }
    if (opts && opts.size) {
      if (typeof opts.size.width === 'number') container.style.width = opts.size.width + 'px';
      if (typeof opts.size.height === 'number') container.style.height = opts.size.height + 'px';
    }

    var header = document.createElement('div');
    header.className = 'avatar-widget-header';
    var title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Assistant';
    var close = document.createElement('button');
    close.className = 'avatar-widget-close';
    close.title = close.setAttribute('aria-label','Close') || 'Close';
    close.innerHTML = '&#x2715;';
    close.addEventListener('click', function () { API.close(); });

    header.appendChild(title); header.appendChild(close);

    var iframe = document.createElement('iframe');
    iframe.className = 'avatar-widget-iframe';
    iframe.allow = 'microphone; autoplay; clipboard-read; clipboard-write; speaker-selection';

    container.appendChild(header);
    container.appendChild(iframe);
    document.body.appendChild(container);

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !container.classList.contains('avatar-widget-hidden')) API.close(); });

    S.elements.container = container; S.elements.header = header; S.elements.iframe = iframe; S.elements.closeBtn = close;
  }

  function setIframeSrc() {
    var S = window[WNS], iframe = S.elements.iframe; if (!iframe) return;
    if (!iframe.src) iframe.src = S.origin + '/embed?layout=compact&videoFirst=1';
  }

  function postToFrame(type) {
    try {
      var S = window[WNS], f = S.elements.iframe;
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'avatar-widget:' + type }, '*');
    } catch (e) {}
  }

  function mount(opts) {
    var S = window[WNS];
    if (S.mounted) {
      if (S.elements.container && opts) {
        if (opts.size) { if (typeof opts.size.width==='number') S.elements.container.style.width = opts.size.width + 'px'; if (typeof opts.size.height==='number') S.elements.container.style.height = opts.size.height + 'px'; }
        if (opts.offset) { if (typeof opts.offset.right==='number') S.elements.container.style.right = opts.offset.right + 'px'; if (typeof opts.offset.bottom==='number') S.elements.container.style.bottom = opts.offset.bottom + 'px'; }
      }
      emit('ready', { updated: true }); return;
    }
    S.opts = opts || {};
    buildDOM(S.opts);
    S.mounted = true;
    emit('ready', { mounted: true });
  }

  function open() {
    var S = window[WNS]; if (!S.mounted) mount({});
    if (S.open) return;
    var c = S.elements.container; if (!c) return;
    c.classList.remove('avatar-widget-hidden');
    setIframeSrc();
    S.open = true;
    emit('opened'); postToFrame('open');
  }

  function close() {
    var S = window[WNS]; if (!S.mounted || !S.open) return;
    var c = S.elements.container; if (c) c.classList.add('avatar-widget-hidden');
    S.open = false;
    emit('closed'); postToFrame('close');
  }

  var API = { mount: mount, open: open, close: close };
  window.AvatarWidget = API;
})();
