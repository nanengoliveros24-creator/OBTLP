// Small, dependency-free "real dropdown/select" component: a button-style
// trigger (matching the look of the native Semester <select>) that opens a
// panel containing a search box and a scrollable, clickable option list.
// The primary interaction is CLICK -> SCROLL -> SELECT; typing to search is
// optional and happens inside the panel, never in the trigger itself. Used
// by the portfolio wizard for Course / Department / Academic Year.

(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function closeAllPanels(except) {
    document.querySelectorAll('.select-dd-panel.open').forEach((p) => {
      if (p !== except) {
        p.classList.remove('open');
        const trigger = p.parentElement && p.parentElement.querySelector('.select-dd-trigger');
        if (trigger) trigger.classList.remove('open');
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.select-dd')) closeAllPanels(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllPanels(null);
  });

  // opts:
  //   placeholder        -> text shown in the trigger when nothing is selected
  //   searchPlaceholder  -> placeholder for the panel's internal search box
  //   getItems(query)    -> [{ label, data }]
  //   isSelected(item)   -> bool, marks the current selection in the list
  //   onSelect(item)
  //   createText(query)  -> label for the "create new" row, or '' / falsy to hide it
  //   onCreate(query)
  //   emptyText
  function attachSelectDropdown(triggerEl, opts) {
    if (!triggerEl || triggerEl.__selectDdAttached) return null;
    triggerEl.__selectDdAttached = true;

    triggerEl.classList.add('select-dd-trigger');
    triggerEl.setAttribute('type', 'button');

    const wrapper = document.createElement('div');
    wrapper.className = 'select-dd';
    triggerEl.parentNode.insertBefore(wrapper, triggerEl);
    wrapper.appendChild(triggerEl);

    const valueEl = document.createElement('span');
    valueEl.className = 'select-dd-value is-placeholder';
    valueEl.textContent = opts.placeholder || 'Select…';
    triggerEl.appendChild(valueEl);

    const chevron = document.createElement('i');
    chevron.setAttribute('data-lucide', 'chevron-down');
    chevron.className = 'svg-icon select-dd-chevron';
    triggerEl.appendChild(chevron);

    const panel = document.createElement('div');
    panel.className = 'select-dd-panel';
    wrapper.appendChild(panel);

    let currentItems = [];
    let searchValue = '';

    function renderList() {
      const listWrap = panel.querySelector('.select-dd-list');
      currentItems = opts.getItems(searchValue) || [];
      let html = '';
      if (currentItems.length) {
        html += currentItems.map((it, i) => {
          const selected = !!(opts.isSelected && opts.isSelected(it));
          return `
            <div class="select-dd-item${selected ? ' selected' : ''}" data-idx="${i}">
              <span>${escapeHtml(it.label)}</span>
              ${selected ? '<i data-lucide="check" class="svg-icon"></i>' : ''}
            </div>
          `;
        }).join('');
      } else if (!opts.createText || !opts.createText(searchValue)) {
        html += `<div class="select-dd-empty">${escapeHtml(opts.emptyText || 'No matches found.')}</div>`;
      }
      const createLabel = opts.createText ? opts.createText(searchValue) : '';
      if (createLabel) {
        html += `<div class="select-dd-item select-dd-create" data-create="1"><i data-lucide="plus" class="svg-icon"></i><span>${escapeHtml(createLabel)}</span></div>`;
      }
      listWrap.innerHTML = html;
      if (window.lucide) lucide.createIcons();

      listWrap.querySelectorAll('.select-dd-item[data-idx]').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const item = currentItems[Number(el.dataset.idx)];
          if (item && opts.onSelect) opts.onSelect(item);
          close();
        });
      });
      const createEl = listWrap.querySelector('[data-create]');
      if (createEl) {
        createEl.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (opts.onCreate) opts.onCreate(searchValue);
          close();
        });
      }
    }

    function renderPanel() {
      panel.innerHTML = `
        <div class="select-dd-search-row">
          <i data-lucide="search" class="svg-icon"></i>
          <input type="text" class="select-dd-search" placeholder="${escapeHtml(opts.searchPlaceholder || 'Search…')}" />
        </div>
        <div class="select-dd-list"></div>
      `;
      if (window.lucide) lucide.createIcons();
      const searchInput = panel.querySelector('.select-dd-search');
      searchInput.addEventListener('input', () => {
        searchValue = searchInput.value;
        renderList();
      });
      searchInput.addEventListener('mousedown', (e) => e.stopPropagation());
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { close(); triggerEl.focus(); }
      });
      renderList();
      setTimeout(() => searchInput.focus(), 0);
    }

    function open() {
      if (triggerEl.disabled) return;
      closeAllPanels(panel);
      searchValue = '';
      renderPanel();
      panel.classList.add('open');
      triggerEl.classList.add('open');
    }
    function close() {
      panel.classList.remove('open');
      triggerEl.classList.remove('open');
    }
    function toggle() {
      if (panel.classList.contains('open')) close();
      else open();
    }

    triggerEl.addEventListener('click', (e) => {
      e.preventDefault();
      toggle();
    });

    return {
      open,
      close,
      setValue: (text) => {
        valueEl.textContent = text || (opts.placeholder || 'Select…');
        valueEl.classList.toggle('is-placeholder', !text);
      },
      refresh: () => { if (panel.classList.contains('open')) renderList(); }
    };
  }

  window.__OBTLP_SELECT_DD__ = { attach: attachSelectDropdown };
})();
