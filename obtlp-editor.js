/*
  OBTLP content editor (panel feedback, Oct 2026): "OBTLP should be dynamic
  and can be edited if revisions are necessary" / "changing, editing of
  fields should be under Faculty".

  The official course template still fills everything in, but the faculty
  member can now edit every part of it in the wizard:
    CILO · Student Outcomes map · Teaching and Learning Plan · References ·
    Grading System · Course Requirements and policy notes.

  Usage (portfolio-new.html):
    OBTLPEditor.render(rootEl, model, {
      editable: true,
      programOutcomes: [{ code, description }],   // placeholder wording
      onChange: (model) => { ... }                 // after every edit
    });
  `model` = { outcomes, soMap, teachingPlan, referenceGroups, grading,
  courseRequirements, classPoliciesOverride }. The editor works on its own
  copy and hands the whole model to onChange.
*/
(function () {
  const INTENSITY = ['I/L', 'E/P', 'D/O'];
  const TABS = [
    { key: 'cilo', label: 'CILO' },
    { key: 'so', label: 'Student Outcomes Map' },
    { key: 'plan', label: 'Teaching & Learning Plan' },
    { key: 'refs', label: 'References' },
    { key: 'grading', label: 'Grading System' },
    { key: 'req', label: 'Requirements & Policies' }
  ];

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const lines = (v) => String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const joinLines = (arr) => (Array.isArray(arr) ? arr : []).join('\n');
  const clone = (v) => JSON.parse(JSON.stringify(v == null ? null : v));

  function normalize(m) {
    m = clone(m || {}) || {};
    m.outcomes = Array.isArray(m.outcomes) ? m.outcomes.filter((s) => String(s || '').trim()) : [];
    m.soMap = Array.isArray(m.soMap) ? m.soMap : [];
    m.teachingPlan = Array.isArray(m.teachingPlan) ? m.teachingPlan : [];
    m.referenceGroups = Object.assign({ textbooks: [], onlineResources: [], journals: [], suggested: [] }, m.referenceGroups || {});
    m.grading = { components: Array.isArray(m.grading && m.grading.components) ? m.grading.components : [] };
    m.courseRequirements = Array.isArray(m.courseRequirements) ? m.courseRequirements : [];
    m.classPoliciesOverride = m.classPoliciesOverride || '';
    return m;
  }

  function render(root, model, opts) {
    opts = opts || {};
    const m = normalize(model);
    const editable = opts.editable !== false;
    const dis = editable ? '' : 'disabled';
    let active = root.dataset.oeTab || 'cilo';
    const changed = () => { if (opts.onChange) opts.onChange(clone(m)); };
    const programSo = (code) => (opts.programOutcomes || []).find((s) => s.code === code);

    function tabCount(key) {
      if (key === 'cilo') return m.outcomes.length;
      if (key === 'so') return m.soMap.length;
      if (key === 'plan') return m.teachingPlan.filter((r) => r.type !== 'milestone').length;
      if (key === 'refs') return ['textbooks', 'onlineResources', 'journals', 'suggested'].reduce((a, k) => a + (m.referenceGroups[k] || []).length, 0);
      if (key === 'grading') return m.grading.components.length;
      return m.courseRequirements.length;
    }

    function panelHtml(key) {
      if (key === 'cilo') {
        return `<p class="oe-help">One learning outcome per line. They are numbered automatically (CO1, CO2 …).</p>
          <textarea class="textarea" rows="7" data-oe-field="outcomes" ${dis} placeholder="e.g. Explain the basic parts of a computer system">${esc(joinLines(m.outcomes))}</textarea>`;
      }
      if (key === 'so') {
        return `<p class="oe-help">Tick how strongly the course addresses each outcome: I/L – Introductory/Learning · E/P – Enabling/Practice · D/O – Demonstrating/Opportunity.</p>
          <div class="oe-so">
            <div class="oe-so-row oe-so-head"><span>Code</span><span>Outcome</span>${INTENSITY.map((c) => `<span class="oe-c">${c}</span>`).join('')}<span></span></div>
            ${m.soMap.map((row, i) => {
              const so = programSo(row.soCode);
              return `<div class="oe-so-row">
                <input class="input input-sm" data-so="${i}" data-k="soCode" value="${esc(row.soCode)}" ${dis} placeholder="SO1" />
                <textarea class="textarea" rows="2" data-so="${i}" data-k="description" ${dis} placeholder="${esc(so ? so.description : 'Outcome wording')}">${esc(row.description || '')}</textarea>
                ${INTENSITY.map((c) => `<label class="oe-c"><input type="checkbox" data-so="${i}" data-int="${c}" ${String(row.intensity || '').toUpperCase().includes(c) ? 'checked' : ''} ${dis} /></label>`).join('')}
                ${editable ? `<button type="button" class="icon-btn" data-so-del="${i}" title="Remove"><i data-lucide="x" class="svg-icon"></i></button>` : '<span></span>'}
              </div>`;
            }).join('') || '<p class="t-muted" style="padding:0.5rem 0;">No outcomes mapped yet.</p>'}
          </div>
          ${editable ? '<button type="button" class="btn btn-outline btn-sm" data-so-add><i data-lucide="plus" class="svg-icon"></i> Add Outcome</button>' : ''}`;
      }
      if (key === 'plan') {
        const fields = [['topics', 'Topics'], ['ilo', 'Intended Learning Outcomes (ILO)'], ['tla', 'Teaching and Learning Activities (TLA)'], ['instructionalMaterials', 'Instructional Materials'], ['assessmentTasks', 'Assessment Tasks (AT)']];
        return `<p class="oe-help">One item per line in each box. Use the arrows to reorder weeks; exam milestones (e.g. PRELIM EXAMINATION) appear as full-width rows.</p>
          <div class="oe-plan">
          ${m.teachingPlan.map((r, i) => {
            const tools = editable ? `<span class="oe-tools">
              <button type="button" class="icon-btn" data-plan-up="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}><i data-lucide="arrow-up" class="svg-icon"></i></button>
              <button type="button" class="icon-btn" data-plan-down="${i}" title="Move down" ${i === m.teachingPlan.length - 1 ? 'disabled' : ''}><i data-lucide="arrow-down" class="svg-icon"></i></button>
              <button type="button" class="icon-btn" data-plan-del="${i}" title="Remove"><i data-lucide="trash-2" class="svg-icon"></i></button></span>` : '';
            if (r.type === 'milestone') {
              return `<div class="oe-milestone"><i data-lucide="flag" class="svg-icon"></i><input class="input input-sm" data-plan="${i}" data-k="label" value="${esc(r.label)}" ${dis} />${tools}</div>`;
            }
            const first = (r.topics || [])[0] || '';
            return `<details class="oe-week" ${root.dataset.oeOpen === String(i) ? 'open' : ''} data-week="${i}">
              <summary><b>Week ${esc(r.week || '?')}</b><span class="t-muted">${esc(first)}</span>${tools}</summary>
              <div class="oe-week-body">
                <div class="field"><label class="field-label">Week</label><input class="input input-sm" data-plan="${i}" data-k="week" value="${esc(r.week)}" ${dis} /></div>
                ${fields.map(([k, label]) => `<div class="field"><label class="field-label">${label}</label><textarea class="textarea" rows="3" data-plan="${i}" data-k="${k}" ${dis}>${esc(joinLines(r[k]))}</textarea></div>`).join('')}
              </div>
            </details>`;
          }).join('') || '<p class="t-muted">No weeks yet.</p>'}
          </div>
          ${editable ? `<div class="oe-actions"><button type="button" class="btn btn-outline btn-sm" data-plan-add="week"><i data-lucide="plus" class="svg-icon"></i> Add Week</button>
            <button type="button" class="btn btn-outline btn-sm" data-plan-add="milestone"><i data-lucide="flag" class="svg-icon"></i> Add Exam Milestone</button></div>` : ''}`;
      }
      if (key === 'refs') {
        const groups = [['textbooks', 'Book References / Textbooks'], ['onlineResources', 'Online Resources'], ['journals', 'Journals / Researches'], ['suggested', 'Suggested Readings']];
        return `<p class="oe-help">One reference per line.</p><div class="oe-grid2">${groups.map(([k, label]) => `
          <div class="field"><label class="field-label">${label}</label><textarea class="textarea" rows="5" data-ref="${k}" ${dis}>${esc(joinLines(m.referenceGroups[k]))}</textarea></div>`).join('')}</div>`;
      }
      if (key === 'grading') {
        const total = m.grading.components.reduce((a, c) => a + (Number(c.weightPct) || 0), 0);
        return `<p class="oe-help">Each component (e.g. Lecture, Laboratory) has a weight, and its items should add up to 100%.
          <span class="${total === 100 || !m.grading.components.length ? 't-success' : 't-destructive'}">Components total: <b>${total}%</b></span></p>
          ${m.grading.components.map((c, ci) => {
            const sum = (c.items || []).reduce((a, it) => a + (Number(it.pct) || 0), 0);
            return `<div class="oe-comp">
              <div class="oe-comp-head">
                <input class="input input-sm" data-comp="${ci}" data-k="name" value="${esc(c.name)}" placeholder="Component name" ${dis} />
                <label class="oe-pct"><input class="input input-sm" type="number" min="0" max="100" data-comp="${ci}" data-k="weightPct" value="${esc(c.weightPct)}" ${dis} /> %</label>
                <input class="input input-sm" data-comp="${ci}" data-k="weightNote" value="${esc(c.weightNote || '')}" placeholder="Note (optional)" ${dis} />
                ${editable ? `<button type="button" class="icon-btn" data-comp-del="${ci}" title="Remove component"><i data-lucide="trash-2" class="svg-icon"></i></button>` : ''}
              </div>
              <div class="oe-items">
                <div class="oe-item oe-item-head"><span>Assessment item</span><span>Grade source</span><span>%</span><span></span></div>
                ${(c.items || []).map((it, ii) => `<div class="oe-item">
                  <input class="input input-sm" data-item="${ci}.${ii}" data-k="item" value="${esc(it.item)}" ${dis} />
                  <input class="input input-sm" data-item="${ci}.${ii}" data-k="source" value="${esc(it.source)}" ${dis} />
                  <input class="input input-sm" type="number" min="0" max="100" data-item="${ci}.${ii}" data-k="pct" value="${esc(it.pct)}" ${dis} />
                  ${editable ? `<button type="button" class="icon-btn" data-item-del="${ci}.${ii}" title="Remove"><i data-lucide="x" class="svg-icon"></i></button>` : '<span></span>'}
                </div>`).join('')}
                <p class="oe-sum ${sum === 100 || !(c.items || []).length ? 't-muted' : 't-destructive'}">Items total: ${sum}%</p>
                ${editable ? `<button type="button" class="btn btn-outline btn-sm" data-item-add="${ci}"><i data-lucide="plus" class="svg-icon"></i> Add Item</button>` : ''}
              </div>
            </div>`;
          }).join('')}
          ${editable ? '<button type="button" class="btn btn-outline btn-sm" data-comp-add><i data-lucide="plus" class="svg-icon"></i> Add Component</button>' : ''}`;
      }
      return `<div class="oe-grid2">
        <div class="field"><label class="field-label">Course Requirements (one per line)</label><textarea class="textarea" rows="6" data-oe-field="courseRequirements" ${dis}>${esc(joinLines(m.courseRequirements))}</textarea></div>
        <div class="field"><label class="field-label">Additional class policy notes (optional)</label><textarea class="textarea" rows="6" data-oe-field="classPoliciesOverride" ${dis} placeholder="Printed under Class Policies → Additional Notes">${esc(m.classPoliciesOverride)}</textarea></div>
      </div><p class="oe-help">The standard class policies (attendance, academic dishonesty, submission) come from the university's Organization Profile.</p>`;
    }

    function draw() {
      root.dataset.oeTab = active;
      root.innerHTML = `<div class="oe-tabs" role="tablist">${TABS.map((t) => `<button type="button" role="tab" class="${t.key === active ? 'active' : ''}" data-oe-tab="${t.key}">${t.label}<span class="oe-count">${tabCount(t.key)}</span>${(opts.feedbackParts || {})[t.key] ? '<span class="oe-fb-dot" title="Reviewer feedback here"></span>' : ''}</button>`).join('')}</div>
        ${opts.feedbackHtml ? opts.feedbackHtml(active) : ''}
        <div class="oe-panel">${panelHtml(active)}</div>`;
      if (window.lucide) window.lucide.createIcons();
      wire();
    }

    function wire() {
      root.querySelectorAll('[data-oe-tab]').forEach((b) => b.addEventListener('click', () => { active = b.dataset.oeTab; draw(); }));
      if (!editable) return;
      const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, () => fn(el)));
      const redraw = () => { changed(); draw(); };

      on('[data-oe-field]', 'input', (el) => {
        const k = el.dataset.oeField;
        m[k] = k === 'classPoliciesOverride' ? el.value : lines(el.value);
        changed();
      });
      // Student outcomes
      on('[data-so][data-k]', 'input', (el) => { m.soMap[Number(el.dataset.so)][el.dataset.k] = el.value; changed(); });
      on('[data-so][data-int]', 'change', (el) => {
        const row = m.soMap[Number(el.dataset.so)];
        const set = INTENSITY.filter((c) => String(row.intensity || '').toUpperCase().includes(c));
        const next = el.checked ? set.concat(el.dataset.int) : set.filter((c) => c !== el.dataset.int);
        row.intensity = INTENSITY.filter((c) => next.includes(c)).join(', ');
        changed();
      });
      on('[data-so-del]', 'click', (el) => { m.soMap.splice(Number(el.dataset.soDel), 1); redraw(); });
      on('[data-so-add]', 'click', () => { m.soMap.push({ soCode: `SO${m.soMap.length + 1}`, intensity: '', description: '' }); redraw(); });
      // Teaching plan
      on('[data-plan][data-k]', 'input', (el) => {
        const r = m.teachingPlan[Number(el.dataset.plan)];
        const k = el.dataset.k;
        r[k] = (k === 'week' || k === 'label') ? el.value : lines(el.value);
        changed();
      });
      on('details.oe-week', 'toggle', (el) => { if (el.open) root.dataset.oeOpen = el.dataset.week; });
      const move = (i, d) => { const j = i + d; if (j < 0 || j >= m.teachingPlan.length) return; const t = m.teachingPlan[i]; m.teachingPlan[i] = m.teachingPlan[j]; m.teachingPlan[j] = t; root.dataset.oeOpen = String(j); redraw(); };
      root.querySelectorAll('[data-plan-up],[data-plan-down],[data-plan-del]').forEach((el) => el.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (el.dataset.planUp !== undefined) move(Number(el.dataset.planUp), -1);
        else if (el.dataset.planDown !== undefined) move(Number(el.dataset.planDown), 1);
        else if (confirm('Remove this row from the Teaching and Learning Plan?')) { m.teachingPlan.splice(Number(el.dataset.planDel), 1); redraw(); }
      }));
      on('[data-plan-add]', 'click', (el) => {
        if (el.dataset.planAdd === 'milestone') m.teachingPlan.push({ type: 'milestone', label: 'EXAMINATION' });
        else {
          const weeks = m.teachingPlan.filter((r) => r.type !== 'milestone').length;
          m.teachingPlan.push({ type: 'week', week: String(weeks + 1), topics: [], ilo: [], tla: [], instructionalMaterials: [], assessmentTasks: [] });
          root.dataset.oeOpen = String(m.teachingPlan.length - 1);
        }
        redraw();
      });
      // References
      on('[data-ref]', 'input', (el) => { m.referenceGroups[el.dataset.ref] = lines(el.value); changed(); });
      // Grading
      on('[data-comp][data-k]', 'input', (el) => {
        const c = m.grading.components[Number(el.dataset.comp)];
        c[el.dataset.k] = el.dataset.k === 'weightPct' ? (Number(el.value) || 0) : el.value;
        changed();
      });
      on('[data-comp][data-k]', 'change', () => draw());
      on('[data-comp-del]', 'click', (el) => { if (confirm('Remove this grading component?')) { m.grading.components.splice(Number(el.dataset.compDel), 1); redraw(); } });
      on('[data-comp-add]', 'click', () => { m.grading.components.push({ name: 'New component', weightPct: 0, weightNote: '', items: [] }); redraw(); });
      on('[data-item][data-k]', 'input', (el) => {
        const [ci, ii] = el.dataset.item.split('.').map(Number);
        const it = m.grading.components[ci].items[ii];
        it[el.dataset.k] = el.dataset.k === 'pct' ? (Number(el.value) || 0) : el.value;
        changed();
      });
      on('[data-item][data-k="pct"]', 'change', () => draw());
      on('[data-item-del]', 'click', (el) => { const [ci, ii] = el.dataset.itemDel.split('.').map(Number); m.grading.components[ci].items.splice(ii, 1); redraw(); });
      on('[data-item-add]', 'click', (el) => { const c = m.grading.components[Number(el.dataset.itemAdd)]; if (!c.items) c.items = []; c.items.push({ item: '', source: '', pct: 0 }); redraw(); });
    }

    draw();
    return { model: () => clone(m) };
  }

  // Quick completeness checks for the Submit step.
  function checks(model) {
    const m = normalize(model);
    const total = m.grading.components.reduce((a, c) => a + (Number(c.weightPct) || 0), 0);
    return [
      { ok: m.outcomes.length > 0, label: `Course Intended Learning Outcomes (${m.outcomes.length})` },
      { ok: m.soMap.length > 0, label: `Student outcomes mapped (${m.soMap.length})` },
      { ok: m.teachingPlan.some((r) => r.type !== 'milestone'), label: `Teaching and Learning Plan (${m.teachingPlan.filter((r) => r.type !== 'milestone').length} weeks)` },
      { ok: !m.grading.components.length || total === 100, label: m.grading.components.length ? `Grading components total ${total}%${total === 100 ? '' : ' — should be 100%'}` : 'Grading system (none entered)', warn: !m.grading.components.length }
    ];
  }

  window.OBTLPEditor = { render, checks, normalize };
})();
