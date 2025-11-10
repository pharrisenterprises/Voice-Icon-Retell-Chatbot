/* public/embed.js
 * Voice-only widget loader with in-iframe launcher.
 * Exposes: window.AvatarWidget = { mount, open, close, gesture }
 * Emits window events: avatar-widget:ready|opened|closed
 */
(function () {
  var WNS = '__AvatarWidgetState__';
  var CLOSED_SIZE = { width: 84, height: 84 };
  var OPEN_SIZE = { width: 420, height: 580 };

  if (!window[WNS]) {
    window[WNS] = {
      mounted: false,
      open: false,
      opts: null,
      origin: (function () {
        try {
          var s = document.currentScript;
          if (s && s.src) {
            var a = document.createElement('a');
            a.href = s.src;
            return a.protocol + '//' + a.host;
          }
        } catch (e) {}
        return window.location.origin;
      })(),
      elements: { container: null, iframe: null },
      frameReady: false,
      queue: [],
      readyListener: false,
      resizeListener: null,
      lastSize: { width: CLOSED_SIZE.width, height: CLOSED_SIZE.height, open: false, compact: false },
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
      .avatar-widget-container{position:fixed;right:20px;bottom:24px;width:${CLOSED_SIZE.width}px;height:${CLOSED_SIZE.height}px;z-index:2147483000;display:flex;align-items:stretch;justify-content:stretch;transition:width .25s ease,height .25s ease}
      .avatar-widget-hidden{display:none!important}
      .avatar-widget-container.avatar-widget-compact{right:12px;bottom:16px}
      .avatar-widget-iframe{border:0;width:100%;height:100%;background:transparent}
    `;
    document.head.appendChild(style);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function coerceSize(payload) {
    var width = typeof payload.width === 'number' ? payload.width : (payload.open ? OPEN_SIZE.width : CLOSED_SIZE.width);
    var height = typeof payload.height === 'number' ? payload.height : (payload.open ? OPEN_SIZE.height : CLOSED_SIZE.height);
    var vw = window.innerWidth || document.documentElement.clientWidth || width;
    var vh = window.innerHeight || document.documentElement.clientHeight || height;
    var pad = payload.open ? 24 : 16;
    var maxWidth = Math.max(80, vw - pad);
    var maxHeight = Math.max(80, vh - pad);
    if (payload.compact) {
      maxWidth = Math.max(72, vw - pad);
      maxHeight = Math.max(120, vh - pad);
    }
    return {
      width: clamp(width, CLOSED_SIZE.width, maxWidth),
      height: clamp(height, CLOSED_SIZE.height, maxHeight)
    };
  }

  function setContainerSize(payload) {
    var S = window[WNS];
    var container = S.elements.container;
    if (!container) return;
    var dims = coerceSize(payload || S.lastSize || {});
    container.style.width = dims.width + 'px';
    container.style.height = dims.height + 'px';
    if (payload && typeof payload.compact === 'boolean') {
      if (payload.compact) container.classList.add('avatar-widget-compact');
      else container.classList.remove('avatar-widget-compact');
    }
  }

  function ensureResizeListener() {
    var S = window[WNS];
    if (S.resizeListener) return;
    S.resizeListener = function () { setContainerSize(S.lastSize); };
    window.addEventListener('resize', S.resizeListener);
  }

  function buildDOM(opts) {
    var S = window[WNS];
    if (S.elements.container) return;
    ensureStyles();

    var container = document.createElement('div');
    container.className = 'avatar-widget-container';
    container.setAttribute('role', 'complementary');
    container.setAttribute('aria-label', 'Voice assistant dock');

    if (opts && opts.offset) {
      if (typeof opts.offset.right === 'number') container.style.right = opts.offset.right + 'px';
      if (typeof opts.offset.bottom === 'number') container.style.bottom = opts.offset.bottom + 'px';
    }

    var iframe = document.createElement('iframe');
    iframe.className = 'avatar-widget-iframe';
    iframe.allow = 'microphone; autoplay; clipboard-read; clipboard-write; speaker-selection';
    iframe.title = 'Otto voice assistant';

    container.appendChild(iframe);
    document.body.appendChild(container);

    S.elements.container = container;
    S.elements.iframe = iframe;
    setContainerSize(S.lastSize);
    ensureResizeListener();
  }

  function setIframeSrc() {
    var S = window[WNS], iframe = S.elements.iframe; if (!iframe) return;
    if (!iframe.src) {
      S.frameReady = false;
      S.queue.length = 0;
      iframe.src = S.origin + '/embed';
    }
  }

  function flushQueue() {
    var S = window[WNS];
    if (!S.frameReady) return;
    while (S.queue.length) {
      postToFrame(S.queue.shift(), true);
    }
  }

  function postToFrame(type, bypassQueue) {
    var S = window[WNS];
    if (!bypassQueue && !S.frameReady) {
      S.queue.push(type);
      return;
    }
    try {
      var f = S.elements.iframe;
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'avatar-widget:' + type }, '*');
    } catch (e) {}
  }

  function handleFrameMessage(evt) {
    var S = window[WNS];
    var data = evt && evt.data;
    if (!data || typeof data !== 'object') return;
    if (S.origin && evt.origin && evt.origin !== S.origin) return;

    if (data.type === 'avatar-widget:ready') {
      S.frameReady = true;
      flushQueue();
      if (S.open) postToFrame('open', true);
      emit('ready', { frame: true });
      return;
    }

    if (data.type === 'avatar-widget:size') {
      S.lastSize = {
        width: typeof data.width === 'number' ? data.width : undefined,
        height: typeof data.height === 'number' ? data.height : undefined,
        open: !!data.open,
        compact: !!data.compact
      };
      setContainerSize(S.lastSize);
    }
  }

  function bindReadyListener() {
    var S = window[WNS];
    if (S.readyListener) return;
    S.readyListener = true;
    window.addEventListener('message', handleFrameMessage);
  }

  function mount(opts) {
    var S = window[WNS];
    if (S.mounted) {
      if (S.elements.container && opts && opts.offset) {
        if (typeof opts.offset.right === 'number') S.elements.container.style.right = opts.offset.right + 'px';
        if (typeof opts.offset.bottom === 'number') S.elements.container.style.bottom = opts.offset.bottom + 'px';
      }
      emit('ready', { updated: true });
      return;
    }
    S.opts = opts || {};
    buildDOM(S.opts);
    bindReadyListener();
    setIframeSrc();
    S.mounted = true;
    emit('ready', { mounted: true });
  }

  function open() {
    var S = window[WNS]; if (!S.mounted) mount({});
    setIframeSrc();
    S.open = true;
    emit('opened');
    postToFrame('open');
  }

  function close() {
    var S = window[WNS]; if (!S.mounted) return;
    S.open = false;
    emit('closed');
    postToFrame('close');
  }

  function gesture() {
    var S = window[WNS];
    if (!S.mounted) mount({});
    setIframeSrc();
    postToFrame('gesture');
  }

  function isOpen() {
    var S = window[WNS];
    return !!S.open;
  }

  var API = { mount: mount, open: open, close: close, gesture: gesture, isOpen: isOpen };
  window.AvatarWidget = API;
})();
