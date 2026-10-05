// Central place for lightweight front-end behaviors shared across pages.
// Talks to the real API in db.js (window.__OBTLP_API__).

(function () {
  const api = window.__OBTLP_API__;

  function currentSession() {
    return api ? api.getSession() : null;
  }

  function getToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function notify(title, message) {
    if (!document.body) return;

    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <div class="toast-title"></div>
      <div class="toast-msg"></div>
    `;
    toast.querySelector('.toast-title').textContent = title;
    toast.querySelector('.toast-msg').textContent = message;
    container.appendChild(toast);

    const remove = () => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 200);
    };
    setTimeout(remove, 3200);
    toast.addEventListener('click', remove);
  }

  function notifyError(err) {
    notify('Something went wrong', err && err.message ? err.message : 'Please try again.');
  }

  // Builds "Portfolio_<CourseCode>_<AcademicYear>.pdf", e.g.
  // "Portfolio_IT311_2026-2027.pdf" — used as the downloaded file's name.
  function buildPdfFilename(courseCode, academicYear) {
    const code = String(courseCode || '').replace(/[^a-zA-Z0-9]+/g, '') || 'Course';
    const year = String(academicYear || '').replace(/[^0-9-]+/g, '') || String(new Date().getFullYear());
    return `Portfolio_${code}_${year}.pdf`;
  }

  // Preloads the university seal once (as a data URL) so jsPDF's addImage
  // has synchronous access to it when Download PDF is clicked. Cached after
  // the first successful load; failures just leave the letterhead
  // image-less rather than blocking the download.
  let logoDataUrlPromise = null;
  function loadLogoDataUrl() {
    if (!logoDataUrlPromise) {
      logoDataUrlPromise = fetch('assets/pnc-logo.png')
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('logo fetch failed'))))
        .then((blob) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Could not read logo image.'));
          reader.readAsDataURL(blob);
        }))
        .catch((err) => { console.warn('[Download PDF] logo preload failed', err); return null; });
    }
    return logoDataUrlPromise;
  }
  loadLogoDataUrl();

  // Other images used by some official forms (e.g. the College of
  // Education seal on the COED Course Outline). Same caching idea.
  const imageCache = {};
  function loadImageDataUrl(path) {
    if (!path) return Promise.resolve(null);
    if (!imageCache[path]) {
      imageCache[path] = fetch(path)
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('image fetch failed'))))
        .then((blob) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('Could not read image.'));
          reader.readAsDataURL(blob);
        }))
        .catch((err) => { console.warn('[Download PDF] image preload failed', path, err); return null; });
    }
    return imageCache[path];
  }

  // Draws the portfolio directly with jsPDF's own text/drawing API (no DOM
  // screenshotting). This is deliberate: an earlier html2canvas-based
  // version silently failed, because this app's whole stylesheet is built
  // on oklch()/color-mix() CSS colors that html2canvas's color parser can't
  // read — it threw inside its own internal render pass, outside any catch
  // block this file could reach, so the button did nothing and no error
  // ever surfaced. Building the PDF from the actual data instead of a
  // screenshot sidesteps that entirely, and gives full control over page
  // breaks so text is never cut off.
  function buildPortfolioPdf(jsPDFCtor, data, logoDataUrl) {
    // Courses with an official OBTLP template get the full official PnC
    // form, drawn page-by-page in A4 LANDSCAPE (see templates-render.js).
    if (data.template && window.__OBTLP_TEMPLATE_RENDERER__ && window.__OBTLP_TEMPLATE_RENDERER__.buildOfficialPdf) {
      return window.__OBTLP_TEMPLATE_RENDERER__.buildOfficialPdf(jsPDFCtor, data, logoDataUrl);
    }
    // Untemplated (legacy) portfolios: same simple layout as before, but
    // landscape too, per the adviser's requirement that OBTLPs are landscape.
    const doc = new jsPDFCtor({ unit: 'pt', format: 'a4', orientation: 'landscape' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 48;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    function ensureSpace(h) {
      if (y + h > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    }

    function addHeading(text) {
      ensureSpace(30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(24, 74, 54);
      doc.text(String(text).toUpperCase(), margin, y);
      y += 5;
      doc.setDrawColor(210, 210, 210);
      doc.setLineWidth(0.75);
      doc.line(margin, y, pageWidth - margin, y);
      y += 16;
      doc.setTextColor(30, 30, 30);
    }

    function addParagraph(text) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const lines = doc.splitTextToSize(text || '—', contentWidth);
      lines.forEach((line) => {
        ensureSpace(14);
        doc.text(line, margin, y);
        y += 14;
      });
      y += 8;
    }

    function addList(items, ordered) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      if (!items || !items.length) { addParagraph('None provided yet.'); return; }
      items.forEach((item, i) => {
        const prefix = ordered ? `${i + 1}. ` : '• ';
        const lines = doc.splitTextToSize(prefix + item, contentWidth - 14);
        lines.forEach((line) => {
          ensureSpace(14);
          doc.text(line, margin + 14, y);
          y += 14;
        });
      });
      y += 8;
    }

    function addKeyValueRow(label, value) {
      const labelWidth = 100;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const valueLines = doc.splitTextToSize(value || '—', contentWidth - labelWidth);
      ensureSpace(valueLines.length * 14);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(110, 110, 110);
      doc.text(String(label).toUpperCase(), margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(30, 30, 30);
      valueLines.forEach((line, i) => doc.text(line, margin + labelWidth, y + i * 14));
      y += valueLines.length * 14 + 4;
    }

    // Phase 3: official institution letterhead (Republic/University/
    // Division/address) + the template's form code, matching the CCS101
    // DOCX header — shown only when a template applies, above the existing
    // school-name letterhead which is unchanged for legacy courses.
    const officialLetterhead = data.template && data.orgProfile ? data.orgProfile.letterhead : null;
    if (officialLetterhead) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120, 120, 120);
      [officialLetterhead.line1, officialLetterhead.line2, officialLetterhead.line3, officialLetterhead.line4, officialLetterhead.address]
        .filter(Boolean)
        .forEach((line) => {
          doc.text(line, pageWidth / 2, y, { align: 'center' });
          y += 10;
        });
      y += 6;
    }

    // Letterhead
    const logoSize = 34;
    const textX = logoDataUrl ? margin + logoSize + 10 : margin;
    if (logoDataUrl) {
      try { doc.addImage(logoDataUrl, 'PNG', margin, y - 24, logoSize, logoSize); }
      catch (err) { console.warn('[Download PDF] could not draw logo', err); }
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(24, 74, 54);
    doc.text(data.schoolName || 'Your Institution', textX, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 120);
    doc.text(data.college || 'College / Department', textX, y + 14);
    doc.text(`Document: ${data.docId || ''}`, pageWidth - margin, y, { align: 'right' });
    doc.text(data.status || '', pageWidth - margin, y + 14, { align: 'right' });
    if (data.template && data.template.formCode) {
      doc.setFontSize(7);
      doc.text(`Form: ${data.template.formCode}`, pageWidth - margin, y + 26, { align: 'right' });
      y += 10;
    }
    y += 34;
    doc.setDrawColor(24, 74, 54);
    doc.setLineWidth(1.2);
    doc.line(margin, y, pageWidth - margin, y);
    y += 26;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('OUTCOMES-BASED TEACHING & LEARNING PLAN', margin, y);
    y += 20;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(20, 20, 20);
    doc.splitTextToSize(data.courseTitle || 'Untitled Course', contentWidth).forEach((line) => {
      ensureSpace(24);
      doc.text(line, margin, y);
      y += 22;
    });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(110, 110, 110);
    doc.text(`${data.courseCode || 'UNTITLED'} · ${data.semester || ''} · ${data.academicYear || ''}`, margin, y);
    y += 28;

    // Phase 1: when the course has a resolved OBTLP template (data.template,
    // set by portfolio-new.html/portfolio-preview.html via
    // __OBTLP_TEMPLATE_RENDERER__.resolveTemplate), the body is generated
    // generically from the template's sections[] instead of this fixed
    // layout — this is the "automated template-based generation" path.
    // Courses with no applicable template keep the exact original layout
    // below, so nothing that worked before changes for them.
    if (data.template && window.__OBTLP_TEMPLATE_RENDERER__) {
      const ctx = {
        doc, margin, pageWidth, pageHeight, contentWidth,
        get y() { return y; },
        set y(v) { y = v; },
        ensureSpace
      };
      window.__OBTLP_TEMPLATE_RENDERER__.renderSectionsPdf(ctx, data.template, data);
    } else {
      addHeading('Course Description');
      addParagraph(data.description);

      addHeading('Faculty Information');
      addKeyValueRow('Faculty', data.faculty);
      addKeyValueRow('Department', data.facultyDept);
      addKeyValueRow('Units', data.units);
      addKeyValueRow('Schedule', data.schedule);
      y += 6;

      addHeading('Course Objectives');
      addList(data.objectives, true);

      addHeading('Intended Learning Outcomes');
      addList(data.outcomes, true);

      addHeading('Syllabus Summary');
      addParagraph(data.syllabus);

      addHeading('Teaching Materials & Modules');
      addList(data.teachingMaterials, false);

      addHeading('References');
      addList(data.references, false);

      addHeading('Attached Evidence');
      addList(data.evidence, false);
    }

    const pageCount = doc.internal.getNumberOfPages();
    const footerLeft = (data.template && data.template.formCode) ? data.template.formCode : `Generated ${new Date().toLocaleDateString()}`;
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 160);
      doc.text(footerLeft, margin, pageHeight - 24);
      doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 24, { align: 'right' });
    }

    return doc;
  }

  // Real "Download PDF": builds a real, multi-page .pdf directly from the
  // current portfolio data with jsPDF and triggers a normal browser file
  // download via doc.save(). No window.print(), no print dialog, no DOM
  // screenshot. Each page defines window.__OBTLP_PDF_DATA__() to hand back
  // the current data; this function is otherwise page-agnostic.
  function downloadPdf() {
    console.log('[Download PDF] button clicked');

    if (typeof window.__OBTLP_PDF_DATA__ !== 'function') {
      console.warn('[Download PDF] no __OBTLP_PDF_DATA__ hook on this page');
      notify('Nothing to Download', 'Open a portfolio first.');
      return;
    }
    const data = window.__OBTLP_PDF_DATA__();
    if (!data) {
      console.warn('[Download PDF] __OBTLP_PDF_DATA__ returned nothing');
      notify('Nothing to Download', 'Open a portfolio first.');
      return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
      console.error('[Download PDF] jsPDF failed to load (window.jspdf is missing)');
      notify('PDF Unavailable', 'The PDF library failed to load. Check your connection and try again.');
      return;
    }

    const buttons = Array.from(document.querySelectorAll('[data-action="download-pdf"]'));
    const originalHtml = buttons.map((b) => b.innerHTML);
    buttons.forEach((b) => {
      b.disabled = true;
      b.innerHTML = '<span class="spinner" style="width:0.875rem;height:0.875rem;border-width:2px;"></span> Generating PDF…';
    });
    const restoreButtons = () => buttons.forEach((b, i) => { b.disabled = false; b.innerHTML = originalHtml[i]; });

    const secondaryLogo = data.template && data.template.secondaryLogo;
    Promise.all([loadLogoDataUrl(), loadImageDataUrl(secondaryLogo)]).then(([logoDataUrl, secondaryLogoDataUrl]) => {
      try {
        if (secondaryLogoDataUrl) data.secondaryLogoDataUrl = secondaryLogoDataUrl;
        console.log('[Download PDF] building document from data', data);
        const { jsPDF } = window.jspdf;
        const doc = buildPortfolioPdf(jsPDF, data, logoDataUrl);
        const filename = data.filename || buildPdfFilename(data.courseCode, data.academicYear);
        console.log('[Download PDF] saving as', filename);
        doc.save(filename);
        notify('PDF Downloaded', `${filename} was saved to your downloads.`);
      } catch (err) {
        console.error('[Download PDF] generation failed', err);
        notify('Failed to Generate PDF', (err && err.message) || 'Please try again.');
      } finally {
        restoreButtons();
      }
    });
  }

  async function submitForReview(el) {
    if (!api) return;
    const portfolioId = (el && el.dataset.portfolioId) || null;
    if (!portfolioId) {
      notify('No Portfolio', 'Select a portfolio to submit for review.');
      return;
    }
    const notesEl = document.getElementById('f-notes') || document.querySelector('.textarea');
    const comment = notesEl ? notesEl.value.trim() : '';

    try {
      // Save any edits before (re)submitting so the reviewer sees the latest version.
      if (typeof window.__OBTLP_COLLECT_EDITS__ === 'function') {
        const edits = window.__OBTLP_COLLECT_EDITS__();
        if (edits) await api.updatePortfolio(portfolioId, edits);
      }
      await api.submitForReview(portfolioId, comment);
      notify('Submitted for Review', 'Your portfolio was queued for administrative review.');
      if (typeof window.__OBTLP_AFTER_SUBMIT__ === 'function') window.__OBTLP_AFTER_SUBMIT__();
    } catch (err) {
      if (err.status === 409 || err.status === 400) {
        notify('Could Not Submit', err.message);
      } else {
        notifyError(err);
      }
    }
  }

  async function saveDraft(el) {
    const portfolioId = (el && el.dataset.portfolioId) || null;
    if (!portfolioId) {
      notify('Save Draft', 'Nothing to save yet.');
      return;
    }
    try {
      let edits = {};
      if (typeof window.__OBTLP_COLLECT_EDITS__ === 'function') {
        edits = window.__OBTLP_COLLECT_EDITS__() || {};
      }
      await api.updatePortfolio(portfolioId, edits);
      notify('Draft Saved', 'Your progress has been saved. You can continue editing anytime.');
      if (typeof window.__OBTLP_AFTER_SAVE__ === 'function') window.__OBTLP_AFTER_SAVE__();
    } catch (err) {
      notifyError(err);
    }
  }

  async function runBackup() {
    if (!api) return;
    try {
      const result = await api.runBackup();
      // Save the backup as a .json file on this computer.
      const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename || 'obtlp-backup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const c = (result.backup && result.backup.counts) || {};
      notify('Backup Downloaded', `${result.filename} (${c.users || 0} users, ${c.portfolios || 0} portfolios) was saved to your Downloads. Keep it somewhere private.`);
    } catch (err) {
      notifyError(err);
    }
  }

  // ---------------- Notifications panel ----------------

  let notificationsCache = [];
  let panelOpen = false;

  function timeAgo(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    const days = Math.round(hrs / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  }

  function buildNotificationsPanel(anchorEl) {
    let panel = document.getElementById('notif-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.className = 'card';
    panel.style.cssText = [
      'position:fixed', 'width:320px', 'max-height:70vh', 'overflow:auto',
      'z-index:1000', 'box-shadow:0 10px 30px rgba(0,0,0,.18)', 'display:none'
    ].join(';');
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;border-bottom:1px solid var(--border);">
        <strong style="font-size:0.875rem;">Notifications</strong>
        <button type="button" id="notif-mark-all" class="btn btn-outline btn-sm" style="padding:0.25rem 0.5rem;font-size:0.75rem;">Mark all read</button>
      </div>
      <ul class="log-list" id="notif-list" style="font-size:0.8125rem;"></ul>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#notif-mark-all').addEventListener('click', async () => {
      try {
        await api.markAllRead();
        notificationsCache.forEach((n) => { n.read = true; });
        renderNotificationsList();
        updateBadge();
      } catch (err) {
        notifyError(err);
      }
    });

    document.addEventListener('click', (e) => {
      if (!panelOpen) return;
      if (panel.contains(e.target) || (anchorEl && anchorEl.contains(e.target))) return;
      closePanel();
    });

    return panel;
  }

  function renderNotificationsList() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (!notificationsCache.length) {
      list.innerHTML = '<li style="padding:1rem;color:var(--muted-foreground);">No notifications yet.</li>';
      return;
    }
    list.innerHTML = notificationsCache
      .slice(0, 20)
      .map((n) => `
        <li data-id="${n.id}" style="cursor:pointer;${n.read ? '' : 'background:color-mix(in oklch, var(--primary) 6%, transparent);'}">
          <span class="dot ${n.read ? 'dot-muted' : 'dot-primary'}"></span>
          <div style="flex:1;min-width:0;">
            <p style="font-weight:600;white-space:normal;">${n.title}</p>
            <p style="color:var(--muted-foreground);white-space:normal;">${n.message}</p>
          </div>
          <span class="section-sub" style="white-space:nowrap;">${timeAgo(n.createdAt)}</span>
        </li>
      `)
      .join('');

    list.querySelectorAll('li[data-id]').forEach((li) => {
      li.addEventListener('click', async () => {
        const id = li.dataset.id;
        const n = notificationsCache.find((x) => x.id === id);
        if (n && !n.read) {
          try {
            await api.markNotificationRead(id);
            n.read = true;
            renderNotificationsList();
            updateBadge();
          } catch (err) {
            notifyError(err);
          }
        }
      });
    });
  }

  function updateBadge() {
    const unread = notificationsCache.filter((n) => !n.read).length;
    document.querySelectorAll('[data-action="notifications"]').forEach((el) => {
      let dot = el.querySelector('.notif-dot');
      if (unread > 0) {
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'notif-dot';
          dot.style.cssText = 'display:inline-block;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--destructive);color:#fff;font-size:10px;line-height:16px;text-align:center;margin-left:0.375rem;';
          el.appendChild(dot);
        }
        dot.textContent = unread > 9 ? '9+' : String(unread);
      } else if (dot) {
        dot.remove();
      }
    });
  }

  function closePanel() {
    const panel = document.getElementById('notif-panel');
    if (panel) panel.style.display = 'none';
    panelOpen = false;
  }

  async function toggleNotificationsPanel(anchorEl) {
    const panel = buildNotificationsPanel(anchorEl);
    if (panelOpen) {
      closePanel();
      return;
    }
    const rect = anchorEl.getBoundingClientRect();
    panel.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 400)}px`;
    panel.style.left = `${Math.min(rect.left, window.innerWidth - 336)}px`;
    panel.style.display = 'block';
    panelOpen = true;

    if (!currentSession()) return;
    try {
      const state = await api.getState();
      notificationsCache = state.notifications || [];
      renderNotificationsList();
      updateBadge();
    } catch (err) {
      notifyError(err);
    }
  }

  async function refreshBadgeOnLoad() {
    if (!api || !currentSession()) return;
    try {
      const state = await api.getState();
      notificationsCache = state.notifications || [];
      updateBadge();
    } catch (err) {
      // Non-fatal: badge just won't show if the server isn't reachable yet.
    }
  }

  // The sidebar (nav + Dark Mode + Sign out) is off-canvas on small screens;
  // this injects the hamburger toggle + backdrop once per page and wires
  // them up, so nothing on mobile requires editing every page's HTML.
  function initMobileNav() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.querySelector('.mobile-nav-toggle')) return;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mobile-nav-toggle';
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.innerHTML = '<i data-lucide="menu" class="svg-icon"></i>';

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';

    document.body.appendChild(toggle);
    document.body.appendChild(backdrop);

    const open = () => { sidebar.classList.add('mobile-open'); backdrop.classList.add('mobile-open'); };
    const close = () => { sidebar.classList.remove('mobile-open'); backdrop.classList.remove('mobile-open'); };

    toggle.addEventListener('click', open);
    backdrop.addEventListener('click', close);
    sidebar.querySelectorAll('a, [data-action]').forEach((el) => el.addEventListener('click', close));

    if (window.lucide) lucide.createIcons();
  }

  function ensureHandlers() {
    initMobileNav();
    // Notifications
    document.querySelectorAll('[data-action="notifications"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        toggleNotificationsPanel(el);
      });
    });
    refreshBadgeOnLoad();

    // Download / print buttons
    document.querySelectorAll('[data-action="download-pdf"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        downloadPdf();
      });
    });

    document.querySelectorAll('[data-action="submit-for-review"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        submitForReview(el);
      });
    });

    // Save draft
    document.querySelectorAll('[data-action="save-draft"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        saveDraft(el);
      });
    });

    // IT Admin: run backup
    document.querySelectorAll('[data-action="run-backup"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        runBackup();
      });
    });

    // Sign out everywhere, invalidating the session on the server too.
    document.querySelectorAll('[data-action="sign-out"]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await api.logout(); } catch (err) { /* ignore */ }
        api.clearSession();
        window.location.href = 'index.html';
      });
    });
  }

  // Expose small shared helpers other inline page scripts can reuse.
  window.__OBTLP_UI__ = { notify, notifyError, buildPdfFilename, downloadPdf };

  // Accounts with a password older than the strong-password rule see a
  // reminder on every page until they change it (Profile → Change Password).
  function showWeakPasswordBanner() {
    const s = currentSession();
    const main = document.querySelector('main.main');
    if (!s || !s.passwordWeak || !main || /profile\.html$/.test(location.pathname)) return;
    if (main.querySelector('.weak-pw-banner')) return;
    const div = document.createElement('div');
    div.className = 'dept-notice weak-pw-banner';
    div.setAttribute('role', 'alert');
    div.innerHTML = '<strong>Please update your password.</strong> Passwords now need at least 8 characters with an uppercase letter, a lowercase letter, a number, and a special character. <a href="profile.html?weak=1">Change it now</a>';
    main.insertBefore(div, main.firstChild);
  }

  document.addEventListener('DOMContentLoaded', ensureHandlers);
  document.addEventListener('DOMContentLoaded', showWeakPasswordBanner);
})();
