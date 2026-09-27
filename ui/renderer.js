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
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isHost = tab.dataset.tab === 'host';
      $('panel-host').classList.toggle('hidden', !isHost);
      $('panel-join').classList.toggle('hidden', isHost);
    });
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
    setStatus(`Connected to ${host}`, 'on');
  });

  $('btnDisconnect').addEventListener('click', async () => {
    await window.syncify.disconnect();
    setConnectedUI(false);
    $('btnRelease').classList.add('hidden');
    setStatus('Idle');
    $('peerMeta').textContent = 'No peer connected';
    addLog('Disconnected');
  });

  $('btnRelease').addEventListener('click', () => window.syncify.releaseControl());

  window.syncify.onStatus((s) => {
    if (s.state === 'hosting') setStatus(`Hosting on ${s.port || '…'}`, 'host');
    if (s.state === 'connected') setStatus('Connected', 'on');
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
    $('btnRelease').classList.toggle('hidden', !c.remote);
    if (c.remote) setStatus('Controlling remote', 'remote');
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
    // Prefer leftmost for “Mac below left” setups
    const leftmost = [...displays].sort((a, b) => a.bounds.x - b.bounds.x)[0];
    layout = {
      edge: (info.layout && info.layout.edge) || 'bottom',
      displayId: (info.layout && info.layout.displayId) || (leftmost && leftmost.id) || null,
    };
    syncEdgeButtons();
    renderMonitorMap();
    persistLayout();

    if (!info.inputReady) {
      $('inputWarn').classList.remove('hidden');
      $('inputWarn').textContent =
        'Input modules not ready. Run: npm install && npm run rebuild — then restart. Clipboard sync still works.';
    }
    addLog('Ready');
  })();

  window.addEventListener('resize', () => renderMonitorMap());
})();
