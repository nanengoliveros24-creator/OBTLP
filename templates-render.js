/*
  Phase 1: generic, data-driven OBTLP template renderer.

  This is the piece that makes "automated generation" real instead of a
  hardcoded single layout: given an obtlpTemplates row (a `sections[]`
  list — see seed-ccs101.js for the CCS101 example) and a merged data
  object (course + program + org-profile + portfolio instance fields),
  it produces the same content twice — once as HTML for the on-screen
  preview, once as jsPDF drawing calls for the downloadable PDF — by
  walking `sections[]` and dispatching on each section's generic `type`.

  A future CHED/other-department template is just another `obtlpTemplates`
  row with its own `sections[]`; nothing here is CCS101-specific. Adding a
  template that only uses the section types below requires NO code change
  here. A template needing a genuinely new section type needs one new
  case added to each of the two dispatch tables below.

  This file intentionally does NOT know how to fetch data — callers
  (portfolio-new.html, portfolio-preview.html, app-actions.js) assemble
  the `data` object and hand it in.
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
  // Given the course's own courseTemplate row (which carries a direct
  // obtlpTemplateId FK — see seed-ccs101.js) and the list of known
  // templates, return the applicable ACTIVE template, or null if this
  // course has no template yet (callers should fall back to the legacy
  // hardcoded layout in that case — nothing breaks for untemplated courses).
  function resolveTemplate(courseTemplate, allTemplates) {
    if (!courseTemplate || !courseTemplate.obtlpTemplateId) return null;
    const tpl = (allTemplates || []).find((t) => t.id === courseTemplate.obtlpTemplateId);
    if (!tpl || !tpl.active) return null;
    return tpl;
  }

  // ---------------------------------------------------------------------
  // HTML rendering
  // ---------------------------------------------------------------------

  function htmlList(items, ordered, fallback) {
    const arr = (items || []).filter(Boolean);
    if (!arr.length) return `<p class="t-muted">${escapeHtml(fallback || 'None provided yet.')}</p>`;
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag} class="pdf-list">${arr.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</${tag}>`;
  }

  const HTML_RENDERERS = {
    staticOrgTable(section, data) {
      const org = data.orgProfile || {};
      return `
        <div class="pdf-org-grid">
          <div class="pdf-org-box"><h4>Vision</h4><p>${escapeHtml(org.vision || '')}</p></div>
          <div class="pdf-org-box"><h4>Core Values</h4><p>${escapeHtml(org.coreValuesIntro || '')}</p>${htmlList(org.coreValues, false)}</div>
          <div class="pdf-org-box"><h4>Mission</h4><p>${escapeHtml(org.mission || '')}</p></div>
          <div class="pdf-org-box"><h4>Graduate Attributes</h4>${htmlList(org.graduateAttributes, false)}</div>
        </div>
      `;
    },
    programOutcomes(section, data) {
      const program = data.program || {};
      return `
        <div class="pdf-section"><h3>Program Educational Objectives</h3>
          <p>${escapeHtml(program.peoIntro || '')}</p>
          ${htmlList(program.peo, true, 'No program educational objectives on file yet.')}
        </div>
        <div class="pdf-section"><h3>Course Intended Learning Outcomes (CILO)</h3>
          ${htmlList(data.outcomes, true, 'No CILO added yet.')}
        </div>
      `;
    },
    soMatrix(section, data) {
      const program = data.program || {};
      const cols = section.columns || ['I/L', 'E/P', 'D/O'];
      const rows = (data.soMap || []).map((row) => {
        const so = (program.studentOutcomes || []).find((s) => s.code === row.soCode);
        const desc = row.description || (so ? so.description : '');
        const cells = cols.map((c) => `<td style="text-align:center;">${row.intensity === c ? '&#10003;' : ''}</td>`).join('');
        return `<tr><td>${escapeHtml(row.soCode)}</td><td>${escapeHtml(desc)}</td>${cells}</tr>`;
      }).join('');
      return `
        <div class="pdf-section"><h3>${escapeHtml(section.label || 'Student Outcomes Map')}</h3>
          <table class="pdf-table">
            <thead><tr><th>SO</th><th>Description</th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${2 + cols.length}" class="t-muted">No student outcomes mapped yet.</td></tr>`}</tbody>
          </table>
          ${(data.orgProfile && data.orgProfile.soIntensityLegend) ? `<p class="t-muted" style="font-size:0.75rem;">Legend: ${data.orgProfile.soIntensityLegend.map((l) => `${escapeHtml(l.code)} – ${escapeHtml(l.label)}`).join(' &nbsp; ')}</p>` : ''}
        </div>
      `;
    },
    keyvalueGrid(section, data) {
      const rows = (section.fields || []).map((f) => `<dt>${escapeHtml(f.label)}</dt><dd>${escapeHtml(data[f.key] || '—')}</dd>`).join('');
      return `<div class="pdf-section"><h3>${escapeHtml(section.label || 'Course Information')}</h3><dl class="pdf-dl">${rows}</dl></div>`;
    },
    weeklyPlanTable(section, data) {
      const cols = section.columns || ['Week', 'Topics', 'ILO', 'TLA', 'Instructional Material', 'Assessment Tasks'];
      const rows = (data.teachingPlan || []).map((row) => {
        if (row.type === 'milestone') {
          return `<tr class="pdf-milestone-row"><td colspan="${cols.length}">${escapeHtml(row.label)}</td></tr>`;
        }
        return `<tr>
          <td>${escapeHtml(row.week)}</td>
          <td>${htmlList(row.topics, false)}</td>
          <td>${htmlList(row.ilo, false)}</td>
          <td>${htmlList(row.tla, false)}</td>
          <td>${htmlList(row.instructionalMaterials, false)}</td>
          <td>${htmlList(row.assessmentTasks, false)}</td>
        </tr>`;
      }).join('');
      return `
        <div class="pdf-section"><h3>${escapeHtml(section.label || 'Teaching and Learning Plan')}</h3>
          <table class="pdf-table">
            <thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${cols.length}" class="t-muted">No teaching plan entered yet.</td></tr>`}</tbody>
          </table>
        </div>
      `;
    },
    referenceList(section, data) {
      const groups = section.groups || [{ key: 'textbooks', label: 'Textbooks' }, { key: 'onlineResources', label: 'Online Resources' }];
      const rg = data.referenceGroups || {};
      const hasAny = groups.some((g) => (rg[g.key] || []).length);
      if (!hasAny) {
        // Fall back to the legacy flat `references` list so courses without
        // structured referenceGroups still show something.
        return `<div class="pdf-section"><h3>${escapeHtml(section.label || 'References')}</h3>${htmlList(data.references, false, 'No references listed yet.')}</div>`;
      }
      return `<div class="pdf-section"><h3>${escapeHtml(section.label || 'References')}</h3>${groups.map((g) => `
        <p style="font-weight:600;margin-top:0.5rem;">${escapeHtml(g.label)}</p>${htmlList(rg[g.key], false, 'None listed.')}
      `).join('')}</div>`;
    },
    gradingBreakdown(section, data) {
      const components = get(data, 'grading.components', []);
      if (!components.length) {
        return `<div class="pdf-section"><h3>${escapeHtml(section.label || 'Grading System')}</h3><p class="t-muted">No grading breakdown entered yet.</p></div>`;
      }
      return `<div class="pdf-section"><h3>${escapeHtml(section.label || 'Grading System')}</h3>${components.map((comp) => {
        const sum = (comp.items || []).reduce((a, it) => a + (Number(it.pct) || 0), 0);
        return `
          <p style="font-weight:600;margin-top:0.5rem;">${escapeHtml(comp.name)} (${comp.weightPct}%)${comp.weightNote ? ` — ${escapeHtml(comp.weightNote)}` : ''}</p>
          <table class="pdf-table">
            <thead><tr><th>Assessment item</th><th>Grade Source</th><th>Percentage</th></tr></thead>
            <tbody>
              ${(comp.items || []).map((it) => `<tr><td>${escapeHtml(it.item)}</td><td>${escapeHtml(it.source)}</td><td>${it.pct}%</td></tr>`).join('')}
              <tr class="pdf-total-row"><td>Total</td><td></td><td>${sum}%</td></tr>
            </tbody>
          </table>
        `;
      }).join('')}</div>`;
    },
    staticAttendanceTable(section, data) {
      const rule = get(data, 'orgProfile.attendanceRule', {});
      const cols = rule.columns || [];
      const rows = rule.rows || [];
      return `
        <div class="pdf-section"><h3>${escapeHtml(section.label || 'Attendance')}</h3>
          <p>${escapeHtml(rule.note || '')}</p>
          <table class="pdf-table">
            <thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      `;
    },
    list(section, data) {
      const items = data[section.source] || [];
      return `<div class="pdf-section"><h3>${escapeHtml(section.label)}</h3>${htmlList(items, false, 'None listed yet.')}</div>`;
    },
    classPolicies(section, data) {
      const cp = get(data, 'orgProfile.classPolicies', {});
      return `
        <div class="pdf-section"><h3>${escapeHtml(section.label || 'Class Policies')}</h3>
          <p style="font-weight:600;">${escapeHtml(cp.attendanceHeading || 'Class Attendance')}</p>
          <p>${escapeHtml(cp.attendanceText || '')}</p>
          <p style="font-weight:600;margin-top:0.75rem;">${escapeHtml(cp.academicDishonestyHeading || 'Academic Dishonesty')}</p>
          <p>${escapeHtml(cp.academicDishonestyIntro || '')}</p>
          <ol class="pdf-list">${(cp.academicDishonestyItems || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
          <p style="font-weight:600;margin-top:0.75rem;">${escapeHtml(cp.submissionHeading || 'Submission of Course Requirements')}</p>
          <p>${escapeHtml(cp.submissionText || '')}</p>
          ${data.classPoliciesOverride ? `<p style="font-weight:600;margin-top:0.75rem;">Additional Notes</p><p>${escapeHtml(data.classPoliciesOverride)}</p>` : ''}
        </div>
      `;
    },
    richtext(section, data) {
      const text = (section.source && data[section.source]) || data.effectivityText || '';
      return `<div class="pdf-section"><h3>${escapeHtml(section.label)}</h3><p>${escapeHtml(text)}</p></div>`;
    },
    signatureBlock(section, data) {
      const sig = data.signatories || {};
      const cells = [];
      (section.roles || []).forEach((role) => {
        const val = sig[role.key];
        if (role.multiple) {
          const list = Array.isArray(val) && val.length ? val : [null];
          list.forEach((entry) => cells.push({ role, entry }));
        } else {
          cells.push({ role, entry: val || null });
        }
      });
      return `
        <div class="pdf-section"><h3>${escapeHtml(section.label || 'Approval')}</h3>
          <div class="pdf-signature-grid">
            ${cells.map(({ role, entry }) => `
              <div class="pdf-signature-cell">
                <div class="sig-role">${escapeHtml(role.label)}</div>
                <div class="sig-name">${escapeHtml(entry && entry.name ? entry.name : '—')}</div>
                <div class="sig-caption">Signature Over Printed Name</div>
                <div class="sig-date">Date: ${escapeHtml(entry && entry.date ? entry.date : '________')}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
  };

  function renderSectionsHtml(template, data) {
    if (!template || !Array.isArray(template.sections)) return '';
    return template.sections.map((section) => {
      const fn = HTML_RENDERERS[section.type];
      if (!fn) return `<div class="pdf-section t-muted">Unsupported section type: ${escapeHtml(section.type)}</div>`;
      try { return fn(section, data); } catch (e) { return `<div class="pdf-section t-muted">Could not render ${escapeHtml(section.label || section.key)}.</div>`; }
    }).join('');
  }

  // ---------------------------------------------------------------------
  // PDF rendering (jsPDF) — draws into a shared vertical-cursor context
  // supplied by the caller (see app-actions.js's buildPortfolioPdf), so
  // pagination and the letterhead/footer stay owned by the caller and only
  // the body sections are generic/template-driven.
  // ---------------------------------------------------------------------

  function pdfHeading(ctx, text) {
    const { doc, margin, pageWidth } = ctx;
    ctx.ensureSpace(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(24, 74, 54);
    doc.text(String(text).toUpperCase(), margin, ctx.y);
    ctx.y += 5;
    doc.setDrawColor(210, 210, 210);
    doc.setLineWidth(0.75);
    doc.line(margin, ctx.y, pageWidth - margin, ctx.y);
    ctx.y += 16;
    doc.setTextColor(30, 30, 30);
  }

  function pdfParagraph(ctx, text) {
    const { doc, margin, contentWidth } = ctx;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(text || '—', contentWidth);
    lines.forEach((line) => {
      ctx.ensureSpace(14);
      doc.text(line, margin, ctx.y);
      ctx.y += 14;
    });
    ctx.y += 8;
  }

  function pdfList(ctx, items, ordered) {
    const { doc, margin, contentWidth } = ctx;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const arr = (items || []).filter(Boolean);
    if (!arr.length) { pdfParagraph(ctx, 'None provided yet.'); return; }
    arr.forEach((item, i) => {
      const prefix = ordered ? `${i + 1}. ` : '• ';
      const lines = doc.splitTextToSize(prefix + item, contentWidth - 14);
      lines.forEach((line) => {
        ctx.ensureSpace(14);
        doc.text(line, margin + 14, ctx.y);
        ctx.y += 14;
      });
    });
    ctx.y += 8;
  }

  function pdfKeyValueGrid(ctx, fields, data) {
    const { doc, margin, contentWidth } = ctx;
    const labelWidth = 160;
    fields.forEach((f) => {
      const value = String(data[f.key] || '—');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const valueLines = doc.splitTextToSize(value, contentWidth - labelWidth);
      ctx.ensureSpace(valueLines.length * 14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(110, 110, 110);
      doc.text(String(f.label).toUpperCase(), margin, ctx.y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(30, 30, 30);
      valueLines.forEach((line, i) => doc.text(line, margin + labelWidth, ctx.y + i * 14));
      ctx.y += valueLines.length * 14 + 4;
    });
    ctx.y += 6;
  }

  // Simple grid table: draws a header row + data rows, wrapping each cell's
  // text and using the tallest cell in a row to advance y. Deliberately
  // simple (no cross-page row splitting) — adequate for Phase 1 foundation.
  function pdfTable(ctx, headers, rows, colWidths) {
    const { doc, margin, contentWidth } = ctx;
    const widths = colWidths || headers.map(() => contentWidth / headers.length);
    const cellPad = 4;

    function drawRow(cells, opts) {
      opts = opts || {};
      doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      doc.setFontSize(opts.fontSize || 8.5);
      const wrapped = cells.map((c, i) => doc.splitTextToSize(String(c == null ? '' : c), widths[i] - cellPad * 2));
      const rowLines = Math.max(1, ...wrapped.map((w) => w.length));
      const rowHeight = rowLines * 11 + cellPad * 2;
      ctx.ensureSpace(rowHeight);
      let x = margin;
      cells.forEach((c, i) => {
        if (opts.shade) {
          doc.setFillColor(240, 240, 240);
          doc.rect(x, ctx.y, widths[i], rowHeight, 'F');
        }
        doc.setDrawColor(200, 200, 200);
        doc.rect(x, ctx.y, widths[i], rowHeight);
        doc.setTextColor(30, 30, 30);
        wrapped[i].forEach((line, li) => doc.text(line, x + cellPad, ctx.y + cellPad + 8 + li * 11));
        x += widths[i];
      });
      ctx.y += rowHeight;
    }

    drawRow(headers, { bold: true, shade: true, fontSize: 8 });
    rows.forEach((r) => {
      if (r.__milestone) {
        ctx.ensureSpace(18);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setFillColor(232, 240, 236);
        doc.rect(margin, ctx.y, contentWidth, 18, 'F');
        doc.setDrawColor(200, 200, 200);
        doc.rect(margin, ctx.y, contentWidth, 18);
        doc.text(String(r.__milestone).toUpperCase(), margin + contentWidth / 2, ctx.y + 12, { align: 'center' });
        ctx.y += 18;
        return;
      }
      drawRow(r);
    });
    ctx.y += 8;
  }

  const PDF_RENDERERS = {
    staticOrgTable(ctx, section, data) {
      const org = data.orgProfile || {};
      pdfHeading(ctx, 'Vision');
      pdfParagraph(ctx, org.vision);
      pdfHeading(ctx, 'Mission');
      pdfParagraph(ctx, org.mission);
      pdfHeading(ctx, 'Core Values');
      if (org.coreValuesIntro) pdfParagraph(ctx, org.coreValuesIntro);
      pdfList(ctx, org.coreValues, false);
      pdfHeading(ctx, 'Graduate Attributes');
      pdfList(ctx, org.graduateAttributes, false);
    },
    programOutcomes(ctx, section, data) {
      const program = data.program || {};
      pdfHeading(ctx, 'Program Educational Objectives');
      if (program.peoIntro) pdfParagraph(ctx, program.peoIntro);
      pdfList(ctx, program.peo, true);
      pdfHeading(ctx, 'Course Intended Learning Outcomes (CILO)');
      pdfList(ctx, data.outcomes, true);
    },
    soMatrix(ctx, section, data) {
      const program = data.program || {};
      const cols = section.columns || ['I/L', 'E/P', 'D/O'];
      pdfHeading(ctx, section.label || 'Student Outcomes Map');
      const headers = ['SO', 'Description'].concat(cols);
      const rows = (data.soMap || []).map((row) => {
        const so = (program.studentOutcomes || []).find((s) => s.code === row.soCode);
        const desc = row.description || (so ? so.description : '');
        return [row.soCode, desc].concat(cols.map((c) => (row.intensity === c ? 'X' : '')));
      });
      const widths = [40, ctx.contentWidth - 40 - cols.length * 36].concat(cols.map(() => 36));
      pdfTable(ctx, headers, rows, widths);
    },
    keyvalueGrid(ctx, section, data) {
      pdfHeading(ctx, section.label || 'Course Information');
      pdfKeyValueGrid(ctx, section.fields || [], data);
    },
    weeklyPlanTable(ctx, section, data) {
      pdfHeading(ctx, section.label || 'Teaching and Learning Plan');
      const cols = section.columns || ['Week', 'Topics', 'ILO', 'TLA', 'Instructional Material', 'Assessment Tasks'];
      const rows = (data.teachingPlan || []).map((row) => {
        if (row.type === 'milestone') return { __milestone: row.label };
        return [row.week, (row.topics || []).join('; '), (row.ilo || []).join('; '), (row.tla || []).join('; '), (row.instructionalMaterials || []).join('; '), (row.assessmentTasks || []).join('; ')];
      });
      const w = ctx.contentWidth;
      const widths = [w * 0.06, w * 0.24, w * 0.20, w * 0.16, w * 0.16, w * 0.18];
      pdfTable(ctx, cols, rows, widths);
    },
    referenceList(ctx, section, data) {
      pdfHeading(ctx, section.label || 'References');
      const groups = section.groups || [{ key: 'textbooks', label: 'Textbooks' }, { key: 'onlineResources', label: 'Online Resources' }];
      const rg = data.referenceGroups || {};
      const hasAny = groups.some((g) => (rg[g.key] || []).length);
      if (!hasAny) { pdfList(ctx, data.references, false); return; }
      groups.forEach((g) => {
        ctx.doc.setFont('helvetica', 'bold');
        ctx.doc.setFontSize(9.5);
        ctx.ensureSpace(14);
        ctx.doc.text(g.label, ctx.margin, ctx.y);
        ctx.y += 14;
        pdfList(ctx, rg[g.key], false);
      });
    },
    gradingBreakdown(ctx, section, data) {
      pdfHeading(ctx, section.label || 'Grading System');
      const components = get(data, 'grading.components', []);
      if (!components.length) { pdfParagraph(ctx, 'No grading breakdown entered yet.'); return; }
      components.forEach((comp) => {
        const sum = (comp.items || []).reduce((a, it) => a + (Number(it.pct) || 0), 0);
        ctx.doc.setFont('helvetica', 'bold');
        ctx.doc.setFontSize(9.5);
        ctx.ensureSpace(14);
        ctx.doc.text(`${comp.name} (${comp.weightPct}%)${comp.weightNote ? ' — ' + comp.weightNote : ''}`, ctx.margin, ctx.y);
        ctx.y += 14;
        const rows = (comp.items || []).map((it) => [it.item, it.source, `${it.pct}%`]);
        rows.push(['Total', '', `${sum}%`]);
        pdfTable(ctx, ['Assessment Item', 'Grade Source', 'Percentage'], rows, [ctx.contentWidth * 0.4, ctx.contentWidth * 0.4, ctx.contentWidth * 0.2]);
      });
    },
    staticAttendanceTable(ctx, section, data) {
      const rule = get(data, 'orgProfile.attendanceRule', {});
      pdfHeading(ctx, section.label || 'Attendance');
      if (rule.note) pdfParagraph(ctx, rule.note);
      pdfTable(ctx, rule.columns || [], rule.rows || []);
    },
    list(ctx, section, data) {
      pdfHeading(ctx, section.label);
      pdfList(ctx, data[section.source] || [], false);
    },
    classPolicies(ctx, section, data) {
      const cp = get(data, 'orgProfile.classPolicies', {});
      pdfHeading(ctx, section.label || 'Class Policies');
      ctx.doc.setFont('helvetica', 'bold'); ctx.doc.setFontSize(9.5);
      ctx.ensureSpace(14); ctx.doc.text(cp.attendanceHeading || 'Class Attendance', ctx.margin, ctx.y); ctx.y += 14;
      pdfParagraph(ctx, cp.attendanceText);
      ctx.doc.setFont('helvetica', 'bold'); ctx.doc.setFontSize(9.5);
      ctx.ensureSpace(14); ctx.doc.text(cp.academicDishonestyHeading || 'Academic Dishonesty', ctx.margin, ctx.y); ctx.y += 14;
      pdfParagraph(ctx, cp.academicDishonestyIntro);
      pdfList(ctx, cp.academicDishonestyItems, true);
      ctx.doc.setFont('helvetica', 'bold'); ctx.doc.setFontSize(9.5);
      ctx.ensureSpace(14); ctx.doc.text(cp.submissionHeading || 'Submission of Course Requirements', ctx.margin, ctx.y); ctx.y += 14;
      pdfParagraph(ctx, cp.submissionText);
      if (data.classPoliciesOverride) pdfParagraph(ctx, data.classPoliciesOverride);
    },
    richtext(ctx, section, data) {
      pdfHeading(ctx, section.label);
      const text = (section.source && data[section.source]) || data.effectivityText || '';
      pdfParagraph(ctx, text);
    },
    signatureBlock(ctx, section, data) {
      pdfHeading(ctx, section.label || 'Approval');
      const sig = data.signatories || {};
      const cells = [];
      (section.roles || []).forEach((role) => {
        const val = sig[role.key];
        if (role.multiple) {
          const list = Array.isArray(val) && val.length ? val : [null];
          list.forEach((entry) => cells.push({ role, entry }));
        } else {
          cells.push({ role, entry: val || null });
        }
      });
      const colWidth = ctx.contentWidth / Math.max(1, cells.length);
      ctx.ensureSpace(60);
      const rowY = ctx.y + 34;
      cells.forEach((c, i) => {
        const x = ctx.margin + i * colWidth;
        ctx.doc.setDrawColor(40, 40, 40);
        ctx.doc.setLineWidth(0.75);
        ctx.doc.line(x + 6, rowY, x + colWidth - 6, rowY);
        ctx.doc.setFont('helvetica', 'bold');
        ctx.doc.setFontSize(8);
        ctx.doc.setTextColor(30, 30, 30);
        const name = c.entry && c.entry.name ? c.entry.name : '—';
        ctx.doc.text(ctx.doc.splitTextToSize(name, colWidth - 12), x + colWidth / 2, rowY - 4, { align: 'center' });
        ctx.doc.setFont('helvetica', 'normal');
        ctx.doc.setFontSize(7);
        ctx.doc.setTextColor(120, 120, 120);
        ctx.doc.text('Signature Over Printed Name', x + colWidth / 2, rowY + 10, { align: 'center' });
        ctx.doc.text(c.role.label, x + colWidth / 2, rowY + 20, { align: 'center' });
        ctx.doc.text(`Date: ${c.entry && c.entry.date ? c.entry.date : '________'}`, x + colWidth / 2, rowY + 30, { align: 'center' });
      });
      ctx.y = rowY + 40;
    }
  };

  function renderSectionsPdf(ctx, template, data) {
    if (!template || !Array.isArray(template.sections)) return;
    template.sections.forEach((section) => {
      const fn = PDF_RENDERERS[section.type];
      if (!fn) return;
      try { fn(ctx, section, data); } catch (e) { /* skip a section that fails to render rather than aborting the whole PDF */ }
    });
  }

  // ---------------------------------------------------------------------
  // Official letterhead (Phase 3): shows the institution's official header
  // lines (Republic/University/Division/address) and the template's form
  // code — only when a template applies, matching the CCS101 DOCX header.
  // Shared by portfolio-new.html and portfolio-preview.html, which both use
  // the same #pdf-official-letterhead / #pdf-form-code element ids.
  // ---------------------------------------------------------------------
  function applyOfficialLetterhead(model) {
    const officialEl = document.getElementById('pdf-official-letterhead');
    const formCodeEl = document.getElementById('pdf-form-code');
    if (!officialEl || !formCodeEl) return;

    const lh = model.template && model.orgProfile ? model.orgProfile.letterhead : null;
    officialEl.innerHTML = '';
    if (lh) {
      [lh.line1, lh.line2, lh.line3, lh.line4, lh.address].filter(Boolean).forEach((line) => {
        const div = document.createElement('div');
        div.textContent = line;
        officialEl.appendChild(div);
      });
      officialEl.style.display = 'block';
    } else {
      officialEl.style.display = 'none';
    }

    if (model.template && model.template.formCode) {
      formCodeEl.textContent = `Form: ${model.template.formCode}`;
      formCodeEl.style.display = 'block';
    } else {
      formCodeEl.style.display = 'none';
    }
  }

  window.__OBTLP_TEMPLATE_RENDERER__ = { resolveTemplate, renderSectionsHtml, renderSectionsPdf, applyOfficialLetterhead };
})();
