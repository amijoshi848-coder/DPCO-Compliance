export function generateStandaloneHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DPCO Compliance — NPPA Regulatory Tool (Standalone HTML Preview)</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #475569;
      --accent: #1e3a8a;
      --accent-hover: #1d4ed8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container { max-width: 1180px; margin: 0 auto; padding: 48px 24px; }
    .login-grid { display: grid; grid-template-columns: 1.25fr 0.9fr; gap: 40px; align-items: start; }
    @media (max-width: 900px) { .login-grid { grid-template-columns: 1fr; } }
    h1 { font-size: 2.25rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 12px; }
    .lead { color: var(--muted); font-size: 1rem; margin-bottom: 28px; max-width: 62ch; }
    .boxes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    @media (max-width: 720px) { .boxes { grid-template-columns: 1fr; } }
    .box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
    }
    .box h3 { font-size: 1rem; font-weight: 600; margin-bottom: 8px; color: var(--accent); }
    .box p { font-size: 0.875rem; color: var(--muted); }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
    }
    label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 6px; }
    input, textarea, select {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      font-size: 0.925rem;
      margin-bottom: 16px;
      font-family: inherit;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.9rem;
    }
    button:hover { background: var(--accent-hover); }
    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .tab-btn { background: transparent; color: var(--muted); border: 1px solid transparent; }
    .tab-btn.active { background: var(--accent); color: #fff; }
    .hidden { display: none; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.875rem; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    th { font-weight: 600; color: var(--muted); background: #f1f5f9; }
    .mono { font-family: ui-monospace, SFMono-Regular, monospace; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div id="login-view" class="container">
    <div class="login-grid">
      <div>
        <h1>DPCO Compliance</h1>
        <p class="lead">
          Centralized NPPA regulatory intelligence workspace for tracking daily 10:00 AM Ceiling Price notifications,
          post-16 July 2026 Retail Price circulars (Form 1A ready list with 1-year retention), Authority &amp; Expert Committee minutes,
          and NLEM 2022 Form I / Existing Manufacturer applicability verification.
        </p>
        <div class="boxes">
          <div class="box">
            <h3>Ceiling Price</h3>
            <p>Maintained by composition, strength &amp; dosage format with GST-inclusive Pack MRP conversion: Ceiling Price + (Ceiling Price × GST%).</p>
          </div>
          <div class="box">
            <h3>Retail Price</h3>
            <p>Circulars issued after 16th July 2026 logged with Notification No., Date, Formulation &amp; Price for Form 1A (1-year retention).</p>
          </div>
          <div class="box">
            <h3>Form I Updates</h3>
            <p>Screens proposed NLEM 2022 compositions and checks Existing Manufacturer status to determine mandatory Form I filing.</p>
          </div>
        </div>
      </div>
      <div class="card">
        <h2 style="font-size:1.25rem;margin-bottom:16px;">Authorized Sign In</h2>
        <form onsubmit="event.preventDefault(); document.getElementById('login-view').classList.add('hidden'); document.getElementById('app-view').classList.remove('hidden');">
          <label for="loginId">Login ID</label>
          <input id="loginId" type="text" placeholder="Enter Login ID" required />
          <label for="password">Password</label>
          <input id="password" type="password" placeholder="Enter Password" required />
          <button type="submit" style="width:100%;">Sign In to Workspace</button>
        </form>
      </div>
    </div>
  </div>

  <div id="app-view" class="container hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
      <h1 style="font-size:1.5rem;margin:0;">DPCO Compliance Workspace</h1>
      <button onclick="document.getElementById('app-view').classList.add('hidden'); document.getElementById('login-view').classList.remove('hidden');" style="background:#334155;">Sign Out</button>
    </div>
    <div class="tabs">
      <button class="tab-btn active" onclick="showTab('schedule', this)">Schedule Formulations</button>
      <button class="tab-btn" onclick="showTab('retail', this)">Retail Prices</button>
      <button class="tab-btn" onclick="showTab('company', this)">Company details</button>
      <button class="tab-btn" onclick="showTab('newprod', this)">New Product (Form I Check)</button>
    </div>

    <div id="tab-schedule" class="card">
      <h2>Schedule Formulations — Ceiling Price to MRP</h2>
      <p style="color:var(--muted);font-size:0.875rem;margin:6px 0 12px;">Formula: MRP per unit = Ceiling Price + (Ceiling Price × GST%)</p>
      <table>
        <thead>
          <tr><th>Medicine</th><th>Strength &amp; Format</th><th>Notification</th><th class="mono">Ceiling Price (₹)</th><th class="mono">MRP @ 12% GST (₹)</th></tr>
        </thead>
        <tbody>
          <tr><td>Atorvastatin</td><td>10mg Tablet</td><td class="mono">S.O. 1642(E) · 2026-04-01</td><td class="mono">5.56</td><td class="mono">6.23</td></tr>
          <tr><td>Atorvastatin</td><td>40mg Tablet</td><td class="mono">S.O. 1642(E) · 2026-04-01</td><td class="mono">18.88</td><td class="mono">21.15</td></tr>
        </tbody>
      </table>
    </div>

    <div id="tab-retail" class="card hidden">
      <h2>Retail Prices (Post 16 July 2026 · Form 1A Ready Reference)</h2>
      <table>
        <thead>
          <tr><th>Notification No.</th><th>Date</th><th>Formulation</th><th class="mono">Retail Price (₹)</th><th>Retention</th></tr>
        </thead>
        <tbody>
          <tr><td class="mono">S.O. 4895(E)</td><td class="mono">2026-11-12</td><td>Glimepiride 2mg + Metformin HCl 500mg (SR) Tablet</td><td class="mono">7.92</td><td>1 Year from Date</td></tr>
        </tbody>
      </table>
    </div>

    <div id="tab-company" class="card hidden">
      <h2>Company Details &amp; Existing Manufactured Portfolio</h2>
      <p style="color:var(--muted);margin-top:8px;">Existing formulations registered: Atorvastatin Tablet 10mg, Metformin Tablet 500mg.</p>
    </div>

    <div id="tab-newprod" class="card hidden">
      <h2>New Product — Form I &amp; Existing Manufacturer Applicability</h2>
      <label for="compInput" style="margin-top:12px;">Enter Proposed Formulation Composition</label>
      <input id="compInput" type="text" value="each tablet contains Atorvastatin 10mg, ranitidine 20mg" />
      <button onclick="runCheck()">Check Form I Applicability</button>
      <div id="checkResult" style="margin-top:16px;padding:16px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;"></div>
    </div>
  </div>

  <script>
    function showTab(id, btn) {
      ['schedule','retail','company','newprod'].forEach(t => document.getElementById('tab-' + t).classList.add('hidden'));
      document.getElementById('tab-' + id).classList.remove('hidden');
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    function runCheck() {
      const val = document.getElementById('compInput').value.toLowerCase();
      const box = document.getElementById('checkResult');
      if (val.includes('atorvastatin')) {
        box.innerHTML = '<strong>Result:</strong> Since the formulation contains <strong>Atorvastatin</strong>, which is an NLEM 2022 formulation, check applicability of Existing Manufacturer.<br/><br/><em>If you have any of the below products, you are an Existing Manufacturer — hence Form I needs to be applied:</em><table><thead><tr><th>Medicines</th><th>Dosage form and strength</th></tr></thead><tbody><tr><td>Atorvastatin</td><td>Tablet 40mg</td></tr><tr><td>Atorvastatin</td><td>Tablet 20mg</td></tr><tr><td>Atorvastatin</td><td>Tablet 80mg</td></tr><tr><td>Atorvastatin</td><td>Tablet 10mg</td></tr></tbody></table>';
      } else {
        box.innerHTML = 'No NLEM 2022 match found in standalone preview.';
      }
    }
    runCheck();
  </script>
</body>
</html>`;
}
