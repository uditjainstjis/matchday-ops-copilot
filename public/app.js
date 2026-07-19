// @ts-check
/**
 * Matchday Ops Copilot - operations board client.
 *
 * SECURITY: this file never uses innerHTML, outerHTML, insertAdjacentHTML,
 * eval or new Function. Every value that originates from the API - and
 * therefore ultimately from a language model - is inserted with
 * `document.createTextNode` / `textContent`, so it is impossible for model
 * output or a crafted incident report to execute as markup. The Worker's
 * Content-Security-Policy (`script-src 'self'`, no unsafe-inline) is the second
 * layer of that defence.
 *
 * ACCESSIBILITY: results are announced through a polite live region, focus is
 * moved deliberately, and no state is communicated by colour alone.
 */

/** @typedef {{id:string,city:string,country:string,stadium:string,capacity:number}} Venue */

const SAMPLES = Object.freeze([
  'crowd surge at gate 4, people pressed against the barrier, need help now',
  'medical at block C row 12, adult male collapsed, unresponsive, bring defib',
  'smoke coming from the kiosk on concourse level 2, small but spreading',
  'lost child near gate 7, about six years old, red shirt, separated from father',
  'turnstile scanner down on lane 3, queue building outside',
  'aglomeracion en la puerta 2, la gente empuja, se necesita personal',
]);

/** Human labels for machine category ids. */
const CATEGORY_LABELS = Object.freeze({
  crowd_safety: 'Crowd safety',
  medical: 'Medical',
  security: 'Security',
  fire_hazard: 'Fire hazard',
  infrastructure: 'Infrastructure',
  pitch_and_playing_surface: 'Pitch and playing surface',
  ticketing_and_access: 'Ticketing and access',
  transport_and_egress: 'Transport and egress',
  weather: 'Weather',
  anti_social_behaviour: 'Anti-social behaviour',
  lost_or_vulnerable_person: 'Lost or vulnerable person',
  other: 'Other',
});

const PRIORITY_RANK = Object.freeze({ P1: 0, P2: 1, P3: 2, P4: 3 });

/** @type {Array<Record<string, any>>} */
const board = [];

const el = {
  form: /** @type {HTMLFormElement} */ (document.getElementById('report-form')),
  venue: /** @type {HTMLSelectElement} */ (document.getElementById('venue')),
  phase: /** @type {HTMLSelectElement} */ (document.getElementById('match-phase')),
  report: /** @type {HTMLTextAreaElement} */ (document.getElementById('report')),
  charCount: /** @type {HTMLElement} */ (document.getElementById('char-count')),
  error: /** @type {HTMLElement} */ (document.getElementById('report-error')),
  submit: /** @type {HTMLButtonElement} */ (document.getElementById('submit-btn')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  result: /** @type {HTMLElement} */ (document.getElementById('result')),
  boardBody: /** @type {HTMLElement} */ (document.getElementById('board-body')),
  sampleList: /** @type {HTMLElement} */ (document.getElementById('sample-list')),
};

/**
 * Create an element with text content and optional class.
 * Text is always set via textContent, never parsed as HTML.
 *
 * @param {string} tag
 * @param {string} [text]
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (typeof text === 'string') element.textContent = text;
  if (typeof className === 'string') element.className = className;
  return element;
}

/**
 * Turn a category id into a human label, falling back to the raw id.
 * @param {string} id
 * @returns {string}
 */
function categoryLabel(id) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, id)
    ? CATEGORY_LABELS[/** @type {keyof typeof CATEGORY_LABELS} */ (id)]
    : id;
}

/**
 * Load the venue list and populate the select.
 * Falls back to a single hard-coded venue so the form is never unusable.
 * @returns {Promise<void>}
 */
async function loadVenues() {
  try {
    const response = await fetch('/api/venues', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    el.venue.replaceChildren();
    for (const venue of /** @type {Venue[]} */ (data.venues)) {
      const option = document.createElement('option');
      option.value = venue.id;
      option.textContent = `${venue.city} — ${venue.stadium}`;
      el.venue.append(option);
    }
    el.venue.value = 'nyn';
  } catch {
    el.venue.replaceChildren();
    const option = document.createElement('option');
    option.value = 'nyn';
    option.textContent = 'New York / New Jersey — MetLife Stadium';
    el.venue.append(option);
    el.status.textContent = 'Venue list could not be loaded; using a default venue.';
  }
}

/** Render the clickable sample reports. */
function renderSamples() {
  for (const sample of SAMPLES) {
    const item = document.createElement('li');
    const button = node('button', sample, 'sample-btn');
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => {
      el.report.value = sample;
      updateCharCount();
      el.report.focus();
    });
    item.append(button);
    el.sampleList.append(item);
  }
}

/** Keep the character counter in sync with the textarea. */
function updateCharCount() {
  el.charCount.textContent = String(el.report.value.length);
}

/**
 * Build one labelled cell of the metadata grid.
 * @param {string} term
 * @param {string} value
 * @returns {HTMLElement}
 */
function metaItem(term, value) {
  const wrapper = document.createElement('div');
  wrapper.append(node('dt', term), node('dd', value));
  return wrapper;
}

/**
 * Render a triaged incident into the result panel.
 * @param {Record<string, any>} incident
 */
function renderResult(incident) {
  el.result.replaceChildren();

  const head = document.createElement('div');
  head.className = 'result-head';

  const badge = node('span', `${incident.priority} — ${priorityWord(incident.priority)}`, `badge badge-${String(incident.priority).toLowerCase()}`);
  head.append(badge, node('span', incident.id, 'incident-id'));
  el.result.append(head);

  if (incident.engine === 'deterministic-fallback') {
    const notice = node('p', '', 'degraded');
    notice.append(node('strong', 'Degraded — offline classifier. '));
    notice.append(document.createTextNode(`${incident.degradedReason ?? ''} Treat the classification as indicative and confirm manually.`));
    el.result.append(notice);
  }

  el.result.append(node('p', incident.summary, 'summary'));

  const grid = document.createElement('dl');
  grid.className = 'meta-grid';
  grid.append(
    metaItem('Category', categoryLabel(incident.category)),
    metaItem('Severity', `${incident.severity} of 5`),
    metaItem('Target response', `${incident.slaMinutes} min`),
    metaItem('Location', incident.location.zone),
    metaItem('Primary unit', incident.primaryUnit),
    metaItem('Also notify', incident.supportingUnits.length > 0 ? incident.supportingUnits.join(', ') : 'None'),
  );
  el.result.append(grid);

  if (incident.escalateToVenueCommand) {
    el.result.append(node('p', 'Escalate to venue command immediately.', 'escalation'));
  }

  el.result.append(node('h3', 'Recommended actions', 'actions-heading'));
  const list = document.createElement('ol');
  list.className = 'actions';
  for (const action of incident.recommendedActions) {
    list.append(node('li', action));
  }
  el.result.append(list);

  const engineText =
    incident.engine === 'workers-ai'
      ? `Classified by Workers AI in ${incident.latencyMs} ms · confidence ${Math.round(incident.confidence * 100)}% · priority, SLA and routing computed deterministically.`
      : `Classified by the offline keyword engine in ${incident.latencyMs} ms · confidence ${Math.round(incident.confidence * 100)}%.`;
  el.result.append(node('p', engineText, 'engine-note'));

  el.result.hidden = false;
}

/**
 * Plain-language word for a priority band, so the band is never colour-only.
 * @param {string} priority
 * @returns {string}
 */
function priorityWord(priority) {
  if (priority === 'P1') return 'immediate';
  if (priority === 'P2') return 'urgent';
  if (priority === 'P3') return 'routine';
  return 'monitor';
}

/**
 * Add an incident to the session board and re-render it, highest priority first.
 * @param {Record<string, any>} incident
 */
function addToBoard(incident) {
  board.push(incident);
  board.sort(
    (a, b) =>
      PRIORITY_RANK[/** @type {keyof typeof PRIORITY_RANK} */ (a.priority)] -
        PRIORITY_RANK[/** @type {keyof typeof PRIORITY_RANK} */ (b.priority)] ||
      String(a.receivedAt).localeCompare(String(b.receivedAt)),
  );

  el.boardBody.replaceChildren();
  for (const item of board) {
    const row = document.createElement('tr');
    const priorityCell = document.createElement('td');
    priorityCell.append(
      node('span', `${item.priority} — ${priorityWord(item.priority)}`, `badge badge-${String(item.priority).toLowerCase()}`),
    );
    row.append(priorityCell);
    row.append(node('td', item.id));
    row.append(node('td', categoryLabel(item.category)));
    row.append(node('td', item.location.zone));
    row.append(node('td', item.primaryUnit));
    row.append(node('td', `${item.slaMinutes} min`));
    row.append(node('td', item.engine === 'workers-ai' ? 'Workers AI' : 'Offline'));
    el.boardBody.append(row);
  }
}

/**
 * Submit handler: validate client-side, call the API, render.
 * @param {SubmitEvent} event
 */
async function onSubmit(event) {
  event.preventDefault();
  el.error.textContent = '';

  const report = el.report.value.trim();
  if (report.length < 4) {
    el.error.textContent = 'Enter at least 4 characters describing the incident.';
    el.report.setAttribute('aria-invalid', 'true');
    el.report.focus();
    return;
  }
  el.report.removeAttribute('aria-invalid');

  // aria-disabled rather than disabled: a disabled control loses focus and is
  // skipped by screen readers, which strands the user mid-task.
  el.submit.setAttribute('aria-disabled', 'true');
  el.status.textContent = 'Triaging report…';

  try {
    const response = await fetch('/api/triage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ report, venueId: el.venue.value, matchPhase: el.phase.value }),
    });

    const payload = await response.json();

    if (!response.ok) {
      const message = payload?.error?.message ?? `Request failed with status ${response.status}.`;
      el.status.textContent = `Triage failed. ${message}`;
      el.error.textContent = message;
      return;
    }

    const incident = payload.incident;
    renderResult(incident);
    addToBoard(incident);
    el.status.textContent = `Incident ${incident.id} triaged as ${incident.priority}, ${categoryLabel(incident.category)}, severity ${incident.severity} of 5, routed to ${incident.primaryUnit}, target response ${incident.slaMinutes} minutes.`;
  } catch {
    el.status.textContent =
      'Could not reach the triage service. Check the connection and retry; nothing was lost.';
  } finally {
    el.submit.removeAttribute('aria-disabled');
  }
}

el.report.addEventListener('input', updateCharCount);
el.form.addEventListener('submit', onSubmit);
renderSamples();
updateCharCount();
void loadVenues();
