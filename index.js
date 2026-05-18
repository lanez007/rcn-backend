require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app  = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const STATUSES = ['NEW','QUALIFIED','DNQ','CONTACTED','SUBMITTED','FUNDED','NOT INTERESTED'];

/* ── EMAIL TRANSPORTER ── */
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/* ── INIT DB ── */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id         SERIAL PRIMARY KEY,
      fname      TEXT NOT NULL,
      lname      TEXT NOT NULL,
      dob        TEXT NOT NULL,
      ssn        TEXT NOT NULL,
      phone      TEXT,
      credit     TEXT NOT NULL,
      biz_name   TEXT NOT NULL,
      ein        TEXT NOT NULL,
      source     TEXT DEFAULT 'sms-campaign',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'NEW'`);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);
  await pool.query(`CREATE TABLE IF NOT EXISTS plaid_tokens (id SERIAL PRIMARY KEY, applicant_name TEXT, access_token TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  console.log('DB ready');
}

/* ══════════════════════════════════════
   POST /apply  – receive form submission
══════════════════════════════════════ */
app.post('/apply', async (req, res) => {
  const { fname, lname, dob, ssn, credit, phone, biz_name, ein, source } = req.body;

  /* Basic validation */
  if (!fname || !lname || !dob || !ssn || !credit || !biz_name || !ein) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    /* Save to Postgres */
    const result = await pool.query(
      `INSERT INTO applications (fname, lname, dob, ssn, credit, phone, biz_name, ein, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [fname, lname, dob, ssn, credit, phone || '', biz_name, ein, source || 'sms-campaign']
    );

    const { id, created_at } = result.rows[0];

    /* Send email notification */
    await mailer.sendMail({
      from:    `"RCN Group Leads" <${process.env.SMTP_USER}>`,
      to:      process.env.NOTIFY_EMAIL,
      subject: `New Application #${id} – ${fname} ${lname} | ${biz_name}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
          <div style="background:#0a0f1e;padding:20px 24px;">
            <span style="color:#c9a84c;font-weight:600;font-size:16px;">RCN Group – New Application</span>
          </div>
          <div style="padding:24px;">
            <p style="color:#555;font-size:13px;margin:0 0 20px;">Submitted ${new Date(created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET · Application #${id}</p>

            <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#999;margin:0 0 10px;">Owner</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
              <tr><td style="padding:6px 0;color:#999;width:40%;">Name</td><td style="padding:6px 0;color:#111;font-weight:500;">${fname} ${lname}</td></tr>
              <tr><td style="padding:6px 0;color:#999;">Date of Birth</td><td style="padding:6px 0;color:#111;">${dob}</td></tr>
              <tr><td style="padding:6px 0;color:#999;">SSN</td><td style="padding:6px 0;color:#111;font-family:monospace;">${maskSSN(ssn)}</td></tr>
              <tr><td style="padding:6px 0;color:#999;">Phone</td><td style="padding:6px 0;color:#111;">${phone || '–'}</td></tr>
              <tr><td style="padding:6px 0;color:#999;">Credit Score</td><td style="padding:6px 0;color:#111;">${credit}</td></tr>
            </table>

            <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#999;margin:0 0 10px;">Business</h3>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:6px 0;color:#999;width:40%;">Business Name</td><td style="padding:6px 0;color:#111;font-weight:500;">${biz_name}</td></tr>
              <tr><td style="padding:6px 0;color:#999;">EIN</td><td style="padding:6px 0;color:#111;font-family:monospace;">${maskEIN(ein)}</td></tr>
            </table>

            <div style="margin-top:24px;padding:14px 16px;background:#f9f6f0;border-radius:6px;font-size:13px;color:#666;">
              Source: <strong>${source || 'sms-campaign'}</strong>
            </div>
          </div>
        </div>
      `,
    });

    res.json({ success: true, id });

  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ══════════════════════════════════════
   GET /admin  – password-protected dashboard
══════════════════════════════════════ */
app.get('/admin', basicAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, fname, lname, dob, ssn, credit, phone, biz_name, ein, status, notes, created_at
       FROM applications ORDER BY created_at DESC`
    );

    const notesById = {};
    rows.forEach(r => { notesById[r.id] = r.notes || ''; });

    const rows_html = rows.map(r => {
      const status = STATUSES.includes(r.status) ? r.status : 'NEW';
      const notes = r.notes || '';
      const previewText = notes.length > 40 ? notes.slice(0, 40) + '…' : notes;
      const notesCellInner = notes
        ? `<span class="notes-preview">${escapeHtml(previewText)}</span>`
        : `<span class="notes-preview empty">+ Add note</span>`;
      return `
      <tr data-id="${r.id}" data-status="${status}">
        <td>${r.id}</td>
        <td><strong>${r.fname} ${r.lname}</strong></td>
        <td>${r.dob}</td>
        <td>${r.phone || '–'}</td>
        <td class="mono">${r.ssn}</td>
        <td><span class="badge badge-${creditClass(r.credit)}">${r.credit}</span></td>
        <td><span class="status-wrap"><span class="status-pill" data-status="${status}">${status === 'FUNDED' ? '🏆 ' : ''}${status}</span></span></td>
        <td>${r.biz_name}</td>
        <td class="mono">${r.ein}</td>
        <td>${new Date(r.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })}</td>
        <td class="notes-cell" data-id="${r.id}">${notesCellInner}</td>
      </tr>
    `;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RCN Lead Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f1eb; color: #111; min-height: 100vh; }
  header { background: #0a0f1e; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { color: #c9a84c; font-size: 16px; font-weight: 600; letter-spacing: 0.3px; }
  header span { color: rgba(240,236,227,0.4); font-size: 13px; }
  .container { padding: 28px; max-width: 1200px; margin: 0 auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .stat { background: #fff; border-radius: 10px; padding: 18px 20px; border: 1px solid #e5e0d8; }
  .stat-label { font-size: 11px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: #999; margin-bottom: 6px; }
  .stat-value { font-size: 28px; font-weight: 600; color: #111; }
  .stat-value.gold { color: #c9a84c; }
  .card { background: #fff; border-radius: 12px; border: 1px solid #e5e0d8; overflow: hidden; }
  .card-header { padding: 16px 20px; border-bottom: 1px solid #f0ece3; display: flex; align-items: center; justify-content: space-between; }
  .card-header h2 { font-size: 14px; font-weight: 600; color: #111; }
  .card-header small { font-size: 12px; color: #999; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { padding: 10px 14px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: #999; background: #faf8f5; border-bottom: 1px solid #f0ece3; }
  td { padding: 12px 14px; border-bottom: 1px solid #f9f6f0; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #faf8f5; }
  .mono { font-family: monospace; font-size: 12px; color: #666; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 50px; font-size: 11px; font-weight: 600; }
  .badge-good { background: #eaf3de; color: #3b6d11; }
  .badge-mid  { background: #faeeda; color: #854f0b; }
  .badge-low  { background: #fcebeb; color: #a32d2d; }
  .empty { text-align: center; padding: 48px; color: #999; font-size: 14px; }

  .tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 14px 20px; border-bottom: 1px solid #f0ece3; background: #fff; }
  .tab { background: #faf8f5; border: 1px solid #e5e0d8; border-radius: 50px; padding: 6px 14px; font-size: 12px; font-weight: 600; color: #555; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; font-family: inherit; }
  .tab:hover { background: #f0ece3; }
  .tab.active { background: #0a0f1e; color: #c9a84c; border-color: #0a0f1e; }
  .tab .count { background: rgba(0,0,0,0.08); border-radius: 50px; padding: 1px 8px; font-size: 11px; font-weight: 700; min-width: 18px; text-align: center; }
  .tab.active .count { background: rgba(201,168,76,0.18); color: #c9a84c; }

  .status-wrap { position: relative; display: inline-block; }
  .status-pill { display: inline-flex; align-items: center; gap: 3px; padding: 3px 10px; border-radius: 50px; font-size: 11px; font-weight: 600; color: #fff; cursor: pointer; user-select: none; white-space: nowrap; }
  .status-pill:hover { opacity: 0.88; }
  .status-pill[data-status="NEW"] { background: #7a7068; }
  .status-pill[data-status="QUALIFIED"] { background: #0a8a4a; }
  .status-pill[data-status="DNQ"] { background: #cc2244; }
  .status-pill[data-status="CONTACTED"] { background: #1a5fa8; }
  .status-pill[data-status="SUBMITTED"] { background: #6655aa; }
  .status-pill[data-status="FUNDED"] { background: #0a8a4a; }
  .status-pill[data-status="NOT INTERESTED"] { background: #9a9088; }

  .status-dropdown { position: absolute; top: calc(100% + 4px); left: 0; background: #fff; border: 1px solid #e5e0d8; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.12); z-index: 20; min-width: 160px; padding: 4px; }
  .status-dropdown .opt { padding: 6px 10px; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 600; color: #fff; margin: 2px 0; display: flex; align-items: center; gap: 4px; }
  .status-dropdown .opt:hover { opacity: 0.88; }

  .notes-cell { cursor: pointer; max-width: 220px; }
  .notes-cell:hover { background: #f7f3ec; }
  .notes-preview { display: inline-block; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; color: #444; font-size: 12px; }
  .notes-preview.empty { color: #b5ada0; font-style: italic; }
  .notes-popover { position: fixed; background: #fff; border: 1px solid #e5e0d8; border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,0.18); padding: 12px; z-index: 50; width: 324px; }
  .notes-popover textarea { width: 300px; height: 120px; padding: 8px 10px; border: 1px solid #e5e0d8; border-radius: 6px; font-family: inherit; font-size: 13px; line-height: 1.4; color: #111; resize: none; outline: none; box-sizing: border-box; display: block; }
  .notes-popover textarea:focus { border-color: #c9a84c; }
  .notes-popover .counter { font-size: 11px; color: #999; margin-top: 4px; text-align: right; }
  .notes-popover .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .notes-popover button { font-family: inherit; font-size: 12px; font-weight: 600; padding: 6px 14px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .notes-popover .btn-cancel { background: #f5f1ea; color: #555; border-color: #e5e0d8; }
  .notes-popover .btn-cancel:hover { background: #ede8dd; }
  .notes-popover .btn-save { background: #0a0f1e; color: #c9a84c; }
  .notes-popover .btn-save:hover { background: #1a1f2e; }
</style>
</head>
<body>
<header>
  <h1>RCN Group &mdash; Lead Dashboard</h1>
  <span>${rows.length} total application${rows.length !== 1 ? 's' : ''}</span>
</header>
<div class="container">
  <div class="stats">
    <div class="stat">
      <div class="stat-label">Total Leads</div>
      <div class="stat-value gold">${rows.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Today</div>
      <div class="stat-value">${rows.filter(r => new Date(r.created_at).toDateString() === new Date().toDateString()).length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Credit 650+</div>
      <div class="stat-value">${rows.filter(r => ['650 – 699','700 – 749','750+'].includes(r.credit)).length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">This Week</div>
      <div class="stat-value">${rows.filter(r => { const d = new Date(r.created_at); const now = new Date(); return (now - d) < 7 * 86400000; }).length}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Applications</h2>
      <small>Newest first &mdash; All times ET</small>
    </div>
    <div class="tabs" id="status-tabs">
      <div class="tab" data-tab="ALL">ALL <span class="count">0</span></div>
      <div class="tab" data-tab="NEW">NEW <span class="count">0</span></div>
      <div class="tab" data-tab="QUALIFIED">QUALIFIED <span class="count">0</span></div>
      <div class="tab" data-tab="DNQ">DNQ <span class="count">0</span></div>
      <div class="tab" data-tab="CONTACTED">CONTACTED <span class="count">0</span></div>
      <div class="tab" data-tab="SUBMITTED">SUBMITTED <span class="count">0</span></div>
      <div class="tab" data-tab="FUNDED">FUNDED <span class="count">0</span></div>
      <div class="tab" data-tab="NOT INTERESTED">NOT INTERESTED <span class="count">0</span></div>
    </div>
    <div style="overflow-x:auto"><table>
      <thead><tr>
        <th>#</th><th>Name</th><th>DOB</th><th>Phone</th><th>SSN</th><th>Credit</th><th>Status</th><th>Business</th><th>EIN</th><th>Submitted</th><th>Notes</th>
      </tr></thead>
      <tbody>${rows_html}</tbody>
    </table></div>
    <div id="empty-all" class="empty" style="display:${rows.length === 0 ? 'block' : 'none'}">No applications yet. Share your landing page link to start collecting leads.</div>
    <div id="empty-filter" class="empty" style="display:none">No applications match this filter.</div>
  </div>
</div>
<script>
(function() {
  var STATUSES = ['NEW','QUALIFIED','DNQ','CONTACTED','SUBMITTED','FUNDED','NOT INTERESTED'];
  var COLORS = { 'NEW':'#7a7068','QUALIFIED':'#0a8a4a','DNQ':'#cc2244','CONTACTED':'#1a5fa8','SUBMITTED':'#6655aa','FUNDED':'#0a8a4a','NOT INTERESTED':'#9a9088' };
  var TAB_KEY = 'sbf_admin_status_tab';
  var NOTES_BY_ID = ${JSON.stringify(notesById).replace(/</g, '\\u003c')};
  var NOTES_MAX = 2000;

  function getActiveTab() {
    var saved = localStorage.getItem(TAB_KEY);
    if (saved === 'ALL' || STATUSES.indexOf(saved) !== -1) return saved;
    return 'NEW';
  }

  function pillLabel(s) { return s === 'FUNDED' ? '🏆 ' + s : s; }

  function updateCounts() {
    var counts = { ALL: 0 };
    STATUSES.forEach(function(s) { counts[s] = 0; });
    document.querySelectorAll('tbody tr').forEach(function(tr) {
      counts.ALL++;
      var s = tr.dataset.status;
      if (counts[s] !== undefined) counts[s]++;
    });
    document.querySelectorAll('.tab').forEach(function(t) {
      var c = t.querySelector('.count');
      if (c) c.textContent = counts[t.dataset.tab] || 0;
    });
  }

  function applyFilter(tab) {
    var anyVisible = false;
    document.querySelectorAll('tbody tr').forEach(function(tr) {
      var show = (tab === 'ALL' || tr.dataset.status === tab);
      tr.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
    });
    var total = document.querySelectorAll('tbody tr').length;
    var emptyAll = document.getElementById('empty-all');
    var emptyFilter = document.getElementById('empty-filter');
    if (total === 0) {
      emptyAll.style.display = 'block';
      emptyFilter.style.display = 'none';
    } else {
      emptyAll.style.display = 'none';
      emptyFilter.style.display = anyVisible ? 'none' : 'block';
    }
  }

  function setActiveTab(tab) {
    localStorage.setItem(TAB_KEY, tab);
    document.querySelectorAll('.tab').forEach(function(t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    applyFilter(tab);
  }

  function closeDropdowns() {
    document.querySelectorAll('.status-dropdown').forEach(function(d) { d.remove(); });
  }

  function openDropdown(pill) {
    closeDropdowns();
    var wrap = pill.parentElement;
    var dd = document.createElement('div');
    dd.className = 'status-dropdown';
    STATUSES.forEach(function(s) {
      var o = document.createElement('div');
      o.className = 'opt';
      o.textContent = pillLabel(s);
      o.style.background = COLORS[s];
      o.addEventListener('click', function(ev) {
        ev.stopPropagation();
        changeStatus(pill, s);
        closeDropdowns();
      });
      dd.appendChild(o);
    });
    wrap.appendChild(dd);
  }

  function changeStatus(pill, status) {
    var tr = pill.closest('tr');
    var id = tr.dataset.id;
    var prev = pill.dataset.status;
    pill.dataset.status = status;
    pill.textContent = pillLabel(status);
    tr.dataset.status = status;
    fetch('/admin/applications/' + encodeURIComponent(id) + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ status: status })
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      updateCounts();
      applyFilter(getActiveTab());
    }).catch(function() {
      pill.dataset.status = prev;
      pill.textContent = pillLabel(prev);
      tr.dataset.status = prev;
      alert('Could not update status. Please try again.');
    });
  }

  function closeNotesPopover() {
    var p = document.querySelector('.notes-popover');
    if (p) p.remove();
  }

  function renderNotesCell(cell, value) {
    var span = document.createElement('span');
    span.className = 'notes-preview';
    if (value && value.length) {
      span.textContent = value.length > 40 ? value.slice(0, 40) + '…' : value;
    } else {
      span.className += ' empty';
      span.textContent = '+ Add note';
    }
    cell.textContent = '';
    cell.appendChild(span);
  }

  function saveNotes(cell, value) {
    var id = cell.dataset.id;
    if (typeof value !== 'string') value = '';
    if (value.length > NOTES_MAX) value = value.slice(0, NOTES_MAX);
    var prev = NOTES_BY_ID[id] || '';
    NOTES_BY_ID[id] = value;
    renderNotesCell(cell, value);
    closeNotesPopover();
    fetch('/admin/applications/' + encodeURIComponent(id) + '/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ notes: value })
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }).catch(function() {
      NOTES_BY_ID[id] = prev;
      renderNotesCell(cell, prev);
      alert('Could not save note. Please try again.');
    });
  }

  function openNotesPopover(cell) {
    closeNotesPopover();
    closeDropdowns();
    var id = cell.dataset.id;
    var current = NOTES_BY_ID[id] || '';

    var p = document.createElement('div');
    p.className = 'notes-popover';
    p.setAttribute('data-id', id);

    var ta = document.createElement('textarea');
    ta.maxLength = NOTES_MAX;
    ta.value = current;
    ta.placeholder = 'Add a note about this lead…';
    p.appendChild(ta);

    var counter = document.createElement('div');
    counter.className = 'counter';
    function updateCounter() { counter.textContent = ta.value.length + ' / ' + NOTES_MAX; }
    ta.addEventListener('input', updateCounter);
    updateCounter();
    p.appendChild(counter);

    var actions = document.createElement('div');
    actions.className = 'actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function(ev) { ev.stopPropagation(); closeNotesPopover(); });
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn-save';
    save.textContent = 'Save';
    save.addEventListener('click', function(ev) { ev.stopPropagation(); saveNotes(cell, ta.value); });
    actions.appendChild(cancel);
    actions.appendChild(save);
    p.appendChild(actions);

    document.body.appendChild(p);

    var rect = cell.getBoundingClientRect();
    var popW = p.offsetWidth;
    var popH = p.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var top = rect.bottom + 6;
    if (top + popH > vh - 8) top = Math.max(8, rect.top - popH - 6);
    var left = rect.right - popW;
    if (left < 8) left = 8;
    if (left + popW > vw - 8) left = vw - popW - 8;
    p.style.top = top + 'px';
    p.style.left = left + 'px';

    setTimeout(function() {
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    }, 0);
  }

  document.addEventListener('click', function(e) {
    var inStatusDropdown = e.target.closest('.status-dropdown');
    var inNotesPopover = e.target.closest('.notes-popover');
    var pill = e.target.closest('.status-pill');
    var notesCell = e.target.closest('.notes-cell');

    if (pill && !inStatusDropdown) {
      var existingDD = pill.parentElement.querySelector('.status-dropdown');
      closeDropdowns();
      closeNotesPopover();
      if (!existingDD) openDropdown(pill);
      return;
    }

    if (notesCell && !inNotesPopover) {
      var existingPop = document.querySelector('.notes-popover');
      var sameCell = existingPop && existingPop.getAttribute('data-id') === notesCell.dataset.id;
      closeDropdowns();
      closeNotesPopover();
      if (!sameCell) openNotesPopover(notesCell);
      return;
    }

    if (inStatusDropdown || inNotesPopover) return;

    closeDropdowns();
    closeNotesPopover();
  });

  document.querySelectorAll('.tab').forEach(function(t) {
    t.addEventListener('click', function() { setActiveTab(t.dataset.tab); });
  });

  updateCounts();
  setActiveTab(getActiveTab());
})();
</script>
</body>
</html>`);
  } catch (err) {
    console.error('Admin error:', err);
    res.status(500).send('Server error');
  }
});

/* PATCH /admin/applications/:id/status – update lead status */
app.patch('/admin/applications/:id/status', basicAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE applications SET status = $1 WHERE id = $2 RETURNING id, status`,
      [status, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, id: rows[0].id, status: rows[0].status });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* PATCH /admin/applications/:id/notes – update lead notes */
app.patch('/admin/applications/:id/notes', basicAuth, async (req, res) => {
  const { notes } = req.body || {};
  if (typeof notes !== 'string' || notes.length > 2000) {
    return res.status(400).json({ error: 'Invalid notes' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE applications SET notes = $1 WHERE id = $2 RETURNING id, notes`,
      [notes, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, id: rows[0].id, notes: rows[0].notes });
  } catch (err) {
    console.error('Notes update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── HELPERS ── */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskSSN(ssn) {
  return ssn ? '***-**-' + ssn.slice(-4) : '–';
}

function maskEIN(ein) {
  return ein ? '**-***' + ein.slice(-4) : '–';
}

function creditClass(score) {
  if (!score) return 'mid';
  if (['650 – 699','700 – 749','750+'].includes(score)) return 'good';
  if (['600 – 649','550 – 599'].includes(score)) return 'mid';
  return 'low';
}

function basicAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) return challenge(res);
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) return next();
  return challenge(res);
}

function challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="RCN Admin"');
  res.status(401).send('Unauthorized');
}

/* ── HEALTH CHECK ── */
app.get('/', (req, res) => res.json({ status: 'ok', service: 'rcn-apply-backend' }));

/* -- START -- */
const PORT = process.env.PORT || 3000;
require('./plaid')(app, pool);

initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
