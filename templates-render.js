/*
  Data-driven OBTLP template renderer — OFFICIAL PnC LANDSCAPE FORMAT.

  Given an obtlpTemplates row (a `sections[]` list) and a merged data object
  (course + program + org-profile + portfolio instance fields), this file
  produces the same document twice:

    - renderSectionsHtml()  -> HTML for the on-screen preview
    - buildOfficialPdf()    -> a real multi-page jsPDF document

  Both follow the official Pamantasan ng Cabuyao OBTLP form
  (PNC:AA-FO-06 rev.2 08182023) as the 2026-2027 BS CS / BS IT templates
  are laid out: A4 LANDSCAPE, the university letterhead with the seal on
  every page, the form code + page number at the top right, "Dangal ng
  Bayan" at the bottom, and the same bordered tables in the same order
  (Vision/Mission/Core Values/Graduate Attributes -> PEO/CILO/Student
  Outcomes map -> Course information -> Teaching and Learning Plan ->
  References / Grading / Requirements / Policies / Effectivity ->
  Signatories).

  Section `type`s are still generic, so a future template that only uses
  these types needs no code change here.

  Cell-list convention (teaching plan cells): an item starting with "• " is
  drawn as a bullet; other items are plain lines. Items such as "Lecture",
  "Laboratory", "Associated CILO/s: ..." and "At the end of the lesson..."
  are drawn bold as sub-headings. Older data with no "• " items at all
  (e.g. the first CCS101 seed) is drawn with every non-heading item
  bulleted, so nothing that worked before changes.
*/
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function get(obj, path, fallback) {
    const parts = String(path || '').split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return fallback;
      cur = cur[p];
    }
    return cur == null ? fallback : cur;
  }

  // ---------------------------------------------------------------------
  // Template resolution
  // ---------------------------------------------------------------------
  function resolveTemplate(courseTemplate, allTemplates) {
    if (!courseTemplate || !courseTemplate.obtlpTemplateId) return null;
    const tpl = (allTemplates || []).find((t) => t.id === courseTemplate.obtlpTemplateId);
    if (!tpl || !tpl.active) return null;
    return tpl;
  }

  // ---------------------------------------------------------------------
  // Shared content helpers (used by both HTML and PDF)
  // ---------------------------------------------------------------------
  const HEADING_RE = /^(lecture|laboratory|lec|lab|lecture\s*\/\s*laboratory)\s*:?\s*$/i;
  function isHeadingItem(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (HEADING_RE.test(t)) return true;
    if (/^associated\s+cilo/i.test(t)) return true;
    if (/^at the end of (the )?(lesson|session|week|topic|discussion)/i.test(t)) return true;
    return false;
  }

  // Normalizes a list of strings into [{ text, kind: 'bullet'|'heading'|'plain' }]
  function classifyItems(items) {
    const arr = (items || []).map((s) => String(s == null ? '' : s)).filter((s) => s.trim());
    const explicit = arr.some((s) => /^•\s/.test(s));
    return arr.map((s) => {
      if (/^•\s/.test(s)) return { text: s.replace(/^•\s+/, ''), kind: 'bullet' };
      if (isHeadingItem(s)) return { text: s, kind: 'heading' };
      return { text: s, kind: explicit ? 'plain' : 'bullet' };
    });
  }

  function orgValue(data, key) {
    const meta = data.officialMeta || {};
    if (meta[key]) return meta[key];
    return get(data, `orgProfile.${key}`, '');
  }

  function departmentLabel(data) {
    const meta = data.officialMeta || {};
    if (meta.departmentLabel) return meta.departmentLabel;
    const prog = data.program || {};
    if (/computer science/i.test(prog.name || '')) return 'Computer Science';
    if (/information technology/i.test(prog.name || '')) return 'Information Technology';
    return data.facultyDept || '';
  }

  function creditUnits(data) {
    const meta = data.officialMeta || {};
    // The Units field is pre-filled from the template's Credit Units and
    // stays editable, so a value the faculty entered wins.
    return data.facultyUnits || meta.creditUnits || data.units || '';
  }

  function letterheadLines(data) {
    const lh = get(data, 'orgProfile.letterhead', {}) || {};
    return {
      line1: lh.line1 || 'Republic of the Philippines',
      line2: lh.line2 || 'Pamantasan ng Cabuyao',
      line3: (lh.line3 || '(University of Cabuyao)').toUpperCase(),
      // The division line differs between versions of the form
      // ("Academic Affairs Division" vs "Academics and Student Services
      // Division"), so each course keeps the one its official copy uses.
      line4: get(data, 'officialMeta.division', '') || lh.line4 || 'Academics and Student Services Division',
      address: lh.address || 'Katapatan Mutual Homes, Brgy. Banay-banay, City of Cabuyao, Laguna 4025'
    };
  }

  function peoIntro(data) {
    const meta = data.officialMeta || {};
    return meta.peoIntro || get(data, 'program.peoIntro', '');
  }

  function peoList(data) {
    const meta = data.officialMeta || {};
    if (Array.isArray(meta.peo) && meta.peo.length) return meta.peo;
    return get(data, 'program.peo', []) || [];
  }

  // SO rows: prefer the course-specific description stored on the soMap row
  // (the official templates word SOs slightly differently per course), fall
  // back to the program's Student Outcome list.
  function soRows(data) {
    const program = data.program || {};
    return (data.soMap || []).map((row) => {
      const so = (program.studentOutcomes || []).find((s) => s.code === row.soCode);
      return {
        code: row.soCode,
        description: row.description || (so ? so.description : ''),
        intensity: String(row.intensity || '').toUpperCase().split(/\s*,\s*/).filter(Boolean)
      };
    });
  }

  function formatSoCode(code) {
    const m = String(code || '').match(/^SO\s*0*(\d+)$/i);
    return m ? `SO ${m[1]}.` : String(code || '');
  }

  // Signatories: a value saved on the portfolio wins; otherwise the default
  // from the course's official template (officialMeta.signatories);
  // "Prepared by" falls back to the faculty member preparing the portfolio.
  function signatoryColumns(data, section) {
    const saved = data.signatories || {};
    const defaults = get(data, 'officialMeta.signatories', {}) || {};
    const roles = (section && section.roles) || [
      { key: 'preparedBy', label: 'Prepared by:' },
      { key: 'reviewedBy', label: 'Reviewed and Recommended by:' },
      { key: 'concurredBy', label: 'Concurred by:' },
      { key: 'approvedBy', label: 'Approved by:' }
    ];
    return roles.map((role) => {
      let people = [];
      const s = saved[role.key];
      if (Array.isArray(s) && s.length) people = s.map((x) => ({ name: x.name, title: x.title || '', date: x.date || '' }));
      else if (s && !Array.isArray(s) && s.name) people = [{ name: s.name, title: s.title || '', date: s.date || '' }];
      if (!people.length && Array.isArray(defaults[role.key]) && defaults[role.key].length) {
        people = defaults[role.key].map((x) => ({ name: x.name, title: x.title || '', date: '' }));
      }
      if (!people.length && role.key === 'preparedBy' && data.faculty) people = [{ name: data.faculty, title: 'Faculty', date: '' }];
      if (!people.length) people = [{ name: '', title: '', date: '' }];
      return { label: role.label, people };
    });
  }

  // Groups the flat sections[] into the official document's parts so both
  // renderers walk the same structure.
  function planDocument(template) {
    const sections = (template && template.sections) || [];
    const has = (type) => sections.some((s) => s.type === type);
    const find = (type) => sections.find((s) => s.type === type);
    const bottom = sections.filter((s) => ['referenceList', 'gradingBreakdown', 'staticAttendanceTable', 'list', 'classPolicies', 'richtext'].includes(s.type));
    return {
      org: has('staticOrgTable'),
      outcomes: has('programOutcomes') || has('soMatrix'),
      soSection: find('soMatrix'),
      courseInfo: find('keyvalueGrid'),
      plan: find('weeklyPlanTable'),
      bottom,
      signature: find('signatureBlock')
    };
  }

  function bottomLabel(section) {
    switch (section.type) {
      case 'referenceList': return 'TEXTBOOKS AND REFERENCE MATERIALS';
      case 'gradingBreakdown': return 'GRADING SYSTEM';
      case 'classPolicies': return 'CLASS POLICIES';
      case 'staticAttendanceTable': return 'ATTENDANCE';
      case 'richtext': return /effectiv/i.test(section.label || section.key || '') ? 'EFFECTIVITY PERIOD' : String(section.label || '').toUpperCase();
      default: return String(section.label || '').toUpperCase();
    }
  }

  function referenceGroupsOf(section, data) {
    const rg = data.referenceGroups || {};
    const groups = (section.groups || [
      { key: 'textbooks', label: 'Book References' },
      { key: 'onlineResources', label: 'Online Resources' }
    ]).slice();
    if ((rg.journals || []).length && !groups.some((g) => g.key === 'journals')) groups.push({ key: 'journals', label: 'Journals / Researches' });
    const out = groups.map((g) => ({ label: g.label, items: rg[g.key] || [] })).filter((g) => g.items.length);
    if (!out.length && (data.references || []).length) out.push({ label: '', items: data.references });
    return out;
  }

  function gradingIntro(data) {
    return get(data, 'officialMeta.gradingIntro', '') || 'The final grade in this course will be composed of the following items and their weights in the final grade computation:';
  }

  const DEFAULT_TLP_COLS = ['Week', 'Topics', 'Intended Learning Outcomes (ILO)', 'Teaching and Learning Activities (TLA)', 'Instructional Material', 'Assessment Tasks (AT)'];
  const TLP_FRACTIONS = [0.06, 0.19, 0.25, 0.17, 0.15, 0.18];

  // =====================================================================
  // HTML (on-screen preview)
  // =====================================================================
  function htmlItems(items) {
    const cls = classifyItems(items);
    let html = '';
    let inList = false;
    cls.forEach((it) => {
      if (it.kind === 'bullet') {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${escapeHtml(it.text)}</li>`;
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += it.kind === 'heading' ? `<p class="oo-sub">${escapeHtml(it.text)}</p>` : `<p>${escapeHtml(it.text)}</p>`;
      }
    });
    if (inList) html += '</ul>';
    return html;
  }

  function htmlLetterhead(data, pageNo, formCode) {
    const lh = letterheadLines(data);
    return `
      <div class="oo-page-top">${escapeHtml(formCode || 'PNC:AA-FO-06 rev.2 08182023')} / Page${pageNo}</div>
      <div class="oo-letterhead">
        <img class="oo-seal" src="assets/pnc-logo.png" alt="PnC seal" />
        <div class="oo-lh-text">
          <div class="oo-lh-1">${escapeHtml(lh.line1)}</div>
          <div class="oo-lh-2">${escapeHtml(lh.line2)}</div>
          <div class="oo-lh-3">${escapeHtml(lh.line3)}</div>
          <div class="oo-lh-4">${escapeHtml(lh.line4)}</div>
          <div class="oo-lh-5">${escapeHtml(lh.address)}</div>
        </div>
      </div>`;
  }

  function htmlFooter() {
    return '<div class="oo-footer"><div class="oo-dangal">Dangal ng Bayan.</div><div class="oo-dangal-sub">bringing pride and honor to the nation.</div></div>';
  }

  function htmlAttendance(data) {
    const rule = get(data, 'orgProfile.attendanceRule', {});
    return `<p style="margin-top:0.5rem">${escapeHtml(rule.note || '')}</p>
      <table class="oo-inner oo-attendance"><tr>${(rule.columns || []).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
      ${(rule.rows || []).map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  // ---------------------------------------------------------------------
  // Reviewer feedback inside the document (panel feedback, Oct 2026).
  // data.feedback = [{ part, text, byName, role, resolved }]. Open notes
  // are numbered 1..n; the part of the document they are about is outlined
  // in yellow with the numbered notes right above it, and the PDF gets a
  // yellow bar in the margin plus a "Reviewer Feedback" page.
  // ---------------------------------------------------------------------
  const FEEDBACK_LABEL = {
    general: 'General', courseInfo: 'Course Information', outcomes: 'Learning Outcomes (CILO)', soMap: 'Student Outcomes Map',
    plan: 'Teaching and Learning Plan', references: 'References', grading: 'Grading / Course Requirements', policies: 'Course Policies'
  };
  const FEEDBACK_ROLE = { chair: 'Department Chair', admin: 'Dean', vpaa: 'VPAA' };
  function openFeedback(data) {
    return (data.feedback || []).filter((f) => !f.resolved).map((f, i) => Object.assign({ n: i + 1 }, f));
  }
  function fbFor(data, parts) { return openFeedback(data).filter((f) => parts.includes(f.part)); }
  function fbNotesHtml(list) {
    return `<div class="oo-fb">${list.map((f) => `<div class="oo-fb-note"><span class="oo-fb-n">${f.n}</span><div>
      <p class="oo-fb-meta">${escapeHtml(FEEDBACK_LABEL[f.part] || 'General')} · ${escapeHtml(FEEDBACK_ROLE[f.role] || 'Reviewer')}${f.byName ? ` (${escapeHtml(f.byName)})` : ''}</p>
      <p>${escapeHtml(f.text)}</p></div></div>`).join('')}</div>`;
  }
  function fbWrap(data, parts, html) {
    const list = fbFor(data, parts);
    if (!list.length) return html;
    return `<div class="oo-fb-part">${fbNotesHtml(list)}<div class="oo-fb-target">${html}</div></div>`;
  }
  function fbGeneral(data) {
    const list = fbFor(data, ['general']);
    return list.length ? fbNotesHtml(list) : '';
  }

  function renderSectionsHtml(template, data) {
    if (!template) return '';
    if (template.layout === 'course-outline') return renderCourseOutlineHtml(template, data);
    const plan = planDocument(template);
    const formCode = template.formCode || '';
    const pages = [];

    // Page 1 — title + Vision / Mission / Core Values / Graduate Attributes
    if (plan.org) {
      const org = data.orgProfile || {};
      pages.push(`
        <div class="oo-title">
          <div>OUTCOMES-BASED TEACHING AND LEARNING PLAN</div>
          <div>in ${escapeHtml(data.courseCode)} – ${escapeHtml(String(data.courseTitle || '').toUpperCase())}</div>
          <div>Department: ${escapeHtml(departmentLabel(data))}</div>
        </div>
        <table class="oo-table oo-org">
          <colgroup><col style="width:50%"><col style="width:50%"></colgroup>
          <tr><th>VISION</th><th>CORE VALUES</th></tr>
          <tr>
            <td><p>${escapeHtml(orgValue(data, 'vision'))}</p></td>
            <td><p>${escapeHtml(org.coreValuesIntro || '')}</p><ul>${(org.coreValues || []).map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ul></td>
          </tr>
          <tr><th>MISSION</th><th>PnC (UC) GRADUATE ATTRIBUTES</th></tr>
          <tr>
            <td><p>${escapeHtml(orgValue(data, 'mission'))}</p></td>
            <td><ol>${(org.graduateAttributes || []).map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ol></td>
          </tr>
        </table>`);
    }

    // Page 2 — PEO / CILO / Student Outcomes map + course information
    let p2 = '';
    if (plan.outcomes) {
      const program = data.program || {};
      const sos = soRows(data);
      const cols = (plan.soSection && plan.soSection.columns) || ['I/L', 'E/P', 'D/O'];
      p2 += fbWrap(data, ['outcomes', 'soMap'], `
        <table class="oo-table oo-outcomes">
          <colgroup><col style="width:16%"><col style="width:7%"><col><col style="width:6%"><col style="width:6%"><col style="width:6%"></colgroup>
          <tr><th class="oo-rowlabel">Program Educational Objectives</th>
            <td colspan="5"><p>${escapeHtml(peoIntro(data))}</p><ol>${peoList(data).map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ol></td></tr>
          <tr><th class="oo-rowlabel">Course Intended Learning Outcomes (CILO)</th>
            <td colspan="5"><ol>${(data.outcomes || []).map((v) => `<li>${escapeHtml(v)}</li>`).join('') || '<li class="t-muted">No CILO on file yet.</li>'}</ol></td></tr>
          <tr><th class="oo-rowlabel" rowspan="${Math.max(1, sos.length) + 1}">Student Outcomes Map Addressed by the Course</th>
            <td colspan="2"></td>${cols.map((c) => `<th class="oo-center">${escapeHtml(c)}</th>`).join('')}</tr>
          ${sos.length ? sos.map((so) => `<tr><td>${escapeHtml(formatSoCode(so.code))}</td><td>${escapeHtml(so.description)}</td>${cols.map((c) => `<td class="oo-center oo-check">${so.intensity.includes(c.toUpperCase()) ? '&#10003;' : ''}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${2 + cols.length}" class="t-muted">No student outcomes mapped yet.</td></tr>`}
        </table>
        <div class="oo-legend">Legend:<br>I/L – Introductory/Learning<br>E/P – Enabling/Practice<br>D/O – Demonstrating/Opportunity</div>`);
    }
    if (plan.courseInfo) {
      p2 += fbWrap(data, ['courseInfo'], `
        <table class="oo-table oo-courseinfo">
          <colgroup><col style="width:16%"><col style="width:18%"><col style="width:24%"><col></colgroup>
          <tr><th>COURSE/SUBJECT CODE</th><td>${escapeHtml(data.courseCode)}</td><th>COURSE/SUBJECT TITLE</th><td class="oo-strong">${escapeHtml(String(data.courseTitle || '').toUpperCase())}</td></tr>
          <tr><th>CREDIT UNITS</th><td>${escapeHtml(creditUnits(data))}</td><th>COURSE/SUBJECT PRE-REQUISITE/CO-REQUISITE</th><td>${escapeHtml(data.prerequisite || 'None')}</td></tr>
          <tr><th>COURSE/SUBJECT DESCRIPTION</th><td colspan="3">${escapeHtml(data.description || '')}</td></tr>
        </table>`);
    }
    if (p2) pages.push(p2);

    // Teaching and Learning Plan
    if (plan.plan) {
      const cols = plan.plan.columns && plan.plan.columns.length === 6 ? plan.plan.columns : DEFAULT_TLP_COLS;
      const rows = (data.teachingPlan || []).map((row) => {
        if (row.type === 'milestone') return `<tr class="oo-milestone"><td colspan="6">${escapeHtml(row.label)}</td></tr>`;
        return `<tr>
          <td class="oo-center oo-middle">${escapeHtml(row.week)}</td>
          <td>${htmlItems(row.topics)}</td>
          <td>${htmlItems(row.ilo)}</td>
          <td>${htmlItems(row.tla)}</td>
          <td>${htmlItems(row.instructionalMaterials)}</td>
          <td>${htmlItems(row.assessmentTasks)}</td>
        </tr>`;
      }).join('');
      pages.push(fbWrap(data, ['plan'], `
        <div class="oo-section-title">TEACHING AND LEARNING PLAN</div>
        <table class="oo-table oo-plan">
          <colgroup>${TLP_FRACTIONS.map((f) => `<col style="width:${f * 100}%">`).join('')}</colgroup>
          <thead><tr>${cols.map((c) => `<th class="oo-center">${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="t-muted">No teaching plan entered yet.</td></tr>'}</tbody>
        </table>`));
    }

    // References / Grading / Requirements / Policies / Effectivity
    if (plan.bottom.length) {
      let html = '<table class="oo-table oo-bottom"><colgroup><col style="width:16%"><col></colgroup>';
      for (let i = 0; i < plan.bottom.length; i++) {
        const s = plan.bottom[i];
        let body = '';
        if (s.type === 'referenceList') {
          body = referenceGroupsOf(s, data).map((g) => `${g.label ? `<p class="oo-sub">${escapeHtml(g.label)}:</p>` : ''}<ol class="oo-refs">${g.items.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ol>`).join('') || '<p class="t-muted">No references listed yet.</p>';
        } else if (s.type === 'gradingBreakdown') {
          const comps = get(data, 'grading.components', []);
          body = `<p>${escapeHtml(gradingIntro(data))}</p>` + (comps.length ? comps.map((comp) => {
            const sum = (comp.items || []).reduce((a, it) => a + (Number(it.pct) || 0), 0);
            return `<p class="oo-sub">${escapeHtml(comp.name)} (${escapeHtml(comp.weightPct)}%)${comp.weightNote ? ` <span class="oo-note">${escapeHtml(comp.weightNote)}</span>` : ''}</p>
              <table class="oo-inner"><tr><th>Assessment item</th><th>Grade Source</th><th>Percentage</th></tr>
              ${(comp.items || []).map((it) => `<tr><td>${escapeHtml(it.item)}</td><td>${escapeHtml(it.source)}</td><td>${escapeHtml(it.pct)}%</td></tr>`).join('')}
              <tr class="oo-strong"><td>Total</td><td></td><td>${sum}%</td></tr></table>`;
          }).join('') : '<p class="t-muted">No grading breakdown entered yet.</p>');
          // the attendance table is printed inside the GRADING SYSTEM box
          if (plan.bottom[i + 1] && plan.bottom[i + 1].type === 'staticAttendanceTable') {
            body += htmlAttendance(data);
            i++;
          }
        } else if (s.type === 'staticAttendanceTable') {
          body = htmlAttendance(data);
        } else if (s.type === 'list') {
          // Some official forms have no such row (e.g. Course Requirements
          // in CSP114/ITP103) — leave it out instead of printing a blank row.
          if (!(data[s.source] || []).length) continue;
          body = (data[s.source] || []).map((v) => `<p>${escapeHtml(v)}</p>`).join('');
        } else if (s.type === 'classPolicies') {
          const cp = get(data, 'orgProfile.classPolicies', {});
          body = `<p class="oo-sub">${escapeHtml(cp.attendanceHeading || 'Class Attendance')}</p><p>${escapeHtml(cp.attendanceText || '')}</p>
            <p class="oo-sub" style="margin-top:0.5rem">${escapeHtml(cp.academicDishonestyHeading || 'Academic Dishonesty')}</p><p>${escapeHtml(cp.academicDishonestyIntro || '')}</p>
            <ol type="a">${(cp.academicDishonestyItems || []).map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ol>
            <p class="oo-sub" style="margin-top:0.5rem">${escapeHtml(cp.submissionHeading || 'Submission of Course Requirements')}</p><p>${escapeHtml(cp.submissionText || '')}</p>
            ${data.classPoliciesOverride ? `<p class="oo-sub" style="margin-top:0.5rem">Additional Notes</p><p>${escapeHtml(data.classPoliciesOverride)}</p>` : ''}`;
        } else if (s.type === 'richtext') {
          body = `<p>${escapeHtml((s.source && data[s.source]) || data.effectivityText || template.effectivityText || '')}</p>`;
        }
        html += `<tr><th class="oo-rowlabel">${escapeHtml(bottomLabel(s))}</th><td>${body}</td></tr>`;
      }
      html += '</table>';
      pages.push(fbWrap(data, ['references', 'grading', 'policies'], html));
    }

    if (plan.signature) {
      const cols = signatoryColumns(data, plan.signature);
      pages.push(`<div class="oo-signatures">${cols.map((c) => `
        <div class="oo-sig-col"><div class="oo-sig-role">${escapeHtml(c.label)}</div>
          ${c.people.map((p) => `<div class="oo-sig-person">
            <div class="oo-sig-name">${escapeHtml(String(p.name || '').toUpperCase()) || '&nbsp;'}</div>
            <div class="oo-sig-cap">Signature Over Printed Name</div>
            <div class="oo-sig-title">${escapeHtml(p.title || '')}</div>
            <div class="oo-sig-date">Date: ${escapeHtml(p.date || '')}</div>
          </div>`).join('')}
        </div>`).join('')}</div>`);
    }

    if (pages.length) pages[0] = fbGeneral(data) + pages[0];
    return `<div class="obtlp-official">${pages.map((content, idx) => `
      <section class="oo-page">
        ${htmlLetterhead(data, idx + 1, formCode)}
        <div class="oo-content">${content}</div>
        ${htmlFooter()}
      </section>`).join('')}</div>`;
  }

  // =====================================================================
  // PDF (jsPDF) — A4 landscape, official page frame on every page
  // =====================================================================
  const PT = {
    pageW: 841.89, pageH: 595.28,
    marginX: 36,
    contentTop: 110,
    contentBottom: 545,
    fs: 8.5, lh: 10.6, pad: 4
  };

  function makeCtx(doc, data, logoDataUrl, template) {
    const ctx = {
      doc, data, template, logoDataUrl,
      x0: PT.marginX,
      width: PT.pageW - PT.marginX * 2,
      y: PT.contentTop,
      pageBreakHooks: [],
      pageStartHooks: []
    };
    ctx.newPage = function () {
      ctx.pageBreakHooks.slice().forEach((fn) => fn());
      doc.addPage('a4', 'landscape');
      drawFrame(ctx);
      ctx.y = PT.contentTop;
      ctx.pageStartHooks.slice().forEach((fn) => fn());
    };
    ctx.ensure = function (h) {
      if (ctx.y + h > PT.contentBottom) ctx.newPage();
    };
    return ctx;
  }

  function drawFrame(ctx) {
    const { doc } = ctx;
    const lh = letterheadLines(ctx.data);
    const cx = PT.pageW / 2;
    if (ctx.logoDataUrl) {
      try { doc.addImage(ctx.logoDataUrl, 'PNG', cx - 200, 32, 60, 60); } catch (e) { /* keep going without the seal */ }
    }
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(lh.line1, cx, 42, { align: 'center' });
    doc.setFont('times', 'bold'); doc.setFontSize(16);
    doc.text(lh.line2, cx, 58, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(lh.line3, cx, 70, { align: 'center' });
    doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(9);
    doc.text(lh.line4, cx, 81, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
    doc.text(lh.address, cx, 91, { align: 'center' });
    doc.setFont('times', 'italic'); doc.setFontSize(12);
    doc.text('Dangal ng Bayan.', cx, 565, { align: 'center' });
    doc.setFont('helvetica', 'italic'); doc.setFontSize(5.5);
    doc.text('bringing pride and honor to the nation.', cx + 8, 572, { align: 'center' });
  }

  function P(text, extra) { return Object.assign({ text, kind: 'plain' }, extra || {}); }

  // Wraps items into draw-ready lines for a column of width w.
  // items are either plain strings (classified with classifyItems) or, when
  // opts.raw, pre-classified objects { text, kind, bold, align, n }.
  function wrapItems(doc, items, w, opts) {
    opts = opts || {};
    const fs = opts.fs || PT.fs;
    const out = [];
    const cls = opts.raw ? items : classifyItems(items);
    cls.forEach((it) => {
      if (it.kind === 'gap') { out.push({ text: '', gap: true }); return; }
      const text = String(it.text == null ? '' : it.text);
      if (it.kind === 'bullet' || it.kind === 'number') {
        const prefix = it.kind === 'number' ? `${it.n}.` : '•';
        const indent = it.kind === 'number' ? 13 : 9;
        doc.setFont('helvetica', it.bold ? 'bold' : 'normal'); doc.setFontSize(fs);
        doc.splitTextToSize(text, Math.max(10, w - indent)).forEach((ln, i) => out.push({ text: ln, bold: !!it.bold, dx: indent, prefix: i === 0 ? prefix : '' }));
      } else {
        const bold = it.kind === 'heading' || !!it.bold;
        doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(fs);
        doc.splitTextToSize(text || ' ', Math.max(10, w)).forEach((ln) => out.push({ text: ln, bold, dx: 0, align: it.align }));
      }
    });
    return out;
  }

  // Generic bordered table whose rows split across pages line-by-line.
  // row = { cells: [{ items|lines, raw, span, fill, align, valign, contTop, openBottom }] }
  function drawTable(ctx, widths, rows, opts) {
    opts = opts || {};
    const { doc } = ctx;
    const x0 = opts.x != null ? opts.x : ctx.x0;
    const lh = opts.lh || PT.lh;
    const pad = opts.pad != null ? opts.pad : PT.pad;
    const fs = opts.fs || PT.fs;

    rows.forEach((row) => {
      let col = 0;
      const cells = row.cells.map((c) => {
        const span = c.span || 1;
        const x = x0 + widths.slice(0, col).reduce((a, b) => a + b, 0);
        const w = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        col += span;
        const lines = c.lines ? c.lines.slice() : wrapItems(doc, c.items || [], w - pad * 2, { fs, raw: !!c.raw });
        return Object.assign({}, c, { x, w, lines });
      });
      let first = true;
      let guard = 0;
      while (guard++ < 200) {
        const remaining = Math.max(1, ...cells.map((c) => c.lines.length));
        const avail = PT.contentBottom - ctx.y;
        const minLines = Math.min(remaining, 3);
        if (avail < minLines * lh + pad * 2 && ctx.y > PT.contentTop + 1) { ctx.newPage(); continue; }
        const fit = Math.max(1, Math.min(remaining, Math.floor((avail - pad * 2) / lh)));
        const split = fit < remaining;
        const h = fit * lh + pad * 2;
        cells.forEach((c) => {
          if (c.fill) { doc.setFillColor(c.fill[0], c.fill[1], c.fill[2]); doc.rect(c.x, ctx.y, c.w, h, 'F'); }
          doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.6);
          doc.line(c.x, ctx.y, c.x, ctx.y + h);
          doc.line(c.x + c.w, ctx.y, c.x + c.w, ctx.y + h);
          if (!(c.contTop && first)) doc.line(c.x, ctx.y, c.x + c.w, ctx.y);
          if (!c.openBottom || split) doc.line(c.x, ctx.y + h, c.x + c.w, ctx.y + h);
          const take = c.lines.splice(0, fit);
          let ty = ctx.y + pad + fs * 0.85;
          if (c.valign === 'middle' && !split && first) ty += Math.max(0, (h - pad * 2 - take.length * lh) / 2);
          take.forEach((ln) => {
            if (ln.gap) { ty += lh; return; }
            doc.setFont(ln.font || 'helvetica', ln.font ? 'normal' : (ln.bold ? 'bold' : 'normal'));
            doc.setFontSize(ln.fs || fs);
            doc.setTextColor(0, 0, 0);
            const align = ln.align || c.align;
            if (ln.prefix) doc.text(ln.prefix, c.x + pad, ty);
            if (align === 'center') doc.text(ln.text, c.x + c.w / 2, ty, { align: 'center' });
            else doc.text(ln.text, c.x + pad + (ln.dx || 0), ty);
            ty += lh;
          });
        });
        ctx.y += h;
        first = false;
        if (!split) break;
        ctx.newPage();
      }
    });
  }

  function pdfTitleAndOrg(ctx) {
    const { doc, data } = ctx;
    const org = data.orgProfile || {};
    const cx = PT.pageW / 2;
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text('OUTCOMES-BASED TEACHING AND LEARNING PLAN', cx, ctx.y + 8, { align: 'center' });
    const t2 = doc.splitTextToSize(`in ${data.courseCode} – ${String(data.courseTitle || '').toUpperCase()}`, ctx.width - 80);
    t2.forEach((ln, i) => doc.text(ln, cx, ctx.y + 23 + i * 14, { align: 'center' }));
    doc.text(`Department: ${departmentLabel(data)}`, cx, ctx.y + 23 + t2.length * 14, { align: 'center' });
    ctx.y += 36 + t2.length * 14;

    const half = ctx.width / 2;
    const head = (t) => ({ items: [P(t, { bold: true })], raw: true });
    const coreItems = [P(org.coreValuesIntro || ''), { kind: 'gap' }].concat((org.coreValues || []).map((v) => ({ text: v, kind: 'bullet' })));
    const gaItems = (org.graduateAttributes || []).map((v, i) => ({ text: v, kind: 'number', n: i + 1 }));
    drawTable(ctx, [half, half], [
      { cells: [head('VISION'), head('CORE VALUES')] },
      { cells: [{ items: [P(orgValue(data, 'vision'))], raw: true }, { items: coreItems, raw: true }] },
      { cells: [head('MISSION'), head('PnC (UC) GRADUATE ATTRIBUTES')] },
      { cells: [{ items: [P(orgValue(data, 'mission'))], raw: true }, { items: gaItems, raw: true }] }
    ], { fs: 10, lh: 13, pad: 6 });
  }

  function pdfOutcomes(ctx, plan) {
    const { data, doc } = ctx;
    const program = data.program || {};
    const W = ctx.width;
    const cols = (plan.soSection && plan.soSection.columns) || ['I/L', 'E/P', 'D/O'];
    const labelW = 124, codeW = 48, markW = 46;
    const descW = W - labelW - codeW - markW * cols.length;
    const widths = [labelW, codeW, descW].concat(cols.map(() => markW));
    const label = (t) => ({ items: [P(t, { bold: true })], raw: true });
    const peoItems = [P(peoIntro(data))].concat(peoList(data).map((v, i) => ({ text: v, kind: 'number', n: i + 1 })));
    const ciloItems = (data.outcomes || []).map((v, i) => ({ text: v, kind: 'number', n: i + 1 }));
    const rows = [
      { cells: [label('Program Educational Objectives'), { items: peoItems, raw: true, span: 2 + cols.length }] },
      { cells: [label('Course Intended Learning Outcomes (CILO)'), { items: ciloItems.length ? ciloItems : [P('No CILO on file yet.')], raw: true, span: 2 + cols.length }] }
    ];
    const sos = soRows(data);
    rows.push({ cells: [
      Object.assign(label('Student Outcomes Map Addressed by the Course'), { openBottom: sos.length > 0 }),
      { items: [P('')], raw: true, span: 2 }
    ].concat(cols.map((c) => ({ items: [P(c, { bold: true, align: 'center' })], raw: true }))) });
    sos.forEach((so, i) => {
      rows.push({ cells: [
        { lines: [], contTop: true, openBottom: i < sos.length - 1 },
        { items: [P(formatSoCode(so.code))], raw: true },
        { items: [P(so.description)], raw: true }
      ].concat(cols.map((c) => (so.intensity.includes(c.toUpperCase())
        ? { lines: [{ text: '4', font: 'zapfdingbats', fs: 11, align: 'center' }], valign: 'middle' }
        : { lines: [] }))) });
    });
    drawTable(ctx, widths, rows, { fs: 9, lh: 11.5, pad: 5 });

    ctx.ensure(52);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 0, 0);
    ['Legend:', 'I/L – Introductory/Learning', 'E/P – Enabling/Practice', 'D/O – Demonstrating/Opportunity'].forEach((t, i) => doc.text(t, ctx.x0, ctx.y + 14 + i * 10.5));
    ctx.y += 14 + 4 * 10.5 + 4;
  }

  function pdfCourseInfo(ctx) {
    const { data } = ctx;
    const W = ctx.width;
    const widths = [124, 140, 200, W - 124 - 140 - 200];
    const b = (t) => ({ items: [P(t, { bold: true })], raw: true });
    const v = (t, bold) => ({ items: [P(t, { bold: !!bold })], raw: true });
    drawTable(ctx, widths, [
      { cells: [b('COURSE/SUBJECT CODE'), v(data.courseCode), b('COURSE/SUBJECT TITLE'), v(String(data.courseTitle || '').toUpperCase(), true)] },
      { cells: [b('CREDIT UNITS'), v(creditUnits(data)), b('COURSE/SUBJECT PRE-REQUISITE/CO-REQUISITE'), v(data.prerequisite || 'None')] },
      { cells: [b('COURSE/SUBJECT DESCRIPTION'), Object.assign(v(data.description || ''), { span: 3 })] }
    ], { fs: 9, lh: 11.5, pad: 5 });
  }

  function pdfPlan(ctx, section) {
    const { doc, data } = ctx;
    const cols = section.columns && section.columns.length === 6 ? section.columns : DEFAULT_TLP_COLS;
    const widths = TLP_FRACTIONS.map((f) => f * ctx.width);
    ctx.ensure(90);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0, 0, 0);
    doc.text('TEACHING AND LEARNING PLAN', PT.pageW / 2, ctx.y + 6, { align: 'center' });
    ctx.y += 14;
    const rows = [{ cells: cols.map((c) => ({ items: [P(c, { bold: true, align: 'center' })], raw: true })) }];
    (data.teachingPlan || []).forEach((r) => {
      if (r.type === 'milestone') {
        rows.push({ cells: [{ items: [P(r.label, { bold: true, align: 'center' })], raw: true, span: 6, fill: [242, 242, 242] }] });
        return;
      }
      rows.push({ cells: [
        { items: [P(r.week, { align: 'center' })], raw: true, valign: 'middle' },
        { items: r.topics || [] },
        { items: r.ilo || [] },
        { items: r.tla || [] },
        { items: r.instructionalMaterials || [] },
        { items: r.assessmentTasks || [] }
      ] });
    });
    if (rows.length === 1) rows.push({ cells: [{ items: [P('No teaching plan entered yet.')], raw: true, span: 6 }] });
    drawTable(ctx, widths, rows, { fs: 8.5, lh: 10.6, pad: 4 });
  }

  // Bottom 2-column boxes (label | content). Content may hold nested
  // tables, so each box is a "block" whose outline is closed at every page
  // break and reopened on the next page.
  function pdfBottom(ctx, plan) {
    const { doc, data, template } = ctx;
    const labelW = 124;
    const x0 = ctx.x0, W = ctx.width;
    const cx = x0 + labelW + 6;
    const cw = W - labelW - 12;

    function block(label, drawContent) {
      ctx.ensure(40);
      let segTop = ctx.y;
      let firstSeg = true;
      const close = (isEnd) => {
        const bottom = isEnd ? ctx.y + 4 : PT.contentBottom;
        doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.6);
        doc.rect(x0, segTop, W, bottom - segTop);
        doc.line(x0 + labelW, segTop, x0 + labelW, bottom);
        if (firstSeg) {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0, 0, 0);
          doc.splitTextToSize(label, labelW - 10).forEach((ln, i) => doc.text(ln, x0 + 5, segTop + 12 + i * 11));
        }
        firstSeg = false;
      };
      const onBreak = () => close(false);
      const onStart = () => { segTop = ctx.y; ctx.y += 4; };
      ctx.pageBreakHooks.push(onBreak);
      ctx.pageStartHooks.push(onStart);
      ctx.y += 4;
      drawContent();
      ctx.pageBreakHooks.splice(ctx.pageBreakHooks.indexOf(onBreak), 1);
      ctx.pageStartHooks.splice(ctx.pageStartHooks.indexOf(onStart), 1);
      close(true);
      ctx.y += 4;
    }

    function lines(items) {
      wrapItems(doc, items, cw, { raw: true }).forEach((ln) => {
        if (ctx.y + PT.lh > PT.contentBottom - 2) ctx.newPage();
        if (!ln.gap) {
          doc.setFont('helvetica', ln.bold ? 'bold' : 'normal'); doc.setFontSize(PT.fs); doc.setTextColor(0, 0, 0);
          if (ln.prefix) doc.text(ln.prefix, cx, ctx.y + 8.5);
          doc.text(ln.text, cx + (ln.dx || 0), ctx.y + 8.5);
        }
        ctx.y += PT.lh;
      });
    }

    function innerTable(headers, rows, widthsPt) {
      const body = [{ cells: headers.map((h) => ({ items: [P(h, { bold: true })], raw: true })) }]
        .concat(rows.map((r) => ({ cells: r.map((v) => ({ items: [P(String(v), { bold: !!r.bold })], raw: true })) })));
      ctx.y += 2;
      drawTable(ctx, widthsPt, body.map((row) => ({ cells: row.cells })), { x: cx, fs: 8.5, lh: 10.5, pad: 3 });
      ctx.y += 4;
    }

    for (let i = 0; i < plan.bottom.length; i++) {
      const s = plan.bottom[i];
      if (s.type === 'referenceList') {
        block(bottomLabel(s), () => {
          const groups = referenceGroupsOf(s, data);
          if (!groups.length) lines([P('No references listed yet.')]);
          groups.forEach((g, gi) => {
            if (gi) ctx.y += 4;
            if (g.label) lines([P(`${g.label}:`, { bold: true })]);
            lines(g.items.map((r, k) => ({ text: r, kind: 'number', n: k + 1 })));
          });
        });
      } else if (s.type === 'gradingBreakdown') {
        const withAttendance = plan.bottom[i + 1] && plan.bottom[i + 1].type === 'staticAttendanceTable';
        block('GRADING SYSTEM', () => {
          lines([P(gradingIntro(data))]);
          const comps = get(data, 'grading.components', []);
          if (!comps.length) lines([P('No grading breakdown entered yet.')]);
          comps.forEach((comp) => {
            const sum = (comp.items || []).reduce((a, it) => a + (Number(it.pct) || 0), 0);
            ctx.y += 3;
            lines([P(`${comp.name} (${comp.weightPct}%)${comp.weightNote ? ' – ' + comp.weightNote : ''}`, { bold: true })]);
            const rows = (comp.items || []).map((it) => [it.item, it.source, `${it.pct}%`]);
            const total = ['Total', '', `${sum}%`]; total.bold = true;
            rows.push(total);
            innerTable(['Assessment item', 'Grade Source', 'Percentage'], rows, [170, 290, 90]);
          });
          if (withAttendance) {
            const rule = get(data, 'orgProfile.attendanceRule', {});
            ctx.y += 2;
            lines([P(rule.note || '')]);
            innerTable(rule.columns || [], rule.rows || [], [150, 180]);
          }
        });
        if (withAttendance) i++;
      } else if (s.type === 'staticAttendanceTable') {
        block('ATTENDANCE', () => {
          const rule = get(data, 'orgProfile.attendanceRule', {});
          lines([P(rule.note || '')]);
          innerTable(rule.columns || [], rule.rows || [], [150, 180]);
        });
      } else if (s.type === 'list') {
        if (!(data[s.source] || []).length) continue;
        block(bottomLabel(s), () => {
          const items = data[s.source] || [];
          lines(items.length ? items.map((v) => P(v)) : [P('None listed yet.')]);
        });
      } else if (s.type === 'classPolicies') {
        block('CLASS POLICIES', () => {
          const cp = get(data, 'orgProfile.classPolicies', {});
          const items = [
            P(cp.attendanceHeading || 'Class Attendance', { bold: true }), P(cp.attendanceText || ''), { kind: 'gap' },
            P(cp.academicDishonestyHeading || 'Academic Dishonesty', { bold: true }), P(cp.academicDishonestyIntro || '')
          ];
          (cp.academicDishonestyItems || []).forEach((v, k) => items.push({ text: v, kind: 'number', n: String.fromCharCode(97 + k) }));
          items.push({ kind: 'gap' }, P(cp.submissionHeading || 'Submission of Course Requirements', { bold: true }), P(cp.submissionText || ''));
          if (data.classPoliciesOverride) items.push({ kind: 'gap' }, P('Additional Notes', { bold: true }), P(data.classPoliciesOverride));
          lines(items);
        });
      } else if (s.type === 'richtext') {
        block(bottomLabel(s), () => {
          lines([P((s.source && data[s.source]) || data.effectivityText || template.effectivityText || '')]);
        });
      }
    }
  }

  function pdfSignatures(ctx, section) {
    const { doc, data } = ctx;
    const cols = signatoryColumns(data, section);
    const maxPeople = Math.max(...cols.map((c) => c.people.length));
    const perPerson = 62;
    ctx.ensure(40 + Math.min(maxPeople, 5) * perPerson);
    ctx.y += 16;
    const colW = ctx.width / cols.length;
    const startY = ctx.y;
    let maxY = startY;
    cols.forEach((c, ci) => {
      const x = ctx.x0 + ci * colW;
      let y = startY;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(0, 0, 0);
      doc.text(c.label, x + 4, y);
      y += 32;
      c.people.forEach((p) => {
        if (y + 32 > PT.contentBottom) return;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
        const nameLines = doc.splitTextToSize(String(p.name || '').toUpperCase(), colW - 16).slice(0, 2);
        nameLines.forEach((ln, li) => doc.text(ln, x + 4, y - 3 - (nameLines.length - 1 - li) * 9));
        doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.6);
        doc.line(x + 4, y + 1, x + colW - 16, y + 1);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
        doc.text('Signature Over Printed Name', x + 4, y + 10);
        if (p.title) doc.text(doc.splitTextToSize(p.title, colW - 16)[0], x + 4, y + 20);
        doc.text(`Date: ${p.date || ''}`, x + 4, y + 30);
        y += perPerson;
      });
      maxY = Math.max(maxY, y);
    });
    ctx.y = maxY;
  }

  // ---------- reviewer feedback in the PDF ----------
  // Records where each part of the document was drawn (page + y), so the
  // parts with open feedback get a yellow bar in the left margin with the
  // note numbers, and the notes themselves are listed on a final
  // "Reviewer Feedback" page.
  function pdfRegions(ctx) {
    const regions = [];
    return {
      regions,
      run(parts, safe, name, fn) {
        const doc = ctx.doc;
        const sp = doc.internal.getCurrentPageInfo().pageNumber;
        const sy = ctx.y;
        safe(name, fn);
        regions.push({ parts, sp, sy, ep: doc.internal.getCurrentPageInfo().pageNumber, ey: ctx.y });
      }
    };
  }

  function pdfMarkFeedback(ctx, regions) {
    const doc = ctx.doc;
    const open = openFeedback(ctx.data);
    if (!open.length) return;
    const last = doc.getNumberOfPages();
    regions.forEach((r) => {
      const list = open.filter((f) => r.parts.includes(f.part));
      if (!list.length) return;
      // The part may start at the very bottom of a page and continue on the
      // next one; skip slivers so the mark sits next to the actual content.
      const segs = [];
      for (let pg = r.sp; pg <= r.ep; pg++) {
        const y1 = pg === r.sp ? r.sy : PT.contentTop;
        const y2 = pg === r.ep ? r.ey : PT.contentBottom;
        if (y2 - y1 >= 24) segs.push({ pg, y1, y2 });
      }
      segs.forEach((s) => {
        doc.setPage(s.pg);
        doc.setFillColor(255, 214, 0);
        doc.rect(PT.marginX - 13, s.y1, 6, s.y2 - s.y1, 'F');
      });
      if (!segs.length) return;
      doc.setPage(segs[0].pg);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(180, 0, 0);
      doc.text(`FEEDBACK #${list.map((f) => f.n).join(', #')}`, PT.marginX - 22, segs[0].y1 + 2, { angle: -90 });
      doc.setTextColor(0, 0, 0);
    });
    doc.setPage(last);
  }

  function pdfFeedbackPage(ctx) {
    const open = openFeedback(ctx.data);
    if (!open.length) return;
    const doc = ctx.doc;
    ctx.newPage();
    const W = ctx.width, X = ctx.x0;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0, 0, 0);
    doc.text('REVIEWER FEEDBACK', X + W / 2, ctx.y + 8, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(`${ctx.data.courseCode || ''} – ${ctx.data.courseTitle || ''} · notes to be addressed before approval (the parts are marked with a yellow bar in the margin)`, X + W / 2, ctx.y + 20, { align: 'center' });
    ctx.y += 30;
    const YEL = [255, 236, 140];
    const rows = [{ cells: ['#', 'Part of the OBTLP', 'Feedback', 'From'].map((h) => ({ items: [P(h, { bold: true })], raw: true, fill: YEL })) }]
      .concat(open.map((f) => ({ cells: [
        { items: [P(String(f.n), { bold: true, align: 'center' })], raw: true, fill: YEL },
        { items: [P(FEEDBACK_LABEL[f.part] || 'General')], raw: true },
        { items: [P(f.text)], raw: true },
        { items: [P(`${FEEDBACK_ROLE[f.role] || 'Reviewer'}${f.byName ? ` – ${f.byName}` : ''}`), P(f.at ? new Date(f.at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '')], raw: true }
      ] })));
    drawTable(ctx, [W * 0.05, W * 0.19, W * 0.54, W * 0.22], rows, { fs: 8.5, lh: 10.6, pad: 4 });
  }

  function buildOfficialPdf(jsPDFCtor, data, logoDataUrl) {
    const template = data.template;
    if (template && template.layout === 'course-outline') return buildCourseOutlinePdf(jsPDFCtor, data, logoDataUrl);
    const doc = new jsPDFCtor({ unit: 'pt', format: 'a4', orientation: 'landscape' });
    const ctx = makeCtx(doc, data, logoDataUrl, template);
    drawFrame(ctx);
    const plan = planDocument(template);
    const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[OBTLP PDF] ${name} failed`, e); } };

    const reg = pdfRegions(ctx);
    if (plan.org) { safe('org', () => pdfTitleAndOrg(ctx)); ctx.newPage(); }
    if (plan.outcomes) reg.run(['outcomes', 'soMap'], safe, 'outcomes', () => pdfOutcomes(ctx, plan));
    if (plan.courseInfo) { ctx.y += 4; reg.run(['courseInfo'], safe, 'courseInfo', () => pdfCourseInfo(ctx)); }
    if (plan.plan) { ctx.y += 12; reg.run(['plan'], safe, 'plan', () => pdfPlan(ctx, plan.plan)); }
    if (plan.bottom.length) { ctx.y += 8; reg.run(['references', 'grading', 'policies'], safe, 'bottom', () => pdfBottom(ctx, plan)); }
    if (plan.signature) safe('signatures', () => pdfSignatures(ctx, plan.signature));
    safe('feedback', () => { pdfMarkFeedback(ctx, reg.regions); pdfFeedbackPage(ctx); });

    const n = doc.internal.getNumberOfPages();
    const formCode = template.formCode || 'PNC:AA-FO-06 rev.2 08182023';
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(0, 0, 0);
      doc.text(`${formCode} / Page${i}`, PT.pageW - PT.marginX, 22, { align: 'right' });
    }
    return doc;
  }

  // =====================================================================
  // COED COURSE OUTLINE (PNC:AA-FO-44) — PORTRAIT, long bond 8.5" x 13"
  // Used when template.layout === 'course-outline'. Same data model as the
  // OBTLP; laid out the way the College of Education's official form is:
  // PnC seal + text + COED seal letterhead, gray section bars, and a
  // signature strip with "Page x of y" at the bottom of every page.
  // =====================================================================
  function coMeta(data) { return data.officialMeta || {}; }
  function coCodeTitle(data) { return `${data.courseCode || ''}: ${data.courseTitle || ''}`; }
  function coUnits(data) {
    const u = String(creditUnits(data) || '').trim();
    if (!u) return data.courseCode || '';
    return /unit/i.test(u) ? `${data.courseCode} (${u})` : `${data.courseCode} (${u} unit${u === '1' ? '' : 's'})`;
  }
  function coFaculty(data) {
    return [String(data.faculty || '').toUpperCase(), data.facultyEmail || ''].filter(Boolean).join('/');
  }
  function coSemester(data) {
    const m = String(data.semester || '').match(/^(\d+(?:st|nd|rd|th))/i);
    return m ? m[1] : (data.semester || '');
  }
  function coTopicItems(items) {
    return (items || []).map((s) => String(s == null ? '' : s)).filter((s) => s.trim()).map((s) => (
      /^•\s/.test(s) ? { text: s.replace(/^•\s+/, ''), kind: 'bullet' } : { text: s, kind: 'plain', bold: true }
    ));
  }
  // Footer strip: Course Title | Prepared by | Reviewed by | Recommending | Approved by
  function coSignatories(data, template) {
    const section = ((template && template.sections) || []).find((s) => s.type === 'signatureBlock');
    const cols = signatoryColumns(data, section);
    const defaults = get(data, 'officialMeta.signatories', {}) || {};
    const roles = (section && section.roles) || [];
    return cols.map((c, i) => {
      const key = roles[i] && roles[i].key;
      const fallbackTitle = key && Array.isArray(defaults[key]) && defaults[key][0] ? defaults[key][0].title : '';
      return { label: c.label, people: c.people.map((p) => ({ name: key === 'preparedBy' ? String(p.name || '').toUpperCase() : p.name, title: p.title && p.title !== 'Faculty' ? p.title : (key === 'preparedBy' ? '' : fallbackTitle) })) };
    });
  }
  function coPolicies(data) {
    const cp = get(data, 'orgProfile.classPolicies', {}) || {};
    return {
      attendanceHeading: cp.attendanceHeading || 'Class Attendance',
      attendanceText: cp.attendanceText || 'As per CHED policy on attendance, a student who misses a maximum of 20% of the total contact hours will be given a grade of failure due to absences.',
      dishonestyIntro: 'Academic Dishonesty – is a deliberate attempt to misrepresent, fabricate or otherwise tamper with data, information, records, or any other material that is relevant to the student\'s participation in any course, laboratory, or other academic exercise or function. These may include but may not be limited to:',
      dishonestyItems: cp.academicDishonestyItems && cp.academicDishonestyItems.length ? cp.academicDishonestyItems : [
        'Falsification, forgery, alteration, unauthorized possession, or misuse of school official documents, records, or identification, or knowingly furnishing false information to the university or to a university official.',
        'Unauthorized accessing of electronic information of the university and securing, soliciting, and holding a copy of an examination or a portion thereof, that is yet to be administered',
        'Plagiarism or copyright infringement'
      ],
      submissionHeading: cp.submissionHeading || 'Submission of Course Requirements',
      submissionText: cp.submissionText || 'Course requirements must be submitted on-time.',
      office: coMeta(data).consultationOffice || 'College of Education'
    };
  }
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

  // ---------- HTML ----------
  function coHtmlLetterhead(data, template) {
    const lh = letterheadLines(data);
    const second = template.secondaryLogo || '';
    return `
      <div class="co-formcode">${escapeHtml(template.formCode || '')}</div>
      <div class="co-letterhead">
        <img class="co-seal" src="assets/pnc-logo.png" alt="PnC seal" />
        <div class="co-lh-text">
          <div class="co-lh-1">${escapeHtml(lh.line1)}</div>
          <div class="co-lh-2">${escapeHtml(lh.line2)}</div>
          <div class="co-lh-3">${escapeHtml(get(data, 'orgProfile.letterhead.line3', '') || '(University of Cabuyao)')}</div>
          <div class="co-lh-4">${escapeHtml(coMeta(data).division || lh.line4)}</div>
          <div class="co-lh-5">${escapeHtml(lh.address)}</div>
        </div>
        ${second ? `<img class="co-seal" src="${escapeHtml(second)}" alt="College seal" />` : '<span class="co-seal"></span>'}
      </div>`;
  }
  function coHtmlFooter(data, template, pageNo, pages) {
    const sigs = coSignatories(data, template);
    return `
      <div class="co-footer">
        <table class="co-sigstrip"><tr>
          <td><div class="co-sig-label">Course Title</div><div class="co-sig-name">${escapeHtml(String(data.courseTitle || '').toUpperCase())}</div></td>
          ${sigs.map((c) => `<td><div class="co-sig-label">${escapeHtml(c.label)}</div>${c.people.map((p) => `<div class="co-sig-name">${escapeHtml(p.name || '')}</div>${p.title ? `<div class="co-sig-title">${escapeHtml(p.title)}</div>` : ''}`).join('')}</td>`).join('')}
          <td class="co-sig-page">Page <b>${pageNo}</b> of <b>${pages}</b></td>
        </tr></table>
        <div class="oo-dangal">Dangal ng Bayan.</div><div class="oo-dangal-sub">bringing pride and honor to the nation.</div>
      </div>`;
  }
  function coHtmlList(items, kind) {
    if (kind === 'alpha') return `<ol type="a">${items.map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ol>`;
    if (kind === 'num') return `<ol>${items.map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ol>`;
    return `<ul>${items.map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ul>`;
  }
  function renderCourseOutlineHtml(template, data) {
    const meta = coMeta(data);
    const org = data.orgProfile || {};
    const pages = [];

    // Page 1 — header table, PEO / core values, student outcomes, code & units
    pages.push(`
      <div class="co-bar co-bar-center">${escapeHtml(template.docTitle || 'COURSE OUTLINE')}</div>
      <table class="co-table">
        <colgroup><col style="width:30%"><col style="width:22%"><col></colgroup>
        <tr><th>Document</th><th>Course Code / Title</th><td>${escapeHtml(coCodeTitle(data))}</td></tr>
        <tr><td>Course Description</td><td colspan="2" class="co-justify">${escapeHtml(data.description || '')}</td></tr>
        <tr><td>Effectivity Date:<br>${escapeHtml(coSemester(data))} Sem, S.Y. ${escapeHtml(data.academicYear || '')}${meta.effectivityDate ? `<br>${escapeHtml(meta.effectivityDate)}` : ''}</td>
            <td colspan="2">Supersedes dated:<br>${escapeHtml(meta.supersedes || '')}</td></tr>
      </table>
      <table class="co-table co-org">
        <colgroup><col style="width:52%"><col></colgroup>
        <tr>
          <td><p class="co-italic">${escapeHtml(peoIntro(data))}</p>${coHtmlList(peoList(data), 'alpha')}</td>
          <td><div class="co-minibar">CORE VALUES</div><p>${escapeHtml(org.coreValuesIntro || '')}</p>${coHtmlList(org.coreValues || [], 'bullet')}
              <div class="co-minibar">PnC Graduate Attributes</div>${coHtmlList(org.graduateAttributes || [], 'num')}</td>
        </tr>
      </table>
      <div class="co-bar">Student Outcomes for [PROGRAM]</div>
      <p class="co-italic">By the time of graduation, <span class="co-fill">${escapeHtml(meta.soProgramLabel || get(data, 'program.name', ''))}</span> students will be able to:</p>
      ${coHtmlList(meta.programOutcomes || [], 'alpha')}
      <p class="co-inline"><span class="co-label">COURSE CODE &amp; UNITS:</span> <span class="co-underline">${escapeHtml(coUnits(data))}</span></p>`);

    // Page 2 — course info, CILO, SO map
    const sos = soRows(data);
    const soCols = ['I/L', 'E/P', 'D/O'];
    pages.push(fbWrap(data, ['courseInfo'], `
      <table class="co-info">
        <colgroup><col style="width:24%"><col></colgroup>
        <tr><td class="co-label">COURSE TITLE:</td><td class="co-underline">${escapeHtml(data.courseTitle || '')}</td></tr>
        <tr><td class="co-label">COURSE DESCRIPTION:</td><td class="co-justify">${meta.descriptionLead ? `<span class="co-lead">${escapeHtml(meta.descriptionLead)}</span> ` : ''}${escapeHtml(data.description || '')}</td></tr>
        <tr><td class="co-label">SCHEDULE:</td><td class="co-underline">${escapeHtml(data.schedule || '') || '&nbsp;'}<div class="co-caption">(CLASS SCHEDULES)</div></td></tr>
        <tr><td class="co-label">FACULTY:</td><td class="co-underline">${escapeHtml(coFaculty(data)) || '&nbsp;'}<div class="co-caption">NAME OF FACULTY / EMAIL</div></td></tr>
      </table>`) + fbWrap(data, ['outcomes'], `
      <div class="co-bar">COURSE INTENDED LEARNING OUTCOMES (CILO):</div>
      <table class="co-table">
        <colgroup><col style="width:16%"><col></colgroup>
        <tr><td colspan="2" class="oo-center">On the completion of the course, student is expected to be able to do the following:</td></tr>
        ${(data.outcomes || []).map((v, i) => `<tr><td class="oo-center">CO${i + 1}</td><td>${escapeHtml(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="t-muted">No CILO on file yet.</td></tr>'}
      </table>`) + fbWrap(data, ['soMap'], `
      <table class="co-table co-somap">
        <colgroup><col style="width:19%"><col style="width:9%"><col><col style="width:7%"><col style="width:7%"><col style="width:7%"></colgroup>
        <tr><th class="co-gray" rowspan="${Math.max(1, sos.length) + 1}">Student Outcomes Map Addressed by the Course</th><td colspan="2"></td>${soCols.map((c) => `<th class="oo-center">${c}</th>`).join('')}</tr>
        ${sos.length ? sos.map((so, i) => `<tr><td>${escapeHtml(String(so.code || '').replace(/^SO\s*/i, 'SO #. '))}</td><td>${(data.soMap[i] && data.soMap[i].group) ? `<div class="co-italic">${escapeHtml(data.soMap[i].group)}</div>` : ''}${escapeHtml(so.description)}</td>${soCols.map((c) => `<td class="oo-center oo-middle">${so.intensity.includes(c) ? '/' : ''}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="5" class="t-muted">No student outcomes mapped yet.</td></tr>`}
      </table>
      <p class="co-legend">Legend: &nbsp;I/L – Introductory/Learning &nbsp; E/P – Enabling/Practice &nbsp; D/O – Demonstrating/Opportunity</p>`));

    // Page 3 — course outline and time-frame
    const weeks = (data.teachingPlan || []).map((r) => {
      if (r.type === 'milestone') return `<tr><td></td><td><b>${escapeHtml(r.label)}</b></td></tr>`;
      const items = coTopicItems(r.topics);
      let html = ''; let inList = false;
      items.forEach((it) => {
        if (it.kind === 'bullet') { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${escapeHtml(it.text)}</li>`; }
        else { if (inList) { html += '</ul>'; inList = false; } html += `<p><b>${escapeHtml(it.text)}</b></p>`; }
      });
      if (inList) html += '</ul>';
      return `<tr><td>${escapeHtml(r.week)}</td><td>${html}</td></tr>`;
    }).join('');
    pages.push(fbWrap(data, ['plan'], `
      <div class="co-bar">COURSE OUTLINE AND TIME-FRAME</div>
      <table class="co-table co-weeks">
        <colgroup><col style="width:14%"><col></colgroup>
        <thead><tr><th class="co-dark oo-center">WEEK</th><th class="co-dark oo-center">TOPIC</th></tr></thead>
        <tbody>${weeks || '<tr><td colspan="2" class="t-muted">No topics entered yet.</td></tr>'}</tbody>
      </table>`));

    // Page 4 — references, requirements, grading, policies
    const rg = data.referenceGroups || {};
    const textbooks = rg.textbooks || [];
    const suggested = (rg.suggested || []).concat(rg.onlineResources || [], rg.journals || []);
    const comps = get(data, 'grading.components', []);
    const gradingRows = comps.length === 1
      ? (comps[0].items || [])
      : comps.map((c) => ({ item: c.name, source: (c.items || []).map((it) => `${it.item} – ${it.pct}%`).join('\n'), pct: c.weightPct }));
    const pol = coPolicies(data);
    pages.push(fbWrap(data, ['references'], `
      <div class="co-bar">TEXTBOOK:</div>
      ${textbooks.map((t) => `<p class="co-ref">${escapeHtml(t)}</p>`).join('') || '<p class="t-muted">None listed.</p>'}
      <div class="co-bar">SUGGESTED READINGS AND REFERENCES:</div>
      ${suggested.map((t) => `<p class="co-ref">${escapeHtml(t)}</p>`).join('') || '<p class="t-muted">None listed.</p>'}`) + fbWrap(data, ['grading'], `
      <div class="co-bar">COURSE REQUIREMENTS:</div>
      ${(data.courseRequirements || []).map((t) => `<p class="co-tight">${escapeHtml(t)}</p>`).join('') || '<p class="t-muted">None listed.</p>'}
      <div class="co-bar">GRADING SYSTEM:</div>
      <p>${escapeHtml(gradingIntro(data))}</p>
      <table class="co-table co-grading">
        <colgroup><col style="width:30%"><col style="width:35%"><col></colgroup>
        <tr><td class="oo-center">Assessment Item</td><td class="oo-center">Grade Source</td><td class="oo-center">Percentage</td></tr>
        ${gradingRows.map((it) => `<tr><td>${escapeHtml(it.item)}</td><td>${String(it.source || '').split('\n').map(escapeHtml).join('<br>')}</td><td class="oo-center">${escapeHtml(it.pct)}%</td></tr>`).join('')}
      </table>
      ${(meta.gradingNotes || []).map((t) => `<p class="co-tight">${escapeHtml(t)}</p>`).join('')}`) + fbWrap(data, ['policies'], `
      <div class="co-bar">COURSE POLICIES:</div>
      <p class="co-tight">${escapeHtml(pol.attendanceHeading)}</p><p class="co-indent">${escapeHtml(pol.attendanceText)}</p>
      <p>${escapeHtml(pol.dishonestyIntro)}</p>${coHtmlList(pol.dishonestyItems, 'alpha')}
      <p class="co-tight">${escapeHtml(pol.submissionHeading)}</p><p class="co-indent">${escapeHtml(pol.submissionText)}</p>
      ${data.classPoliciesOverride ? `<p class="co-tight">Additional Notes</p><p class="co-indent">${escapeHtml(data.classPoliciesOverride)}</p>` : ''}
      <p class="co-tight">Faculty Consultation Hours</p>
      <p class="co-indent">The Faculty Consultation/Advising hours schedule is available at the <span class="co-fill">${escapeHtml(pol.office)}</span> office, and at the <span class="co-fill">${escapeHtml(pol.office)}</span> bulletin board.</p>`));

    if (pages.length) pages[0] = fbGeneral(data) + pages[0];
    return `<div class="obtlp-official co-doc">${pages.map((content, idx) => `
      <section class="oo-page co-page">
        ${coHtmlLetterhead(data, template)}
        <div class="oo-content">${content}</div>
        ${coHtmlFooter(data, template, idx + 1, pages.length)}
      </section>`).join('')}</div>`;
  }

  // ---------- PDF ----------
  const CO_PT = { pageW: 612, pageH: 936, marginX: 36, contentTop: 112, contentBottom: 822, fs: 8.5, lh: 10.8, pad: 4 };
  const GRAY = [217, 217, 217];

  function coDrawFrame(ctx) {
    const { doc, data, template } = ctx;
    const lh = letterheadLines(data);
    const cx = CO_PT.pageW / 2 + 6;
    if (ctx.logoDataUrl) { try { doc.addImage(ctx.logoDataUrl, 'PNG', 64, 34, 58, 58); } catch (e) { /* seal is optional */ } }
    if (ctx.secondLogoDataUrl) { try { doc.addImage(ctx.secondLogoDataUrl, 'PNG', 492, 34, 58, 58); } catch (e) { /* seal is optional */ } }
    doc.setTextColor(0, 0, 0);
    doc.setFont('times', 'normal'); doc.setFontSize(9.5);
    doc.text(lh.line1, cx, 44, { align: 'center' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(0, 77, 0);
    doc.text(lh.line2, cx, 61, { align: 'center' });
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    doc.text(get(data, 'orgProfile.letterhead.line3', '') || '(University of Cabuyao)', cx, 74, { align: 'center' });
    doc.setFont('helvetica', 'bolditalic'); doc.setFontSize(10.5);
    doc.text(coMeta(data).division || lh.line4, cx, 86, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8);
    doc.text(lh.address, cx, 96, { align: 'center' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
    doc.text(template.formCode || '', CO_PT.pageW - CO_PT.marginX, 22, { align: 'right' });
  }

  function coDrawFooters(doc, data, template) {
    const n = doc.internal.getNumberOfPages();
    const sigs = coSignatories(data, template);
    const x0 = 42, W = CO_PT.pageW - 84;
    const widths = [78, 82, 86, 96, 92];
    widths.push(W - widths.reduce((a, b) => a + b, 0));
    const top = 838, h = 58;
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.6); doc.setTextColor(0, 0, 0);
      let x = x0;
      const cells = [{ label: 'Course Title', lines: [String(data.courseTitle || '').toUpperCase()] }]
        .concat(sigs.map((c) => ({ label: c.label, lines: c.people.reduce((a, p) => a.concat([p.name || ''], p.title ? [p.title] : []), []) })))
        .concat([{ page: true }]);
      cells.forEach((c, ci) => {
        const w = widths[ci];
        doc.rect(x, top, w, h);
        doc.setFontSize(6.6);
        if (c.page) {
          doc.setFont('helvetica', 'normal');
          doc.text(`Page ${i}`, x + w / 2, top + h / 2 - 2, { align: 'center' });
          doc.text(`of ${n}`, x + w / 2, top + h / 2 + 7, { align: 'center' });
        } else {
          doc.setFont('helvetica', 'normal');
          doc.splitTextToSize(c.label, w - 6).slice(0, 2).forEach((ln, li) => doc.text(ln, x + w / 2, top + 9 + li * 8, { align: 'center' }));
          let y = top + 27;
          c.lines.forEach((t) => {
            doc.splitTextToSize(String(t), w - 6).forEach((ln) => { if (y < top + h - 2) { doc.text(ln, x + w / 2, y, { align: 'center' }); y += 7.6; } });
          });
        }
        x += w;
      });
      doc.setFont('times', 'italic'); doc.setFontSize(12);
      doc.text('Dangal ng Bayan.', CO_PT.pageW / 2, 912, { align: 'center' });
      doc.setFont('helvetica', 'italic'); doc.setFontSize(5.5);
      doc.text('bringing pride and honor to the nation.', CO_PT.pageW / 2 + 8, 919, { align: 'center' });
    }
  }

  function buildCourseOutlinePdf(jsPDFCtor, data, logoDataUrl) {
    const template = data.template;
    const doc = new jsPDFCtor({ unit: 'pt', format: [CO_PT.pageW, CO_PT.pageH], orientation: 'portrait' });
    // drawTable()/wrapItems() read the page limits from PT; switch them to
    // the portrait long-bond values for this document, then restore.
    const saved = Object.assign({}, PT);
    Object.assign(PT, CO_PT);
    try {
      const ctx = {
        doc, data, template, logoDataUrl,
        secondLogoDataUrl: data.secondaryLogoDataUrl || null,
        x0: CO_PT.marginX, width: CO_PT.pageW - CO_PT.marginX * 2, y: CO_PT.contentTop,
        pageBreakHooks: [], pageStartHooks: []
      };
      ctx.newPage = function () {
        doc.addPage([CO_PT.pageW, CO_PT.pageH], 'portrait');
        coDrawFrame(ctx);
        ctx.y = CO_PT.contentTop;
      };
      ctx.ensure = function (h) { if (ctx.y + h > CO_PT.contentBottom) ctx.newPage(); };
      coDrawFrame(ctx);
      const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`[Course Outline PDF] ${name} failed`, e); } };
      const meta = coMeta(data);
      const org = data.orgProfile || {};
      const W = ctx.width, X = ctx.x0;

      function bar(text, center) {
        ctx.ensure(30);
        ctx.y += 6;
        doc.setFillColor(GRAY[0], GRAY[1], GRAY[2]);
        doc.rect(center ? X : X, ctx.y, center ? W : Math.min(W, Math.max(150, doc.getTextWidth(text) + 40)), 12, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(center ? 10 : 8.5); doc.setTextColor(0, 0, 0);
        if (center) doc.text(text, X + W / 2, ctx.y + 9, { align: 'center' });
        else doc.text(text, X + 4, ctx.y + 9);
        ctx.y += 17;
      }
      function flow(items, opts) {
        opts = opts || {};
        const x = X + (opts.indent || 0), w = W - (opts.indent || 0);
        wrapItems(doc, items, w, { raw: true, fs: opts.fs || 8.5 }).forEach((ln) => {
          if (ctx.y + CO_PT.lh > CO_PT.contentBottom) ctx.newPage();
          if (!ln.gap) {
            doc.setFont('helvetica', ln.bold ? 'bold' : (opts.italic ? 'italic' : 'normal')); doc.setFontSize(opts.fs || 8.5); doc.setTextColor(0, 0, 0);
            if (ln.prefix) doc.text(ln.prefix, x, ctx.y + 8);
            doc.text(ln.text, x + (ln.dx || 0), ctx.y + 8);
          }
          ctx.y += CO_PT.lh;
        });
      }
      const T = (t, extra) => P(t, extra);
      const alpha = (arr) => arr.map((v, i) => ({ text: v, kind: 'number', n: LETTERS[i] || '-' }));

      // Header table
      safe('header', () => {
        bar(template.docTitle || 'COURSE OUTLINE', true);
        drawTable(ctx, [W * 0.3, W * 0.22, W * 0.48], [
          { cells: [{ items: [T('Document', { bold: true })], raw: true }, { items: [T('Course Code / Title', { bold: true })], raw: true }, { items: [T(coCodeTitle(data))], raw: true }] },
          { cells: [{ items: [T('Course Description')], raw: true }, { items: [T(data.description || '')], raw: true, span: 2 }] },
          { cells: [
            { items: [T('Effectivity Date:'), T(`${coSemester(data)} Sem, S.Y. ${data.academicYear || ''}`)].concat(meta.effectivityDate ? [T(meta.effectivityDate)] : []), raw: true },
            { items: [T('Supersedes dated:'), T(meta.supersedes || '')], raw: true, span: 2 }
          ] }
        ], { fs: 8.5, lh: 10.6, pad: 4 });
        ctx.y += 8;
        const right = [T('CORE VALUES', { bold: true }), T(org.coreValuesIntro || '')]
          .concat((org.coreValues || []).map((v) => ({ text: v, kind: 'bullet' })), [{ kind: 'gap' }, T('PnC Graduate Attributes', { bold: true })],
            (org.graduateAttributes || []).map((v, i) => ({ text: v, kind: 'number', n: i + 1 })));
        drawTable(ctx, [W * 0.52, W * 0.48], [
          { cells: [{ items: [T(peoIntro(data), { bold: false })].concat(alpha(peoList(data))), raw: true }, { items: right, raw: true }] }
        ], { fs: 8.5, lh: 10.6, pad: 6 });
        ctx.y += 6;
        bar('Student Outcomes for [PROGRAM]');
        flow([T(`By the time of graduation, ${meta.soProgramLabel || get(data, 'program.name', '')} students will be able to:`)], { italic: true });
        flow(alpha(meta.programOutcomes || []), { indent: 18 });
        ctx.y += 8;
        ctx.ensure(16);
        doc.setFillColor(GRAY[0], GRAY[1], GRAY[2]); doc.rect(X, ctx.y, 100, 12, 'F');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 0, 0);
        doc.text('COURSE CODE & UNITS:', X + 3, ctx.y + 9);
        doc.text(coUnits(data), X + 106, ctx.y + 9);
        doc.setLineWidth(0.6); doc.line(X + 104, ctx.y + 11, X + W, ctx.y + 11);
        ctx.y += 20;
      });

      const reg = pdfRegions(ctx);
      // Course info / CILO / SO map
      reg.run(['courseInfo', 'outcomes', 'soMap'], safe, 'courseInfo', () => {
        const label = (t) => ({ items: [T(t)], raw: true, fill: GRAY });
        const descItems = (meta.descriptionLead ? [T(`${meta.descriptionLead} ${data.description || ''}`)] : [T(data.description || '')]);
        drawTable(ctx, [W * 0.24, W * 0.76], [
          { cells: [label('COURSE TITLE:'), { items: [T(data.courseTitle || '')], raw: true }] },
          { cells: [label('COURSE DESCRIPTION:'), { items: descItems, raw: true }] },
          { cells: [label('SCHEDULE:'), { items: [T(data.schedule || ' '), T('(CLASS SCHEDULES)', { align: 'left' })], raw: true }] },
          { cells: [label('FACULTY:'), { items: [T(coFaculty(data) || ' '), T('NAME OF FACULTY / EMAIL')], raw: true }] }
        ], { fs: 8.5, lh: 10.6, pad: 4 });
        ctx.y += 4;
        bar('COURSE INTENDED LEARNING OUTCOMES (CILO):');
        const rows = [{ cells: [{ items: [T('On the completion of the course, student is expected to be able to do the following:', { align: 'center' })], raw: true, span: 2 }] }];
        (data.outcomes || []).forEach((v, i) => rows.push({ cells: [{ items: [T(`CO${i + 1}`, { align: 'center' })], raw: true }, { items: [T(v)], raw: true }] }));
        drawTable(ctx, [W * 0.16, W * 0.84], rows, { fs: 8.5, lh: 10.6, pad: 4 });
        ctx.y += 8;
        const sos = soRows(data);
        const cols = ['I/L', 'E/P', 'D/O'];
        const widths = [W * 0.19, W * 0.09, W * 0.51, W * 0.07, W * 0.07, W * 0.07];
        const soRowsPdf = [{ cells: [
          { items: [T('Student Outcomes Map Addressed by the Course', { bold: true })], raw: true, fill: GRAY, openBottom: sos.length > 0 },
          { items: [T('')], raw: true, span: 2 }
        ].concat(cols.map((c) => ({ items: [T(c, { bold: true, align: 'center' })], raw: true }))) }];
        sos.forEach((so, i) => {
          const group = data.soMap[i] && data.soMap[i].group;
          soRowsPdf.push({ cells: [
            { lines: [], fill: GRAY, contTop: true, openBottom: i < sos.length - 1 },
            { items: [T(String(so.code || '').replace(/^SO\s*/i, 'SO #. '))], raw: true },
            { items: (group ? [T(group, { bold: true })] : []).concat([T(so.description)]), raw: true }
          ].concat(cols.map((c) => ({ items: [T(so.intensity.includes(c) ? '/' : '', { align: 'center' })], raw: true, valign: 'middle' }))) });
        });
        drawTable(ctx, widths, soRowsPdf, { fs: 8.5, lh: 10.6, pad: 4 });
        flow([T('Legend:  I/L – Introductory/Learning   E/P – Enabling/Practice   D/O – Demonstrating/Opportunity')]);
      });

      // Course outline and time-frame
      reg.run(['plan'], safe, 'weeks', () => {
        ctx.y += 4;
        bar('COURSE OUTLINE AND TIME-FRAME');
        const rows = [{ cells: [
          { items: [T('WEEK', { bold: true, align: 'center' })], raw: true, fill: [166, 166, 166] },
          { items: [T('TOPIC', { bold: true, align: 'center' })], raw: true, fill: [166, 166, 166] }
        ] }];
        (data.teachingPlan || []).forEach((r) => {
          if (r.type === 'milestone') { rows.push({ cells: [{ items: [T('')], raw: true }, { items: [T(r.label, { bold: true })], raw: true }] }); return; }
          rows.push({ cells: [{ items: [T(r.week)], raw: true }, { items: coTopicItems(r.topics), raw: true }] });
        });
        drawTable(ctx, [W * 0.14, W * 0.86], rows, { fs: 8.5, lh: 10.6, pad: 4 });
      });

      // References / requirements / grading / policies
      reg.run(['references', 'grading', 'policies'], safe, 'bottom', () => {
        const rg = data.referenceGroups || {};
        const suggested = (rg.suggested || []).concat(rg.onlineResources || [], rg.journals || []);
        ctx.y += 6;
        bar('TEXTBOOK:');
        flow((rg.textbooks || []).length ? [].concat(...rg.textbooks.map((t) => [T(t), { kind: 'gap' }])) : [T('None listed.')]);
        bar('SUGGESTED READINGS AND REFERENCES:');
        flow(suggested.length ? [].concat(...suggested.map((t) => [T(t), { kind: 'gap' }])) : [T('None listed.')]);
        bar('COURSE REQUIREMENTS:');
        flow((data.courseRequirements || []).length ? data.courseRequirements.map((t) => T(t)) : [T('None listed.')]);
        ctx.y += 4;
        bar('GRADING SYSTEM:');
        flow([T(gradingIntro(data))]);
        ctx.y += 2;
        const comps = get(data, 'grading.components', []);
        const gRows = comps.length === 1
          ? (comps[0].items || [])
          : comps.map((c) => ({ item: c.name, source: (c.items || []).map((it) => `${it.item} – ${it.pct}%`).join('\n'), pct: c.weightPct }));
        drawTable(ctx, [W * 0.3, W * 0.35, W * 0.35], [{ cells: ['Assessment Item', 'Grade Source', 'Percentage'].map((h) => ({ items: [T(h, { align: 'center' })], raw: true })) }]
          .concat(gRows.map((it) => ({ cells: [
            { items: [T(it.item)], raw: true },
            { items: String(it.source || '').split('\n').map((s) => T(s)), raw: true },
            { items: [T(`${it.pct}%`, { align: 'center' })], raw: true }
          ] }))), { fs: 8.5, lh: 10.6, pad: 3 });
        flow((meta.gradingNotes || []).map((t) => T(t)));
        ctx.y += 4;
        const pol = coPolicies(data);
        bar('COURSE POLICIES:');
        flow([T(pol.attendanceHeading)]);
        flow([T(pol.attendanceText)], { indent: 24 });
        ctx.y += 6;
        flow([T(pol.dishonestyIntro)]);
        flow(alpha(pol.dishonestyItems), { indent: 24 });
        ctx.y += 6;
        flow([T(pol.submissionHeading)]);
        flow([T(pol.submissionText)], { indent: 24 });
        if (data.classPoliciesOverride) { ctx.y += 6; flow([T('Additional Notes')]); flow([T(data.classPoliciesOverride)], { indent: 24 }); }
        ctx.y += 6;
        flow([T('Faculty Consultation Hours')]);
        flow([T(`The Faculty Consultation/Advising hours schedule is available at the ${pol.office} office, and at the ${pol.office} bulletin board.`)], { indent: 6 });
      });

      safe('feedback', () => { pdfMarkFeedback(ctx, reg.regions); pdfFeedbackPage(ctx); });
      coDrawFooters(doc, data, template);
      return doc;
    } finally {
      Object.assign(PT, saved);
    }
  }

  // ---------------------------------------------------------------------
  // Switches the preview sheet to the official landscape layout (which
  // carries its own letterhead on every page) when a template applies.
  // ---------------------------------------------------------------------
  function applyOfficialLetterhead(model) {
    const sheet = document.getElementById('pdf-sheet');
    if (sheet) sheet.classList.toggle('pdf-sheet--official', !!model.template);
    const officialEl = document.getElementById('pdf-official-letterhead');
    const formCodeEl = document.getElementById('pdf-form-code');
    if (officialEl) officialEl.style.display = 'none';
    if (formCodeEl) formCodeEl.style.display = 'none';
  }

  // ---------------------------------------------------------------------
  // The official preview pages are a fixed 1100px wide (A4 landscape).
  // When the space on screen is narrower (sidebar + side panel, laptop
  // screens), shrink them to fit instead of letting the edges get cut off.
  // Runs automatically whenever the preview is (re)rendered or resized.
  // ---------------------------------------------------------------------
  const PAGE_W = 1102; // .oo-page width + borders
  function fitOfficialPages() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.obtlp-official').forEach((el) => {
      const host = el.parentElement;
      if (!host) return;
      const avail = host.clientWidth;
      if (!avail) return;
      const page = el.querySelector('.oo-page');
      const scale = Math.min(1, avail / ((page && page.offsetWidth + 2) || PAGE_W));
      el.style.zoom = scale < 0.999 ? String(Math.round(scale * 1000) / 1000) : '';
    });
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fitOfficialPages(); });
    };
    window.addEventListener('resize', schedule);
    const start = () => {
      if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
      }
      schedule();
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }

  const api = { resolveTemplate, renderSectionsHtml, buildOfficialPdf, applyOfficialLetterhead, classifyItems, fitOfficialPages };
  if (typeof window !== 'undefined') window.__OBTLP_TEMPLATE_RENDERER__ = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
