(() => {
  const $ = (id) => document.getElementById(id);
  const THEME_KEY = 'syncify-theme';

  let displays = [];
  let layout = { edge: 'bottom', displayId: null };
  let connected = false;

  function addLog(msg) {
    const li = document.createElement('li');
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.textContent = `${t} — ${msg}`;
    const log = $('log');
    log.prepend(li);
    while (log.children.length > 40) log.lastChild.remove();
  }

  function setStatus(text, mode) {
    $('statusText').textContent = text;
    const dot = $('dot');
    dot.className = 'dot' + (mode ? ` ${mode}` : '');
  }

  function setConnectedUI(on) {
    connected = on;
    $('btnDisconnect').classList.toggle('hidden', !on);
    $('btnHost').disabled = on;
    $('btnJoin').disabled = on;
  }

  function selectTab(whichtab) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === whichtab));
    $('panel-host').classList.toggle('hidden', whichtab !== 'host');
    $('panel-join').classList.toggle('hidden', whichtab !== 'join');
  }

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
    $('themeIcon').textContent = next === 'dark' ? '☀' : '☾';
    $('btnTheme').title = next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function selectedDisplay() {
    return displays.find((d) => d.id === layout.displayId) || displays[0] || null;
  }

  function updateLayoutSummary() {
    const d = selectedDisplay();
    const edgeLabel = { top: 'top', bottom: 'bottom', left: 'left', right: 'right' }[layout.edge] || layout.edge;
    const name = d ? d.label : 'screen';
    $('layoutSummary').textContent = `Exit via ${edgeLabel} of ${name}`;
  }

  function persistLayout() {
    updateLayoutSummary();
    window.syncify.setLayout(layout);
  }

  function renderMonitorMap() {
    const map = $('monitorMap');
    map.innerHTML = '';
    if (!displays.length) {
      map.textContent = 'No displays found';
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of displays) {
      const { x, y, width, height } = d.bounds;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    const pad = 10;
    const vw = map.clientWidth || 360;
    const vh = map.clientHeight || 110;
    const worldW = Math.max(1, maxX - minX);
    const worldH = Math.max(1, maxY - minY);
    const scale = Math.min((vw - pad * 2) / worldW, (vh - pad * 2) / worldH);

    for (const d of displays) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'monitor-tile' + (d.id === layout.displayId ? ' active' : '');
      btn.style.left = `${pad + (d.bounds.x - minX) * scale}px`;
      btn.style.top = `${pad + (d.bounds.y - minY) * scale}px`;
      btn.style.width = `${Math.max(56, d.bounds.width * scale)}px`;
      btn.style.height = `${Math.max(36, d.bounds.height * scale)}px`;
      btn.innerHTML = `${d.label}<span>${d.bounds.width}×${d.bounds.height}</span>`;
      btn.title = `Use ${d.label} monitor`;
      btn.addEventListener('click', () => {
        layout.displayId = d.id;
        renderMonitorMap();
        persistLayout();
        addLog(`Exit monitor: ${d.label}`);
      });
      map.appendChild(btn);
    }
  }

  function syncEdgeButtons() {
    document.querySelectorAll('.layout-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.layout === layout.edge);
    });
  }

  document.querySelectorAll('.layout-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      layout.edge = btn.dataset.layout;
      syncEdgeButtons();
      persistLayout();
      addLog(`Exit edge: ${layout.edge}`);
    });
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  });

  $('btnTheme').addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });

  $('btnHost').addEventListener('click', async () => {
    const port = Number($('hostPort').value) || 24892;
    const res = await window.syncify.host({ port, layout });
    if (!res.ok) {
      addLog(res.error || 'Failed to host');
      return;
    }
    setConnectedUI(true);
    setStatus(`Hosting on ${port}`, 'host');
  });

  $('btnJoin').addEventListener('click', async () => {
    const host = $('joinHost').value.trim();
    const port = Number($('joinPort').value) || 24892;
    if (!host) {
      addLog('Enter the other computer’s IP address');
      return;
    }
    const res = await window.syncify.connect({ host, port, layout });
    if (!res.ok) {
      addLog(res.error || 'Failed to connect');
      return;
    }
    setConnectedUI(true);
    setStatus(res.reconnecting ? `Reconnecting to ${host}…` : `Connected to ${host}`, res.reconnecting ? 'host' : 'on');
  });

  $('btnDisconnect').addEventListener('click', async () => {
    await window.syncify.disconnect();
    setConnectedUI(false);
    $('btnRelease').classList.add('hidden');
    setStatus('Idle');
    $('peerMeta').textContent = 'No peer connected';
    addLog('Disconnected — auto-reconnect off');
  });

  $('btnRelease').addEventListener('click', () => window.syncify.releaseControl());

  $('mouseShareToggle').addEventListener('change', async () => {
    const on = $('mouseShareToggle').checked;
    const res = await window.syncify.setMouseShare(on);
    $('mouseShareToggle').checked = !!(res && res.mouseShareEnabled);
    addLog(res.mouseShareEnabled ? 'Mouse sync enabled' : 'Mouse sync disabled');
  });

  window.syncify.onSettings((s) => {
    if (typeof s.mouseShareEnabled === 'boolean') {
      $('mouseShareToggle').checked = s.mouseShareEnabled;
    }
  });

  window.syncify.onStatus((s) => {
    if (s.state === 'hosting') {
      setStatus(s.waiting ? `Hosting — waiting for peer` : `Hosting on ${s.port || '…'}`, 'host');
      setConnectedUI(true);
    }
    if (s.state === 'connected') {
      setStatus('Connected', 'on');
      setConnectedUI(true);
    }
    if (s.state === 'reconnecting') {
      setStatus(`Reconnecting${s.host ? ` to ${s.host}` : ''}…`, 'host');
      setConnectedUI(true);
      selectTab('join');
    }
    if (s.state === 'paired') {
      setStatus(s.beingControlled ? 'Being controlled' : 'Paired', s.beingControlled ? 'remote' : 'on');
      setConnectedUI(true);
    }
    if (s.state === 'idle') {
      setStatus('Idle');
      setConnectedUI(false);
    }
  });

  window.syncify.onPeer((p) => {
    if (!p) {
      $('peerMeta').textContent = 'No peer connected';
      return;
    }
    const scr = p.screen ? `${p.screen.width}×${p.screen.height}` : '';
    $('peerMeta').textContent = `Peer: ${p.name} · ${p.platform}${scr ? ` · ${scr}` : ''}`;
  });

  window.syncify.onLog(addLog);

  window.syncify.onControl((c) => {
    $('btnRelease').classList.toggle('hidden', !(c.remote || c.beingControlled));
    if (c.remote) setStatus('Controlling remote', 'remote');
    else if (c.beingControlled) setStatus('Being controlled', 'remote');
    else setStatus('Paired', 'on');
  });

  // Dark by default; remember last choice
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

  (async () => {
    const info = await window.syncify.getInfo();
    $('hostPort').value = info.defaultPort;
    $('joinPort').value = info.defaultPort;
    const ips = (info.addresses || []).map((a) => a.address).join(', ') || 'No LAN IP found';
    $('ipList').textContent = `This PC: ${info.hostname} · ${ips}`;
    $('hostMeta').textContent = `${info.hostname} · ${info.platform} · ${info.screen.width}×${info.screen.height}`;

    displays = info.displays || [];
    const leftmost = [...displays].sort((a, b) => a.bounds.x - b.bounds.x)[0];
    const savedLayout = (info.session && info.session.layout) || info.layout;
    layout = {
      edge: (savedLayout && savedLayout.edge) || 'bottom',
      displayId: (savedLayout && savedLayout.displayId) || (leftmost && leftmost.id) || null,
    };

    if (info.session && info.session.enabled) {
      if (info.session.port) {
        $('hostPort').value = info.session.port;
        $('joinPort').value = info.session.port;
      }
      if (info.session.host) $('joinHost').value = info.session.host;
      selectTab(info.session.role === 'client' ? 'join' : 'host');
      setConnectedUI(true);
      setStatus(info.session.role === 'host' ? 'Restoring host…' : 'Reconnecting…', 'host');
      addLog('Auto-reconnect is on — stays linked until you Disconnect');
    }

    syncEdgeButtons();
    renderMonitorMap();
    persistLayout();

    if (!info.inputReady) {
      $('inputWarn').classList.remove('hidden');
      $('inputWarn').textContent =
        'Input modules not ready. Run: npm install && npm run rebuild — then restart. Clipboard sync still works.';
    }
    $('mouseShareToggle').checked = info.mouseShareEnabled !== false;
    addLog(info.mouseShareEnabled !== false ? 'Mouse sync on' : 'Mouse sync off');
    addLog('Ready');
  })();

  window.addEventListener('resize', () => renderMonitorMap());
})();
