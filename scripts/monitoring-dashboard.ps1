# Generates a self-contained, interactive HTML dashboard from the deployed
# app's translation telemetry (the structured JSON lines emitted by
# src/lib/telemetry.ts and captured in the Container Apps environment's Log
# Analytics workspace, table ContainerAppConsoleLogs_CL).
#
# The output HTML embeds a snapshot of the events, so it opens offline and can
# be shared. Re-run the script to refresh. See the skill README for usage.

param(
  [int]$Hours = 24,
  [string]$SubscriptionId = "",
  [string]$ResourceGroup = "",
  # Log Analytics workspace GUID (customerId). Resolved from the RG when empty.
  [string]$WorkspaceId = "",
  [string]$Endpoint = "",
  [string]$OutFile = "",
  [switch]$Open
)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
# Windows PowerShell 5.1 reads child-process (az) stdout using the console code
# page (often cp1252), which corrupts az's UTF-8 JSON and silently drops rows.
# Re-launch under pwsh 7 when possible so the payload survives intact.
if ($PSVersionTable.PSVersion.Major -lt 6) {
  $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
  if ($pwshPath) {
    & $pwshPath -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath @PSBoundParameters
    exit $LASTEXITCODE
  }
  Write-Warning "PowerShell 7+ (pwsh) is recommended; 5.1 may drop log rows due to console encoding."
}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($OutFile)) {
  $OutFile = Join-Path (Split-Path $PSScriptRoot -Parent) "monitoring-dashboard.html"
}

Write-Host "=== Translation monitoring dashboard ==="

# Resolve deployment coordinates from the azd environment / current az context so
# no environment-specific identifiers are baked into this script.
if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
  $SubscriptionId = (az account show --query id -o tsv)
  if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
    throw "No subscription. Run 'az login', or pass -SubscriptionId."
  }
}
if ([string]::IsNullOrWhiteSpace($ResourceGroup)) {
  $ResourceGroup = (azd env get-value AZURE_RESOURCE_GROUP 2>$null)
  if ([string]::IsNullOrWhiteSpace($ResourceGroup)) {
    throw "No resource group. Run this from an azd environment, or pass -ResourceGroup."
  }
}
if ([string]::IsNullOrWhiteSpace($Endpoint)) {
  $Endpoint = (azd env get-value WEB_BASE_URL 2>$null)
}

az account set --subscription $SubscriptionId 2>$null

# Make sure the log-analytics CLI extension is available.
$null = az extension add --name log-analytics --only-show-errors 2>$null

if ([string]::IsNullOrWhiteSpace($WorkspaceId)) {
  Write-Host "Resolving Log Analytics workspace in $ResourceGroup ..."
  $WorkspaceId = (az monitor log-analytics workspace list -g $ResourceGroup --query "[0].customerId" -o tsv 2>$null)
}
if ([string]::IsNullOrWhiteSpace($WorkspaceId)) {
  throw "Could not resolve a Log Analytics workspace in resource group '$ResourceGroup'. Pass -WorkspaceId <customerId>."
}
Write-Host "Workspace: $WorkspaceId  |  Window: last $Hours h"

# KQL: pull every structured translation event in the window. Keep this on a
# SINGLE line — a multi-line query passed through `az --analytics-query` on
# Windows loses interior lines (e.g. the event filter), returning unrelated rows.
$query = "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(${Hours}h) | where Log_s has 'translation' | extend d = parse_json(Log_s) | where tostring(d.event) == 'translation' | project TimeGenerated, status=tostring(d.status), mode=tostring(d.mode), fileType=tostring(d.fileType), sizeBytes=tolong(d.sizeBytes), chunks=toint(d.chunks), characters=tolong(d.characters), charactersCharged=tolong(d.charactersCharged), costUSD=todouble(d.costUSD), processingMs=tolong(d.processingMs), httpStatus=toint(d.httpStatus), errorType=tostring(d.errorType), async=tostring(d.async) | order by TimeGenerated desc"

Write-Host "Querying telemetry ..."
$raw = az monitor log-analytics query -w $WorkspaceId --analytics-query $query -o json 2>$null
$rows = @()
if ($raw) { $rows = @($raw | ConvertFrom-Json) }
Write-Host ("Events returned: {0}" -f $rows.Count)

# The log-analytics extension renders nulls as the literal string "None" and all
# values as strings; normalise to real numbers / nulls for a clean payload.
function ConvNum($v) {
  if ($null -eq $v -or $v -eq 'None' -or $v -eq '') { return $null }
  try { return [long]$v } catch { return $null }
}
function ConvDbl($v) {
  if ($null -eq $v -or $v -eq 'None' -or $v -eq '') { return $null }
  try { return [double]$v } catch { return $null }
}
function ConvStr($v) {
  if ($null -eq $v -or $v -eq 'None' -or $v -eq '') { return $null }
  return [string]$v
}
# TimeGenerated comes back UTC, but ConvertFrom-Json turns it into a datetime
# whose plain string loses the timezone marker — the browser would then read it
# as local time. Force a Z-suffixed UTC ISO-8601 string so the client can render
# it correctly in any timezone.
function ConvTime($v) {
  if ($null -eq $v -or $v -eq 'None' -or $v -eq '') { return $null }
  try { return ([datetimeoffset]$v).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  catch { return [string]$v }
}

$clean = foreach ($r in $rows) {
  [pscustomobject]@{
    t                 = ConvTime $r.TimeGenerated
    status            = ConvStr $r.status
    mode              = ConvStr $r.mode
    fileType          = ConvStr $r.fileType
    sizeBytes         = ConvNum $r.sizeBytes
    chunks            = ConvNum $r.chunks
    characters        = ConvNum $r.characters
    charactersCharged = ConvNum $r.charactersCharged
    costUSD           = ConvDbl $r.costUSD
    processingMs      = ConvNum $r.processingMs
    httpStatus        = ConvNum $r.httpStatus
    errorType         = ConvStr $r.errorType
    async             = if ($r.async -eq 'true') { $true } elseif ($r.async -eq 'false') { $false } else { $null }
  }
}

$dataJson = ($clean | ConvertTo-Json -Depth 5 -Compress)
if ([string]::IsNullOrWhiteSpace($dataJson)) { $dataJson = "[]" }
# ConvertTo-Json collapses a single object; force a JSON array.
if ($clean.Count -le 1 -and $dataJson.TrimStart().StartsWith("{")) { $dataJson = "[$dataJson]" }
# Keep the payload from prematurely closing the <script> tag.
$dataJson = $dataJson.Replace("</", "<\/")

$nowUtc = (Get-Date).ToUniversalTime()
$meta = [pscustomobject]@{
  generatedAt = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
  hours       = $Hours
  # Explicit UTC bounds of the rolling window actually queried (ago(${Hours}h)
  # is relative to query time), so the dashboard can show exactly what it covers.
  fromUtc     = $nowUtc.AddHours(-$Hours).ToString("yyyy-MM-ddTHH:mm:ssZ")
  toUtc       = $nowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ")
  endpoint    = $Endpoint
  workspace   = $WorkspaceId
  rg          = $ResourceGroup
}
$metaJson = ($meta | ConvertTo-Json -Depth 3 -Compress).Replace("</", "<\/")

$template = @'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Document Translator — Monitoring</title>
<style>
  :root {
    --bg: #0b1220; --panel: #131c2e; --panel2: #0f1728; --border: #23324d;
    --text: #e6edf7; --muted: #8aa0c0; --blue: #4c8dff; --green: #37d399;
    --amber: #f5c451; --red: #ff6b6b; --violet: #a583ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  a { color: var(--blue); }
  header { position: sticky; top: 0; z-index: 5; padding: 18px 24px;
    background: linear-gradient(180deg, #0d1626, #0b1220);
    border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: 18px; font-weight: 650; }
  .sub { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .wrap { padding: 20px 24px 48px; max-width: 1180px; margin: 0 auto; }
  .kpis { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 18px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .kpi .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .kpi .value { font-size: 24px; font-weight: 680; margin-top: 4px; }
  .kpi .value small { font-size: 13px; color: var(--muted); font-weight: 500; }
  .grid2 { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-bottom: 18px; }
  @media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .panel h2 { margin: 0 0 12px; font-size: 13.5px; color: var(--muted); font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em; }
  .bar-row { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; gap: 10px; margin: 8px 0; }
  .bar-row .name { color: var(--text); font-weight: 600; text-transform: capitalize; }
  .track { background: var(--panel2); border-radius: 8px; height: 22px; overflow: hidden; border: 1px solid var(--border); }
  .fill { height: 100%; border-radius: 8px 0 0 8px; }
  .bar-row .amt { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 84px; text-align: right; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
  .controls .seg { display: inline-flex; background: var(--panel2); border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
  .controls .seg button { background: transparent; color: var(--muted); border: 0; padding: 7px 12px; cursor: pointer; font-size: 13px; }
  .controls .seg button.active { background: var(--blue); color: #06101f; font-weight: 650; }
  .controls input { background: var(--panel2); border: 1px solid var(--border); color: var(--text);
    border-radius: 9px; padding: 7px 11px; font-size: 13px; min-width: 180px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 9px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--panel); }
  th .arw { opacity: .5; font-size: 10px; }
  tbody tr:hover { background: #16223a; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .b-completed { background: rgba(55,211,153,.16); color: var(--green); }
  .b-failed { background: rgba(255,107,107,.16); color: var(--red); }
  .b-started { background: rgba(245,196,81,.16); color: var(--amber); }
  .tablewrap { max-height: 460px; overflow: auto; border: 1px solid var(--border); border-radius: 12px; }
  .empty { color: var(--muted); padding: 22px; text-align: center; }
  .fails { border-color: rgba(255,107,107,.4); }
  .fails h2 { color: var(--red); }
  .foot { color: var(--muted); font-size: 12px; margin-top: 18px; }
  code { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; }
</style>
</head>
<body>
<header>
  <h1>Document Translator — Translation Monitoring</h1>
  <div class="sub" id="meta"></div>
</header>
<div class="wrap">
  <div class="kpis" id="kpis"></div>

  <div class="controls">
    <div class="seg" id="segMode">
      <button data-v="all" class="active">All modes</button>
      <button data-v="text">Text</button>
      <button data-v="layout">Layout</button>
    </div>
    <div class="seg" id="segStatus">
      <button data-v="all" class="active">All</button>
      <button data-v="completed">Completed</button>
      <button data-v="failed">Failed</button>
      <button data-v="started">Started</button>
    </div>
    <input id="q" type="search" placeholder="Filter file type / error…" />
  </div>

  <div class="grid2">
    <div class="panel"><h2>By mode</h2><div id="byMode"></div></div>
    <div class="panel"><h2>By status</h2><div id="byStatus"></div></div>
  </div>

  <div class="panel fails" id="failPanel" style="display:none; margin-bottom:18px">
    <h2>Failures</h2><div id="failList"></div>
  </div>

  <div class="panel">
    <h2>Events (<span id="evCount">0</span>)</h2>
    <div class="tablewrap">
      <table>
        <thead><tr id="head"></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

  <div class="foot" id="foot"></div>
</div>

<script>
const DATA = @@DATA@@;
const META = @@META@@;

const S = { mode: 'all', status: 'all', q: '', sortKey: 't', sortDir: 'desc' };
const COLS = [
  { k: 't', label: 'Time' }, { k: 'status', label: 'Status' }, { k: 'mode', label: 'Mode' },
  { k: 'fileType', label: 'Type' }, { k: 'sizeBytes', label: 'Size', num: true },
  { k: 'chunks', label: 'Chunks', num: true }, { k: 'characters', label: 'Characters', num: true },
  { k: 'costUSD', label: 'Cost', num: true }, { k: 'processingMs', label: 'Time', num: true },
  { k: 'httpStatus', label: 'HTTP', num: true }, { k: 'errorType', label: 'Error' },
];

const n0 = v => (v === null || v === undefined || v === 'None' || v === '') ? null : Number(v);
const fNum = v => v == null ? '—' : Number(v).toLocaleString('en-US');
const fUSD = v => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fDur = ms => ms == null ? '—' : (ms < 1000 ? ms + ' ms' : (ms < 60000 ? (ms/1000).toFixed(1) + ' s' : Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's'));
const fBytes = b => b == null ? '—' : (b < 1048576 ? (b/1024).toFixed(0) + ' KB' : (b/1048576).toFixed(2) + ' MB');
const fTime = t => { if (!t) return '—'; const d = new Date(t); return d.toLocaleString('en-US', { timeZone: 'Asia/Singapore', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };

function filtered() {
  const q = S.q.trim().toLowerCase();
  return DATA.filter(r => {
    if (S.mode !== 'all' && r.mode !== S.mode) return false;
    if (S.status !== 'all' && r.status !== S.status) return false;
    if (q) {
      const hay = ((r.fileType || '') + ' ' + (r.errorType || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function kpis(rows) {
  const done = rows.filter(r => r.status === 'completed');
  const fail = rows.filter(r => r.status === 'failed');
  const started = rows.filter(r => r.status === 'started');
  const chars = done.reduce((s, r) => s + (n0(r.characters) || 0), 0);
  const cost = done.reduce((s, r) => s + (n0(r.costUSD) || 0), 0);
  const times = done.map(r => n0(r.processingMs)).filter(v => v != null);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const max = times.length ? Math.max(...times) : null;
  const denom = done.length + fail.length;
  const rate = denom ? (done.length / denom * 100) : null;
  return [
    { label: 'Completed', value: fNum(done.length), color: 'var(--green)' },
    { label: 'Failed', value: fNum(fail.length), color: fail.length ? 'var(--red)' : 'var(--text)' },
    { label: 'Success rate', value: rate == null ? '—' : rate.toFixed(1) + '%' },
    { label: 'Async submitted', value: fNum(started.length) },
    { label: 'Characters', value: fNum(chars) },
    { label: 'Cost', value: fUSD(cost) },
    { label: 'Avg time', value: fDur(avg) },
    { label: 'Max time', value: fDur(max) },
  ];
}

function renderKpis(rows) {
  document.getElementById('kpis').innerHTML = kpis(rows).map(k =>
    `<div class="kpi"><div class="label">${k.label}</div><div class="value" style="color:${k.color||'var(--text)'}">${k.value}</div></div>`
  ).join('');
}

function bars(container, items, color) {
  const max = Math.max(1, ...items.map(i => i.value));
  container.innerHTML = items.length ? items.map(i =>
    `<div class="bar-row"><span class="name">${i.name}</span>
      <div class="track"><div class="fill" style="width:${(i.value/max*100).toFixed(1)}%;background:${i.color||color}"></div></div>
      <span class="amt">${i.amt}</span></div>`
  ).join('') : '<div class="empty">No data</div>';
}

function renderCharts(rows) {
  const modes = ['text', 'layout'];
  const modeItems = modes.map(m => {
    const rs = rows.filter(r => r.mode === m && r.status === 'completed');
    const cost = rs.reduce((s, r) => s + (n0(r.costUSD) || 0), 0);
    return { name: m, value: rs.length, amt: rs.length + ' · ' + fUSD(cost) };
  }).filter(i => i.value > 0 || rows.some(r => r.mode === i.name));
  bars(document.getElementById('byMode'), modeItems, 'var(--blue)');

  const stMap = { completed: 'var(--green)', failed: 'var(--red)', started: 'var(--amber)' };
  const stItems = ['completed', 'failed', 'started'].map(s => {
    const c = rows.filter(r => r.status === s).length;
    return { name: s, value: c, amt: String(c), color: stMap[s] };
  }).filter(i => i.value > 0);
  bars(document.getElementById('byStatus'), stItems);
}

function renderFails(rows) {
  const fails = rows.filter(r => r.status === 'failed');
  const panel = document.getElementById('failPanel');
  if (!fails.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('failList').innerHTML = fails.map(r =>
    `<div class="bar-row" style="grid-template-columns:150px 110px 1fr auto">
      <span>${fTime(r.t)}</span><span class="badge b-failed">${r.mode||'—'}</span>
      <span>${r.errorType || 'error'}</span><span class="amt">HTTP ${r.httpStatus ?? '—'}</span></div>`
  ).join('');
}

function renderTable(rows) {
  const head = document.getElementById('head');
  head.innerHTML = COLS.map(c => {
    const arw = S.sortKey === c.k ? `<span class="arw">${S.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th data-k="${c.k}"${c.num ? ' style="text-align:right"' : ''}>${c.label} ${arw}</th>`;
  }).join('');
  head.querySelectorAll('th').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (S.sortKey === k) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
    else { S.sortKey = k; S.sortDir = 'desc'; }
    render();
  });

  const sorted = rows.slice().sort((a, b) => {
    let x = a[S.sortKey], y = b[S.sortKey];
    if (S.sortKey === 't') { x = x || ''; y = y || ''; return S.sortDir === 'asc' ? x.localeCompare(y) : y.localeCompare(x); }
    const nx = n0(x), ny = n0(y);
    if (nx != null || ny != null) { return S.sortDir === 'asc' ? (nx||0) - (ny||0) : (ny||0) - (nx||0); }
    x = (x||'').toString(); y = (y||'').toString();
    return S.sortDir === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
  });

  document.getElementById('evCount').textContent = sorted.length;
  const body = document.getElementById('rows');
  if (!sorted.length) { body.innerHTML = '<tr><td colspan="11" class="empty">No matching events</td></tr>'; return; }
  body.innerHTML = sorted.map(r => `<tr>
    <td>${fTime(r.t)}</td>
    <td><span class="badge b-${r.status}">${r.status}</span></td>
    <td style="text-transform:capitalize">${r.mode || '—'}</td>
    <td>${r.fileType || '—'}</td>
    <td class="num">${fBytes(n0(r.sizeBytes))}</td>
    <td class="num">${r.chunks ?? '—'}</td>
    <td class="num">${fNum(n0(r.characters))}</td>
    <td class="num">${fUSD(n0(r.costUSD))}</td>
    <td class="num">${fDur(n0(r.processingMs))}</td>
    <td class="num">${r.httpStatus ?? '—'}</td>
    <td>${r.errorType || '—'}</td>
  </tr>`).join('');
}

function render() {
  const rows = filtered();
  renderKpis(rows);
  renderCharts(rows);
  renderFails(rows);
  renderTable(rows);
}

function wireSeg(id, key) {
  const seg = document.getElementById(id);
  seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S[key] = b.dataset.v;
    render();
  });
}

const fAge = t => {
  if (!t) return '—';
  const secs = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (secs < 90) return Math.round(secs) + 's ago';
  if (secs < 5400) return Math.round(secs / 60) + 'm ago';
  if (secs < 172800) return (secs / 3600).toFixed(1) + 'h ago';
  return Math.round(secs / 86400) + 'd ago';
};

const newest = DATA.reduce((m, r) => (r.t && (!m || r.t > m) ? r.t : m), null);
const winFrom = META.fromUtc ? fTime(META.fromUtc) : ('last ' + META.hours + ' h');
const winTo = META.toUtc ? fTime(META.toUtc) : 'now';
document.getElementById('meta').innerHTML =
  `Snapshot generated ${fTime(META.generatedAt)} SGT (UTC+8) · window: last ${META.hours} h ` +
  `(${winFrom} → ${winTo} SGT) · ${DATA.length} events · ` +
  `newest event ${newest ? fAge(newest) : 'n/a'} · ` +
  `<a href="${META.endpoint}" target="_blank" rel="noopener">app</a>`;
document.getElementById('foot').innerHTML =
  `Data is a point-in-time snapshot from Log Analytics workspace <code>${META.workspace}</code> ` +
  `(resource group <code>${META.rg}</code>). Re-run <code>scripts/monitoring-dashboard.ps1 -Open</code> to refresh.`;

wireSeg('segMode', 'mode');
wireSeg('segStatus', 'status');
document.getElementById('q').oninput = e => { S.q = e.target.value; render(); };
render();
</script>
</body>
</html>
'@

$html = $template.Replace("@@DATA@@", $dataJson).Replace("@@META@@", $metaJson)
Set-Content -Path $OutFile -Value $html -Encoding UTF8
Write-Host "=== Wrote $OutFile ==="

if ($Open) { Start-Process $OutFile }
